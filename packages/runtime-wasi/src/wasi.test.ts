import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext } from "@erdou/runtime-contract";
import { createWasiRunner } from "./runner.js";
import { WasiHost, type WasiOptions } from "./wasi.js";
import { moduleProcExit, moduleFdWrite } from "./wasm-builder.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeCtx(argv: string[], fs: Vfs): { ctx: ExecContext; stdout: PipeStream; stderr: PipeStream } {
  const stdin = new PipeStream();
  stdin.end();
  const stdout = new PipeStream();
  const stderr = new PipeStream();
  return { ctx: { pid: 1, argv, env: {}, cwd: "/", stdin, stdout, stderr, fs }, stdout, stderr };
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
});
