import type { Executor, FileSystemApi } from "@erdou/runtime-contract";
import type { Pyodide, PyodideLoader, EmscriptenFS } from "./pyodide.js";
import { ERDOU_SETUP, createServeBinding } from "./erdou-module.js";

const decoder = new TextDecoder();

// Top-level dirs Pyodide owns — never sync Erdou files over them.
const RESERVED = new Set(["lib", "proc", "dev", "home", "tmp", "usr", "bin", "sbin", "etc", "opt", "sys"]);

function absPath(cwd: string, p: string): string {
  if (p.startsWith("/")) return p;
  return cwd === "/" ? "/" + p : `${cwd}/${p}`;
}

// Runs the user's code in a fresh namespace, capturing sys.exit() and exceptions.
const RUNNER = `
import sys, os
sys.argv = list(__erdou_argv)
try:
    os.chdir(__erdou_cwd)
except Exception:
    pass
__erdou_exit = 0
try:
    exec(compile(__erdou_code, __erdou_file, "exec"), {"__name__": "__main__", "__file__": __erdou_file})
except SystemExit as __e:
    __erdou_exit = __e.code if isinstance(__e.code, int) else (0 if __e.code is None else 1)
except BaseException:
    import traceback
    traceback.print_exc()
    __erdou_exit = 1
`;

export interface PythonRuntimeOptions {
  load: PyodideLoader;
}

/**
 * A `python` / `python3` executor backed by Pyodide (CPython in WASM). It syncs
 * the Erdou filesystem into Pyodide before running and back afterward, wires
 * stdout/stderr, sets sys.argv/cwd, and reports the script's exit code.
 * Pyodide is lazily loaded on first use.
 */
export function createPythonRunner(opts: PythonRuntimeOptions): Executor {
  let instance: Promise<Pyodide> | undefined;
  const getPyodide = (): Promise<Pyodide> => (instance ??= opts.load());

  return async (ctx) => {
    const args = ctx.argv.slice(1);
    let code: string;
    let scriptArgv: string[];

    if (args[0] === "-c") {
      code = args[1] ?? "";
      scriptArgv = ["-c", ...args.slice(2)];
    } else if (args[0] !== undefined) {
      const path = absPath(ctx.cwd, args[0]);
      try {
        code = decoder.decode(ctx.fs.readFile(path));
      } catch (err) {
        ctx.stderr.write(`python: can't open file '${args[0]}': ${message(err)}\n`);
        return 2;
      }
      scriptArgv = [path, ...args.slice(1)];
    } else {
      ctx.stderr.write("python: usage: python <file.py> | python -c <code>\n");
      return 2;
    }

    let py: Pyodide;
    try {
      py = await getPyodide();
    } catch (err) {
      ctx.stderr.write(`python: failed to load the Python runtime: ${message(err)}\n`);
      return 1;
    }

    syncInto(ctx.fs, py.FS);
    py.setStdout({ batched: (t) => ctx.stdout.write(t) });
    py.setStderr({ batched: (t) => ctx.stderr.write(t) });
    py.globals.set("__erdou_code", code);
    py.globals.set("__erdou_file", scriptArgv[0]);
    py.globals.set("__erdou_argv", scriptArgv);
    py.globals.set("__erdou_cwd", ctx.cwd);
    // Bind `__erdou_serve` fresh each run so `erdou.serve(app, port)` registers
    // on THIS execution's `ctx.serve`. The setup Python (installing the `erdou`
    // module + WSGI helper) is prepended to the runner so it executes before the
    // user's `import erdou`, in Pyodide's persistent globals namespace.
    py.globals.set("__erdou_serve", createServeBinding(py, ctx));

    let exitCode = 0;
    try {
      await py.runPythonAsync(ERDOU_SETUP + "\n" + RUNNER);
      exitCode = Number(py.globals.get("__erdou_exit")) || 0;
    } catch (err) {
      ctx.stderr.write(message(err) + "\n");
      exitCode = 1;
    }
    syncBack(py.FS, ctx.fs);
    return exitCode;
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function ensureDir(pfs: EmscriptenFS, dir: string): void {
  let cur = "";
  for (const part of dir.split("/").filter(Boolean)) {
    cur += "/" + part;
    if (!pfs.analyzePath(cur).exists) pfs.mkdir(cur);
  }
}

/** Mirror the Erdou filesystem into Pyodide's FS at the same paths. */
function syncInto(fs: FileSystemApi, pfs: EmscriptenFS): void {
  const walk = (path: string): void => {
    const st = fs.stat(path);
    if (st.type === "directory") {
      ensureDir(pfs, path);
      for (const e of fs.readdir(path)) walk(path === "/" ? `/${e.name}` : `${path}/${e.name}`);
    } else if (st.type === "file") {
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      if (dir !== "/") ensureDir(pfs, dir);
      pfs.writeFile(path, fs.readFile(path));
    }
  };
  for (const e of fs.readdir("/")) {
    if (!RESERVED.has(e.name)) walk(`/${e.name}`);
  }
}

/** Mirror files Python created/changed back into the Erdou filesystem. */
function syncBack(pfs: EmscriptenFS, fs: FileSystemApi): void {
  const walk = (path: string): void => {
    const st = pfs.stat(path);
    if (pfs.isDir(st.mode)) {
      if (!fs.exists(path)) fs.mkdir(path, { recursive: true });
      for (const name of pfs.readdir(path)) {
        if (name === "." || name === "..") continue;
        walk(path === "/" ? `/${name}` : `${path}/${name}`);
      }
    } else if (pfs.isFile(st.mode)) {
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      if (dir !== "/" && !fs.exists(dir)) fs.mkdir(dir, { recursive: true });
      fs.writeFile(path, pfs.readFile(path, { encoding: "binary" }));
    }
  };
  for (const name of pfs.readdir("/")) {
    if (name === "." || name === ".." || RESERVED.has(name)) continue;
    walk(`/${name}`);
  }
}
