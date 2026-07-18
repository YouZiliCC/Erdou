import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext } from "@erdou/runtime-contract";
import { createWasiRunner } from "./runner.js";
import { WasiHost, type WasiOptions } from "./wasi.js";
import { moduleProcExit, moduleFdWrite, moduleFdReaddir } from "./wasm-builder.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeCtx(argv: string[], fs: Vfs): { ctx: ExecContext; stdout: PipeStream; stderr: PipeStream } {
  const stdin = new PipeStream();
  stdin.end();
  const stdout = new PipeStream();
  const stderr = new PipeStream();
  return {
    ctx: { pid: 1, argv, env: {}, cwd: "/", stdin, stdout, stderr, fs, serve: () => {} },
    stdout,
    stderr,
  };
}

function hostWith(overrides: Partial<WasiOptions> = {}, fs?: Vfs) {
  const mem = new WebAssembly.Memory({ initial: 1 });
  const host = new WasiHost({
    args: ["prog"],
    env: {},
    fs: fs ?? new Vfs({ clock: () => 0 }),
    cwd: "/",
    stdin: new Uint8Array(),
    writeStdout: () => {},
    writeStderr: () => {},
    ...overrides,
  });
  host.bind(mem);
  const imp = host.imports as Record<string, (...a: number[]) => number>;
  const view = new DataView(mem.buffer);
  const u8 = new Uint8Array(mem.buffer);
  return { host, imp, view, u8 };
}

describe("WASI end-to-end (real wasm modules)", () => {
  it("runs a module that calls proc_exit(42) and returns 42", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/exit.wasm", moduleProcExit(42));
    const { ctx } = makeCtx(["wasi", "/exit.wasm"], fs);
    expect(await createWasiRunner()(ctx)).toBe(42);
  });

  it("runs a module that writes to stdout via fd_write", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/hello.wasm", moduleFdWrite("hi\n"));
    const { ctx, stdout } = makeCtx(["wasi", "/hello.wasm"], fs);
    const code = await createWasiRunner()(ctx);
    stdout.end();
    expect(code).toBe(0);
    expect(await stdout.text()).toBe("hi\n");
  });

  it("reports a clear error for a non-wasm file", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/bad.wasm", "not wasm");
    const { ctx, stderr } = makeCtx(["wasi", "/bad.wasm"], fs);
    const code = await createWasiRunner()(ctx);
    stderr.end();
    expect(code).toBe(1);
    expect(await stderr.text()).toMatch(/failed to load module/);
  });
});

async function streamBytes(s: PipeStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of s.read()) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

interface Dirent {
  next: bigint;
  ino: bigint;
  type: number;
  name: string;
}

/**
 * Decode a preview1 dirent stream: 24-byte header (d_next u64 | d_ino u64 |
 * d_namlen u32 | d_type u8 + pad) then the raw name. Only complete records are
 * returned — a record cut off by the buffer edge (truncated header or name) is
 * dropped, mirroring how a real caller resumes from the last complete d_next.
 */
function parseDirents(bytes: Uint8Array): Dirent[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Dirent[] = [];
  let off = 0;
  while (off + 24 <= bytes.length) {
    const namlen = v.getUint32(off + 16, true);
    if (off + 24 + namlen > bytes.length) break;
    out.push({
      next: v.getBigUint64(off, true),
      ino: v.getBigUint64(off + 8, true),
      type: v.getUint8(off + 20),
      name: dec.decode(bytes.subarray(off + 24, off + 24 + namlen)),
    });
    off += 24 + namlen;
  }
  return out;
}

/** VFS whose "/" lists (sorted): a.txt (file), ls.wasm (file), sub (dir). */
function readdirFixture(wasm: Uint8Array): Vfs {
  const fs = new Vfs({ clock: () => 0 });
  fs.writeFile("/a.txt", "A");
  fs.mkdir("/sub");
  fs.writeFile("/ls.wasm", wasm);
  return fs;
}

const DIR = 3; // FT.DIRECTORY
const REG = 4; // FT.REGULAR

