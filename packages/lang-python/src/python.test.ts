import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext } from "@erdou/runtime-contract";
import { createPythonRunner } from "./python.js";
import type { Pyodide, EmscriptenFS } from "./pyodide.js";

// A minimal in-memory Emscripten-like FS for the mock.
class MockFS implements EmscriptenFS {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/"]);
  readdir(path: string): string[] {
    const prefix = path === "/" ? "/" : path + "/";
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p === path || !p.startsWith(prefix)) continue;
      const name = p.slice(prefix.length).split("/")[0];
      if (name) names.add(name);
    }
    return [".", "..", ...names];
  }
  stat(path: string) {
    return { mode: this.dirs.has(path) ? 0o040000 : 0o100000 };
  }
  isDir(mode: number) {
    return (mode & 0o170000) === 0o040000;
  }
  isFile(mode: number) {
    return (mode & 0o170000) === 0o100000;
  }
  readFile(path: string): Uint8Array {
    const d = this.files.get(path);
    if (!d) throw new Error("ENOENT " + path);
    return d;
  }
  writeFile(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }
  mkdir(path: string): void {
    this.dirs.add(path);
  }
  analyzePath(path: string) {
    return { exists: this.dirs.has(path) || this.files.has(path) };
  }
}

interface SimArgs {
  code: string;
  argv: string[];
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  fs: MockFS;
}

class MockPyodide implements Pyodide {
  globals = new Map<string, unknown>();
  FS = new MockFS();
  private out: (t: string) => void = () => {};
  private err: (t: string) => void = () => {};
  constructor(private sim: (a: SimArgs) => number) {}
  setStdout(o: { batched: (t: string) => void }) {
    this.out = o.batched;
  }
  setStderr(o: { batched: (t: string) => void }) {
    this.err = o.batched;
  }
  async runPythonAsync(): Promise<unknown> {
    const exit = this.sim({
      code: String(this.globals.get("__erdou_code")),
      argv: this.globals.get("__erdou_argv") as string[],
      cwd: String(this.globals.get("__erdou_cwd")),
      out: this.out,
      err: this.err,
      fs: this.FS,
    });
    this.globals.set("__erdou_exit", exit);
    return undefined;
  }
}

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

describe("python runner (plumbing, mock Pyodide)", () => {
  it("reads a script from the fs, captures stdout, sets argv, returns exit code", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/hello.py", 'print("hi")');
    let seen: SimArgs | undefined;
    const run = createPythonRunner({
      load: async () =>
        new MockPyodide((a) => {
          seen = a;
          a.out("hi\n");
          return 0;
        }),
    });
    const { ctx, stdout } = makeCtx(["python", "/hello.py", "world"], fs);
    const code = await run(ctx);
    stdout.end();

    expect(code).toBe(0);
    expect(await stdout.text()).toBe("hi\n");
    expect(seen?.code).toBe('print("hi")');
    expect(seen?.argv).toEqual(["/hello.py", "world"]);
  });

  it("supports python -c and propagates a non-zero exit code", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const run = createPythonRunner({
      load: async () => new MockPyodide((a) => (a.code.includes("sys.exit(3)") ? 3 : 0)),
    });
    const { ctx } = makeCtx(["python", "-c", "import sys; sys.exit(3)"], fs);
    expect(await run(ctx)).toBe(3);
  });

  it("syncs files Python writes back into the Erdou filesystem", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/app");
    const run = createPythonRunner({
      load: async () =>
        new MockPyodide((a) => {
          a.fs.mkdir("/app");
          a.fs.writeFile("/app/out.txt", new TextEncoder().encode("generated"));
          return 0;
        }),
    });
    const { ctx } = makeCtx(["python", "-c", "open('/app/out.txt','w').write('generated')"], fs);
    await run(ctx);
    expect(fs.readFileText("/app/out.txt")).toBe("generated");
  });

  it("returns 2 with a clear error when the script is missing", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const run = createPythonRunner({ load: async () => new MockPyodide(() => 0) });
    const { ctx, stderr } = makeCtx(["python", "/nope.py"], fs);
    const code = await run(ctx);
    stderr.end();
    expect(code).toBe(2);
    expect(await stderr.text()).toMatch(/can't open file/);
  });
});
