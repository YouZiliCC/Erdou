import type { Executor, FileSystemApi } from "@erdou/runtime-contract";
import type { Pyodide, EmscriptenFS } from "./pyodide.js";
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

/**
 * Package-management surface of a real Pyodide instance. Typed here rather
 * than widening the minimal `Pyodide` contract in pyodide.ts — only the pip
 * executor needs it. A real Pyodide instance satisfies this shape.
 */
export interface PyodidePackages {
  /** Resolves even on failure (unknown name, network down) — `loadedPackages` is the truth afterward. */
  loadPackage(
    names: string | string[],
    options?: { messageCallback?: (message: string) => void; errorCallback?: (message: string) => void },
  ): Promise<unknown>;
  /** Loaded package name → installation source (e.g. "default channel"). */
  loadedPackages: Record<string, string>;
  pyimport(name: string): unknown;
}

export type PipPyodide = Pyodide & PyodidePackages;

export interface PythonRuntimeOptions {
  load: () => Promise<PipPyodide>;
}

export interface PythonRunners {
  python: Executor;
  pip: Executor;
}

/**
 * `python`/`python3` and `pip`/`pip3` executors over ONE lazily-loaded, cached
 * Pyodide instance — pip installs must land in the interpreter python runs in.
 * Executions are serialized on a promise-chain tail because stdout/stderr and
 * `globals` are instance-wide. Served WSGI handlers are registered inside a run
 * but invoked per-request OUTSIDE the queue, so a long pip install never
 * stalls a served app.
 */
export function createPythonRunners(opts: PythonRuntimeOptions): PythonRunners {
  let instance: Promise<PipPyodide> | undefined;
  const getPyodide = (): Promise<PipPyodide> => (instance ??= opts.load());

  let tail: Promise<unknown> = Promise.resolve();
  const serialize =
    (exec: Executor): Executor =>
    (ctx) => {
      const run = tail.then(() => exec(ctx));
      tail = run.catch(() => undefined);
      return run;
    };

  return { python: serialize(pythonExecutor(getPyodide)), pip: serialize(pipExecutor(getPyodide)) };
}

/**
 * The `python` executor: syncs the Erdou filesystem into Pyodide before
 * running and back afterward, wires stdout/stderr, sets sys.argv/cwd, and
 * reports the script's exit code.
 */
function pythonExecutor(getPyodide: () => Promise<PipPyodide>): Executor {
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

// A bare distro package name — anything else (version specifiers, URLs) is
// meaningless to loadPackage and goes straight to micropip.
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The `pip` executor: `install` loads Pyodide-prebuilt wheels via
 * `loadPackage`, then routes everything it did not provide through
 * `micropip.install` (PyPI pure-Python wheels; micropip also retries prebuilt
 * names via the lock file, so it never fakes success). `list` reads
 * `loadedPackages`. Anything else errors — no fake success.
 */
function pipExecutor(getPyodide: () => Promise<PipPyodide>): Executor {
  return async (ctx) => {
    const args = ctx.argv.slice(1);
    const cmd = args[0];
    if (cmd === undefined) {
      ctx.stderr.write("pip: usage: pip install <package...> | pip list\n");
      return 1;
    }
    if (cmd !== "install" && cmd !== "list") {
      ctx.stderr.write(`pip: unsupported command '${cmd}' — the browser kernel supports 'install' and 'list' only\n`);
      return 1;
    }

    const pkgs = args.slice(1);
    if (cmd === "install") {
      const opt = pkgs.find((p) => p.startsWith("-"));
      if (opt !== undefined) {
        ctx.stderr.write(`pip install: unsupported option '${opt}' — only package names (with optional version specifiers) are supported\n`);
        return 1;
      }
      if (pkgs.length === 0) {
        ctx.stderr.write("pip install: you must give at least one package to install\n");
        return 1;
      }
    }

    let py: PipPyodide;
    try {
      py = await getPyodide();
    } catch (err) {
      ctx.stderr.write(`pip: failed to load the Python runtime: ${message(err)}\n`);
      return 1;
    }

    if (cmd === "list") {
      for (const name of Object.keys(py.loadedPackages).sort()) {
        ctx.stdout.write(`${name} (${py.loadedPackages[name]})\n`);
      }
      return 0;
    }

    // Python-side output during the install goes to this run's streams.
    py.setStdout({ batched: (t) => ctx.stdout.write(t) });
    py.setStderr({ batched: (t) => ctx.stderr.write(t) });

    const loadErrors: string[] = [];
    const loadOpts = {
      messageCallback: (m: string) => ctx.stdout.write(m + "\n"),
      errorCallback: (m: string) => loadErrors.push(m),
    };
    const detail = (): string => (loadErrors.length > 0 ? `\n${loadErrors.join("\n")}` : "");

    // `loadedPackages` is a plain object — Object.hasOwn, never `in`, or
    // Object.prototype keys (`constructor`, `toString`…) read as installed.
    const preloaded = pkgs.filter((p) => Object.hasOwn(py.loadedPackages, p));
    const plain = pkgs.filter((p) => PLAIN_NAME.test(p));
    if (plain.length > 0) await py.loadPackage(plain, loadOpts);
    const missing = pkgs.filter((p) => !Object.hasOwn(py.loadedPackages, p));

    if (missing.length > 0) {
      await py.loadPackage("micropip", loadOpts);
      if (!Object.hasOwn(py.loadedPackages, "micropip")) {
        ctx.stderr.write(`pip: cannot load micropip from the Pyodide CDN — is the network available?${detail()}\n`);
        return 1;
      }
      const micropip = py.pyimport("micropip") as { install(requirement: string): Promise<unknown>; destroy(): void };
      try {
        for (const pkg of missing) {
          try {
            await micropip.install(pkg);
          } catch (err) {
            const msg = message(err);
            const hint = msg.includes("Can't fetch metadata")
              ? " (this also happens when PyPI is unreachable — check the network)"
              : "";
            ctx.stderr.write(`pip: failed to install '${pkg}': ${msg}${hint}${detail()}\n`);
            return 1;
          }
        }
      } finally {
        micropip.destroy();
      }
    }

    const fresh = pkgs.filter((p) => !preloaded.includes(p));
    if (preloaded.length > 0) ctx.stdout.write(`Requirement already satisfied: ${preloaded.join(" ")}\n`);
    if (fresh.length > 0) ctx.stdout.write(`Successfully installed ${fresh.join(" ")}\n`);
    return 0;
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
