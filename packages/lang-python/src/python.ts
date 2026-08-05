import type { ExecContext, Executor, FileSystemApi } from "@erdou/runtime-contract";
import type { Pyodide, EmscriptenFS } from "./pyodide.js";
import { ERDOU_SETUP, createServeBinding, routeOutput } from "./erdou-module.js";

const decoder = new TextDecoder();

// Top-level dirs Pyodide owns — never sync Erdou files over them.
const RESERVED = new Set(["lib", "proc", "dev", "home", "tmp", "usr", "bin", "sbin", "etc", "opt", "sys"]);

function absPath(cwd: string, p: string): string {
  if (p.startsWith("/")) return p;
  return cwd === "/" ? "/" + p : `${cwd}/${p}`;
}

// Runs the user's code in a fresh namespace, capturing sys.exit() and exceptions.
// Exported for the CPython-parity test (python.test.ts runs it under a real
// python3); the mock-Pyodide tests never execute it.
export const RUNNER = `
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
    if __e.code is not None and not isinstance(__e.code, int):
        print(__e.code, file=sys.stderr)  # CPython prints a non-int exit arg — sys.exit("message") is the standard CLI error idiom
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

/**
 * Install-transparency hooks the app attaches: browser-kernel installs land
 * only in the session's in-memory Pyodide, so the app records what a session
 * installed and hints at restoring it in the next one. This package stays
 * storage-agnostic per the layering invariant — it only calls/reads these.
 */
export interface PipInstallHooks {
  /**
   * Called once per successful `pip install`, with every requirement the
   * command ensured (the exact argv strings — reusable as `pip install
   * <names>`).
   */
  onInstall?: (packages: string[]) => void;
  /**
   * Requirements recorded by `onInstall` in a previous session. When
   * non-empty, the first `python`/`pip` run of this session prints a one-line
   * restore hint with the exact `pip install` command — deliberately NO
   * automatic re-download (a surprise multi-MB fetch is worse than the hint).
   */
  previousInstalls?: readonly string[];
}

/**
 * Resolves a `pip install` requirement to a local wheel closure: given the raw
 * argv requirement (e.g. `python-pptx` or `python-pptx==1.0.2`), returns the
 * ordered list of wheel URLs — the package plus its pure-Python dependency
 * closure — to hand micropip, or `null` when the package is not bundled. The
 * app owns the manifest and normalization; this package only calls the function
 * (layering invariant). When it returns URLs, pip installs from them (offline,
 * version-locked) and lets micropip pull native deps (lxml/Pillow) from the
 * Pyodide lockfile; when it returns null, pip uses the loadPackage/micropip path.
 */
export type LocalWheelResolver = (requirement: string) => readonly string[] | null;

/**
 * Loader for the shared Pyodide instance. The install hooks and the local-wheel
 * resolver ride ON the loader (`load.pipInstalls`, `load.localWheels`) rather
 * than as sibling options: the app's registration seam (apps/web
 * `registerLanguages`) forwards ONLY the loader into this factory, so the
 * function value is the one channel that reaches them end-to-end — anything
 * passed another way would be dropped at that seam. A plain
 * `() => Promise<PipPyodide>` (no extras attached) is a valid loader.
 */
export type PipPyodideLoader = (() => Promise<PipPyodide>) & {
  pipInstalls?: PipInstallHooks;
  localWheels?: LocalWheelResolver;
};

export interface PythonRuntimeOptions {
  load: PipPyodideLoader;
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

  // Installs land in this session's in-memory Pyodide only (deliberately not
  // snapshotted) — say so instead of letting a reload silently drop them.
  const hooks = opts.load.pipInstalls;
  let restorable = hooks?.previousInstalls ?? [];
  const notices: InstallNotices = {
    restoreHint(ctx) {
      if (restorable.length === 0) return;
      ctx.stderr.write(
        `note: browser-kernel installs are session-only — restore the previous session's packages with: pip install ${restorable.join(" ")}\n`,
      );
      restorable = [];
    },
    installed(ctx, packages) {
      ctx.stderr.write(
        "pip: note: packages install into this session's Python only and will need reinstalling after a page reload (VM kernel installs persist)\n",
      );
      hooks?.onInstall?.(packages);
    },
  };

  let tail: Promise<unknown> = Promise.resolve();
  const serialize =
    (exec: Executor): Executor =>
    (ctx) => {
      const run = tail.then(() => exec(ctx));
      tail = run.catch(() => undefined);
      return run;
    };

  return {
    python: serialize(pythonExecutor(getPyodide, notices)),
    pip: serialize(pipExecutor(getPyodide, notices, opts.load.localWheels)),
  };
}