describe("fd_readdir (real wasm modules)", () => {
  it("lists a directory fully in one call, with . and .. first", async () => {
    const fs = readdirFixture(moduleFdReaddir(3, 512, 0));
    const { ctx, stdout } = makeCtx(["wasi", "/ls.wasm"], fs);
    const code = await createWasiRunner()(ctx);
    stdout.end();
    expect(code).toBe(0);
    const bytes = await streamBytes(stdout);
    // 5 records: 24-byte headers + name lengths (1+2+5+7+3) = 138 bytes.
    expect(bytes.length).toBe(138);
    const entries = parseDirents(bytes);
    expect(entries.map((e) => e.name)).toEqual([".", "..", "a.txt", "ls.wasm", "sub"]);
    expect(entries.map((e) => e.type)).toEqual([DIR, DIR, REG, REG, DIR]);
    expect(entries.map((e) => e.next)).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  it("truncates into a small buffer and resumes from the returned cookie", async () => {
    // 60 bytes holds "." (25) and ".." (26) complete, then 9 bytes of the
    // truncated third record — the spec's "fill the buffer exactly" signal
    // that the listing continues.
    const fs = readdirFixture(moduleFdReaddir(3, 60, 0));
    const first = makeCtx(["wasi", "/ls.wasm"], fs);
    expect(await createWasiRunner()(first.ctx)).toBe(0);
    first.stdout.end();
    const bytes = await streamBytes(first.stdout);
    expect(bytes.length).toBe(60); // buffer filled ⇒ more entries remain
    const head = parseDirents(bytes);
    expect(head.map((e) => e.name)).toEqual([".", ".."]);
    const cookie = Number(head[head.length - 1]!.next);
    expect(cookie).toBe(2);

    // Second pass: same tree, resume from the last complete entry's d_next.
    fs.writeFile("/ls.wasm", moduleFdReaddir(3, 512, cookie));
    const second = makeCtx(["wasi", "/ls.wasm"], fs);
    expect(await createWasiRunner()(second.ctx)).toBe(0);
    second.stdout.end();
    const rest = parseDirents(await streamBytes(second.stdout));
    expect(rest.map((e) => e.name)).toEqual(["a.txt", "ls.wasm", "sub"]);
    expect(rest.map((e) => e.next)).toEqual([3n, 4n, 5n]);
  });

  it("returns NOTDIR (54) for a non-directory fd", async () => {
    const fs = readdirFixture(moduleFdReaddir(0, 128, 0)); // fd 0 = stdin
    const { ctx } = makeCtx(["wasi", "/ls.wasm"], fs);
    expect(await createWasiRunner()(ctx)).toBe(54);
  });
});

describe("WASI syscalls (direct)", () => {
  it("exposes args and environ", () => {
    const { imp, view, u8 } = hostWith({ args: ["prog", "hello"], env: { A: "1" } });
    imp.args_sizes_get!(0, 4);
    expect(view.getUint32(0, true)).toBe(2);
    imp.args_get!(8, 100);
    const p0 = view.getUint32(8, true);
    expect(dec.decode(u8.subarray(p0, p0 + 4))).toBe("prog");
    imp.environ_sizes_get!(0, 4);
    expect(view.getUint32(0, true)).toBe(1);
  });

  it("fd_write goes to stdout", () => {
    let out = "";
    const { imp, view, u8 } = hostWith({ writeStdout: (b) => (out += dec.decode(b)) });
    u8.set(enc.encode("hi"), 100);
    view.setUint32(0, 100, true);
    view.setUint32(4, 2, true);
    expect(imp.fd_write!(1, 0, 1, 200)).toBe(0);
    expect(out).toBe("hi");
    expect(view.getUint32(200, true)).toBe(2);
  });

  it("fd_read serves stdin", () => {
    const { imp, view, u8 } = hostWith({ stdin: enc.encode("input") });
    view.setUint32(0, 100, true);
    view.setUint32(4, 10, true);
    imp.fd_read!(0, 0, 1, 200);
    expect(view.getUint32(200, true)).toBe(5);
    expect(dec.decode(u8.subarray(100, 105))).toBe("input");
  });

  it("path_open creates a file, fd_write fills it, fd_close flushes to the VFS", () => {
    const fs = new Vfs({ clock: () => 0 });
    const { imp, view, u8 } = hostWith({}, fs);
    u8.set(enc.encode("out.txt"), 300);
    // path_open(dirfd=3, dirflags=0, path@300 len=7, oflags=CREAT(1), rights.., fdflags=0, fd@8)
    expect(imp.path_open!(3, 0, 300, 7, 1, 0, 0, 0, 8)).toBe(0);
    const fd = view.getUint32(8, true);
    expect(fd).toBeGreaterThanOrEqual(4);
    u8.set(enc.encode("data"), 400);
    view.setUint32(0, 400, true);
    view.setUint32(4, 4, true);
    imp.fd_write!(fd, 0, 1, 200);
    imp.fd_close!(fd);
    expect(fs.readFileText("/out.txt")).toBe("data");
  });

  it("random_get fills the buffer and clock_time_get writes a time", () => {
    const { imp, view, u8 } = hostWith({ random: (b) => b.fill(7), now: () => 1000 });
    imp.random_get!(500, 4);
    expect([...u8.subarray(500, 504)]).toEqual([7, 7, 7, 7]);
    imp.clock_time_get!(0, 0, 600);
    expect(view.getBigUint64(600, true)).toBe(1_000_000_000n); // 1000ms in ns
  });

  it("proc_exit throws WasiExit with the code", () => {
    const { imp } = hostWith();
    expect(() => imp.proc_exit!(3)).toThrowError(/wasi exit 3/);
  });

  it("fd_readdir rejects file fds with NOTDIR and unknown fds with BADF", () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/f.txt", "x");
    const { imp, view, u8 } = hostWith({}, fs);
    u8.set(enc.encode("f.txt"), 300);
    expect(imp.path_open!(3, 0, 300, 5, 0, 0, 0, 0, 8)).toBe(0);
    const fileFd = view.getUint32(8, true);
    expect(imp.fd_readdir!(fileFd, 64, 128, 0, 16)).toBe(54); // NOTDIR
    expect(imp.fd_readdir!(99, 64, 128, 0, 16)).toBe(8); // BADF
  });

  it("fd_readdir with a cookie past the end reports 0 bytes used (end of directory)", () => {
    const { imp, view } = hostWith(); // "/" is empty ⇒ only "." and ".." (cookies 1, 2)
    expect(imp.fd_readdir!(3, 64, 128, 2, 16)).toBe(0);
    expect(view.getUint32(16, true)).toBe(0);
  });
});
