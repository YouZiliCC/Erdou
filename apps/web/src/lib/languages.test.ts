import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { BrowserRuntime } from "@erdou/runtime-browser";
import type { ExecContext, Executor } from "@erdou/runtime-contract";
import type { PipPyodide } from "@erdou/lang-python";
import { registerLanguages } from "./languages.js";

function fakeRuntime(): { runtime: BrowserRuntime; programs: Map<string, Executor> } {
  const programs = new Map<string, Executor>();
  const runtime = {
    registerProgram: (name: string, executor: Executor) => void programs.set(name, executor),
  };
  return { runtime: runtime as unknown as BrowserRuntime, programs };
}

// Minimal fake satisfying the full Pyodide surface the runners touch.
function fakePyodide(): PipPyodide {
  const globals = new Map<string, unknown>();
  const loadedPackages: Record<string, string> = {};
  return {
    runPythonAsync: async () => undefined,
    setStdout: () => {},
    setStderr: () => {},
    globals: { set: (n: string, v: unknown) => void globals.set(n, v), get: (n: string) => globals.get(n) },
    FS: {
      readdir: () => [],
      stat: () => ({ mode: 0 }),
      isDir: () => false,
      isFile: () => false,
      readFile: () => new Uint8Array(),
      writeFile: () => {},
      mkdir: () => {},
      analyzePath: () => ({ exists: true }),
    },
    loadedPackages,
    loadPackage: async (names) => {
      for (const n of Array.isArray(names) ? names : [names]) loadedPackages[n] = "default channel";
    },
    pyimport: () => ({ install: async () => {}, destroy: () => {} }),
  };
}

function exec(program: Executor, argv: string[]): Promise<number> {
  const stdin = new PipeStream();
  stdin.end();
  const ctx: ExecContext = {
    pid: 1,
    argv,
    env: {},
    cwd: "/",
    stdin,
    stdout: new PipeStream(),
    stderr: new PipeStream(),
    fs: new Vfs({ clock: () => 0 }),
    serve: () => {},
  };
  return program(ctx);
}

describe("registerLanguages", () => {
  it("registers python/python3 and pip/pip3, each pair sharing one executor", () => {
    const { runtime, programs } = fakeRuntime();
    registerLanguages(runtime, { loadPyodide: async () => fakePyodide() });
    expect([...programs.keys()]).toEqual(expect.arrayContaining(["python", "python3", "pip", "pip3", "wasi", "git"]));
    expect(programs.get("python3")).toBe(programs.get("python"));
    expect(programs.get("pip3")).toBe(programs.get("pip"));
    expect(programs.get("pip")).not.toBe(programs.get("python"));
  });

  it("python and pip share ONE factory — a single Pyodide load serves both", async () => {
    const { runtime, programs } = fakeRuntime();
    let loads = 0;
    registerLanguages(runtime, {
      loadPyodide: async () => {
        loads += 1;
        return fakePyodide();
      },
    });
    expect(await exec(programs.get("python")!, ["python", "-c", "print(1)"])).toBe(0);
    expect(await exec(programs.get("pip")!, ["pip", "install", "numpy"])).toBe(0);
    expect(loads).toBe(1);
  });
});