/** The micropip surface pip uses. `install` takes a single requirement or a
 *  list (a bundled package's local wheel closure installs in one call). */
interface Micropip {
  install(requirement: string | readonly string[]): Promise<unknown>;
  destroy(): void;
}

/**
 * Session-only install transparency (the browser kernel's pip is this
 * package's only consumer): a one-time restore hint for the previous session's
 * packages, plus an after-install notice + app callback. Both write to stderr
 * — advisory lines must never corrupt a program's stdout.
 */
interface InstallNotices {
  /** Print the previous session's restore hint; a no-op after the first call. */
  restoreHint(ctx: ExecContext): void;
  /** A `pip install` succeeded: print the session-only notice, report `packages` to the app. */
  installed(ctx: ExecContext, packages: string[]): void;
}

/**
 * The `python` executor: syncs the Erdou filesystem into Pyodide before
 * running and back afterward, wires stdout/stderr, sets sys.argv/cwd, and
 * reports the script's exit code.
 */
function pythonExecutor(getPyodide: () => Promise<PipPyodide>, notices: InstallNotices): Executor {
  // Every path the PREVIOUS run left in the (session-long, cached) Pyodide FS
  // and propagated into the Erdou FS — the only paths the next prune may
  // remove. Lives here, not per run, because one executor closure owns exactly
  // one Pyodide instance.
  let backed = new Set<string>();
  return async (ctx) => {
    notices.restoreHint(ctx);
    const args = ctx.argv.slice(1);
    let code: string;
    let scriptArgv: string[];

    if (args[0] === "-c") {
      code = args[1] ?? "";
      scriptArgv = ["-c", ...args.slice(2)];
    } else if (args[0] === "-m") {
      // The browser kernel's Python is Pyodide — no module launcher and, more to
      // the point, no real network sockets, so `python -m http.server` (the
      // usual reason `-m` is reached for) can never listen here. The old path
      // fell through to the file-read below and printed "can't open file '-m'",
      // which read as a typo and sent agents chasing the VM. Fail fast with the
      // paths that actually work instead.
      ctx.stderr.write(
        "python: 'python -m' is not supported on the browser kernel (no module launcher, and no sockets " +
          "for a server like http.server). To preview static files use 'erdou serve <dir>' (add --spa for a " +
          "client-side router); to run a Python web app, serve it with 'erdou.serve(app, port)' or switch to " +
          "a vm:* kernel. To run other code use 'python <file.py>' or 'python -c <code>'.\n",
      );
      return 2;
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

    const pfs = py.FS;
    const synced = syncInto(ctx.fs, pfs, backed);
    routeOutput(py, ctx);
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
    backed = syncBack(pfs, ctx.fs, synced);
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
function pipExecutor(
  getPyodide: () => Promise<PipPyodide>,
  notices: InstallNotices,
  resolveWheels?: LocalWheelResolver,
): Executor {
  return async (ctx) => {
    notices.restoreHint(ctx);
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
    routeOutput(py, ctx);

    const loadErrors: string[] = [];
    const loadOpts = {
      messageCallback: (m: string) => ctx.stdout.write(m + "\n"),
      errorCallback: (m: string) => loadErrors.push(m),
    };
    const detail = (): string => (loadErrors.length > 0 ? `\n${loadErrors.join("\n")}` : "");

    // micropip loads at most once (bundled wheels AND the pypi fallback need it).
    let micropip: Micropip | undefined;
    const getMicropip = async (): Promise<Micropip | null> => {
      if (micropip) return micropip;
      await py.loadPackage("micropip", loadOpts);
      if (!Object.hasOwn(py.loadedPackages, "micropip")) return null;
      micropip = py.pyimport("micropip") as Micropip;
      return micropip;
    };

    // Local wheel index: a bundled requirement installs from its same-origin
    // wheel closure (offline, version-locked) via one micropip call; micropip
    // still pulls native deps (lxml/Pillow) from the Pyodide lockfile. Anything
    // not bundled flows through the loadPackage → micropip path below.
    const bundled = resolveWheels ? pkgs.filter((p) => resolveWheels(p) !== null) : [];
    const external = pkgs.filter((p) => !bundled.includes(p));

    try {
      if (bundled.length > 0) {
        const urls = [...new Set(bundled.flatMap((p) => resolveWheels!(p)!))];
        const mp = await getMicropip();
        if (!mp) {
          ctx.stderr.write(`pip: cannot load micropip from the Pyodide CDN — is the network available?${detail()}\n`);
          return 1;
        }
        try {
          await mp.install(urls);
        } catch (err) {
          ctx.stderr.write(`pip: failed to install '${bundled.join(" ")}': ${message(err)}${detail()}\n`);
          return 1;
        }
      }

      // `loadedPackages` is a plain object — Object.hasOwn, never `in`, or
      // Object.prototype keys (`constructor`, `toString`…) read as installed.
      const preloaded = external.filter((p) => Object.hasOwn(py.loadedPackages, p));
      const plain = external.filter((p) => PLAIN_NAME.test(p));
      if (plain.length > 0) await py.loadPackage(plain, loadOpts);
      const missing = external.filter((p) => !Object.hasOwn(py.loadedPackages, p));

      if (missing.length > 0) {
        const mp = await getMicropip();
        if (!mp) {
          ctx.stderr.write(`pip: cannot load micropip from the Pyodide CDN — is the network available?${detail()}\n`);
          return 1;
        }
        for (const pkg of missing) {
          try {
            await mp.install(pkg);
          } catch (err) {
            const msg = message(err);
            const hint = msg.includes("Can't fetch metadata")
              ? " (this also happens when PyPI is unreachable — check the network)"
              : "";
            ctx.stderr.write(`pip: failed to install '${pkg}': ${msg}${hint}${detail()}\n`);
            return 1;
          }
        }
      }

      const fresh = pkgs.filter((p) => !preloaded.includes(p));
      if (preloaded.length > 0) ctx.stdout.write(`Requirement already satisfied: ${preloaded.join(" ")}\n`);
      if (fresh.length > 0) ctx.stdout.write(`Successfully installed ${fresh.join(" ")}\n`);
      // Exit 0 means every requested requirement is present in this session —
      // report them ALL (not just `fresh`: a name preloaded as another install's
      // dependency, or a bundled wheel, still belongs in the restore hint).
      notices.installed(ctx, pkgs);
      return 0;
    } finally {
      micropip?.destroy();
    }
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

/**
 * Mirror the Erdou filesystem into Pyodide's FS at the same paths, returning
 * every path mirrored — the exact set that existed before the run, which
 * `syncBack` needs to tell "the script deleted it" from "the script never
 * touched it".
 *
 * The Pyodide instance is cached for the whole session, so anything a previous
 * run left in its FS is still there. Prune the stale ones, under the
 * non-RESERVED top-level dirs only (the same ownership rule the copy loop
 * uses): without this, `rm foo.py` followed by any python run has `syncBack`
 * copy the stale Pyodide-side foo.py straight back into the VFS.
 *
 * "Stale" is deliberately narrow: a path in `backed` (the previous `syncBack`'s
 * return — everything that run left in Pyodide's FS AND propagated into the
 * Erdou FS) that the Erdou FS no longer has. Anything else in Pyodide's FS
 * arrived out of band and is NOT ours to delete: a served WSGI app outlives the
 * run that launched it (see `createServeBinding`), so a request it handles
 * between runs writes straight into Pyodide's FS, and that file exists nowhere
 * else until the next `syncBack` copies it out. An unconditional "delete what
 * the Erdou FS lacks" destroyed a served app's data on the next `python`.
 */
function syncInto(fs: FileSystemApi, pfs: EmscriptenFS, backed: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const walk = (path: string): void => {
    const st = fs.stat(path);
    if (st.type === "directory") {
      ensureDir(pfs, path);
      seen.add(path);
      for (const e of fs.readdir(path)) walk(path === "/" ? `/${e.name}` : `${path}/${e.name}`);
    } else if (st.type === "file") {
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      if (dir !== "/") ensureDir(pfs, dir);
      pfs.writeFile(path, fs.readFile(path));
      seen.add(path);
    }
  };
  for (const e of fs.readdir("/")) {
    if (!RESERVED.has(e.name)) walk(`/${e.name}`);
  }
  for (const name of entries(pfs, "/")) {
    if (RESERVED.has(name)) continue;
    prune(pfs, `/${name}`, backed, seen);
  }
  return seen;
}

/** Real Emscripten `readdir` (and the mocks that mimic it) includes "." and "..". */
const entries = (pfs: EmscriptenFS, path: string): string[] =>
  pfs.readdir(path).filter((n) => n !== "." && n !== "..");

/**
 * Remove `path` when the previous run propagated it to the Erdou FS (`backed`)
 * and the Erdou FS no longer has it (`seen`) — anything else in Pyodide's FS is
 * state we did not put there and must survive. Depth-first so a directory is
 * empty by the time its own rmdir runs; a directory holding a survivor is kept
 * too, because rmdir on it would throw ENOTEMPTY and fail the whole run.
 */
function prune(pfs: EmscriptenFS, path: string, backed: ReadonlySet<string>, seen: ReadonlySet<string>): void {
  const stale = backed.has(path) && !seen.has(path);
  if (!pfs.isDir(pfs.stat(path).mode)) {
    if (stale) pfs.unlink(path);
    return;
  }
  for (const name of entries(pfs, path)) prune(pfs, `${path}/${name}`, backed, seen);
  if (stale && entries(pfs, path).length === 0) pfs.rmdir(path);
}

/**
 * Mirror files Python created/changed back into the Erdou filesystem, and apply
 * the deletions it made. `synced` is everything that existed when the run
 * started, so a path in it that is gone from Pyodide's FS was removed by the
 * script (os.remove, shutil.rmtree, a rename) — leaving it in the VFS discards
 * that removal silently, and the next `syncInto` puts it back into Pyodide.
 *
 * Returns every path propagated, which is exactly the `backed` set the next
 * `syncInto` prunes against. It has to be collected HERE, not from `syncInto`:
 * a file the script itself created (`open('out.txt','w')`) is in the Erdou FS
 * from this point on, so a later `rm out.txt` is a real deletion to apply — and
 * `syncInto`'s set, taken before the script ran, never contained it.
 */
function syncBack(pfs: EmscriptenFS, fs: FileSystemApi, synced: Set<string>): Set<string> {
  const propagated = new Set<string>();
  const walk = (path: string): void => {
    const st = pfs.stat(path);
    if (pfs.isDir(st.mode)) {
      if (!fs.exists(path)) fs.mkdir(path, { recursive: true });
      propagated.add(path);
      for (const name of entries(pfs, path)) walk(path === "/" ? `/${name}` : `${path}/${name}`);
    } else if (pfs.isFile(st.mode)) {
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      if (dir !== "/" && !fs.exists(dir)) fs.mkdir(dir, { recursive: true });
      fs.writeFile(path, pfs.readFile(path, { encoding: "binary" }));
      propagated.add(path);
    }
  };
  for (const name of entries(pfs, "/")) {
    if (RESERVED.has(name)) continue;
    walk(`/${name}`);
  }
  for (const path of synced) {
    // `exists` guards the child of an already-recursively-removed directory.
    if (!pfs.analyzePath(path).exists && fs.exists(path)) fs.rm(path, { recursive: true });
  }
  return propagated;
}
