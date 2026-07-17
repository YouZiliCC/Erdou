import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext } from "@erdou/runtime-contract";
import { createPythonRunners, type PipInstallHooks } from "./python.js";
import type { EmscriptenFS } from "./pyodide.js";

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

// Mock of the real Pyodide surface the runners use, including the package
// APIs: `prebuilt` names load via loadPackage, `pypi` names install via
// micropip, `offline` makes loadPackage fail SILENTLY (its real semantics).
class MockPyodide {
  globals = new Map<string, unknown>();
  FS = new MockFS();
  loadedPackages: Record<string, string> = {};
  prebuilt = new Set<string>();
  pypi = new Set<string>();
  offline = false;
  events: string[] = [];
  private out: (t: string) => void = () => {};
  private err: (t: string) => void = () => {};
  constructor(private sim: (a: SimArgs) => number | Promise<number> = () => 0) {}
  setStdout(o: { batched: (t: string) => void }) {
    this.out = o.batched;
  }
  setStderr(o: { batched: (t: string) => void }) {
    this.err = o.batched;
  }
  async runPythonAsync(): Promise<unknown> {
    const exit = await this.sim({
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
  async loadPackage(
    names: string | string[],
    opts?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void },
  ): Promise<unknown> {
    const list = Array.isArray(names) ? names : [names];
    this.events.push("loadPackage:" + list.join(","));
    for (const n of list) {
      if (this.offline) {
        opts?.errorCallback?.(`Failed to load ${n}`);
      } else if (n === "micropip" || this.prebuilt.has(n)) {
        this.loadedPackages[n] = "default channel";
      } else {
        opts?.errorCallback?.(`No known package with name '${n}'`);
      }
    }
    return [];
  }
  pyimport(name: string): unknown {
    this.events.push("pyimport:" + name);
    return {
      install: async (req: string) => {
        this.events.push("micropip.install:" + req);
        const bare = req.split(/[=<>!~[]/)[0] ?? req;
        if (this.offline || !this.pypi.has(bare)) throw new Error(`Can't fetch metadata for '${req}'.`);
        this.loadedPackages[bare] = "pypi";
      },
      destroy: () => {},
    };
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

const makeRunners = (py: MockPyodide) => createPythonRunners({ load: async () => py });

// Install hooks ride ON the loader (`load.pipInstalls`) — the only channel the
// app's registration seam forwards end-to-end. These tests exercise that exact
// channel, not a test-only shortcut.
const makeHookedRunners = (py: MockPyodide, pipInstalls: PipInstallHooks) =>
  createPythonRunners({ load: Object.assign(async () => py, { pipInstalls }) });

describe("python runner (plumbing, mock Pyodide)", () => {
  it("reads a script from the fs, captures stdout, sets argv, returns exit code", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/hello.py", 'print("hi")');
    let seen: SimArgs | undefined;
    const run = makeRunners(
      new MockPyodide((a) => {
        seen = a;
        a.out("hi\n");
        return 0;
      }),
    ).python;
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
    const run = makeRunners(new MockPyodide((a) => (a.code.includes("sys.exit(3)") ? 3 : 0))).python;
    const { ctx } = makeCtx(["python", "-c", "import sys; sys.exit(3)"], fs);
    expect(await run(ctx)).toBe(3);
  });

  it("syncs files Python writes back into the Erdou filesystem", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/app");
    const run = makeRunners(
      new MockPyodide((a) => {
        a.fs.mkdir("/app");
        a.fs.writeFile("/app/out.txt", new TextEncoder().encode("generated"));
        return 0;
      }),
    ).python;
    const { ctx } = makeCtx(["python", "-c", "open('/app/out.txt','w').write('generated')"], fs);
    await run(ctx);
    expect(fs.readFileText("/app/out.txt")).toBe("generated");
  });

  it("returns 2 with a clear error when the script is missing", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const run = makeRunners(new MockPyodide()).python;
    const { ctx, stderr } = makeCtx(["python", "/nope.py"], fs);
    const code = await run(ctx);
    stderr.end();
    expect(code).toBe(2);
    expect(await stderr.text()).toMatch(/can't open file/);
  });
});

describe("pip runner (mock Pyodide)", () => {
  it("installs prebuilt packages via loadPackage, never touching micropip", async () => {
    const py = new MockPyodide();
    py.prebuilt.add("numpy").add("pandas");
    const { ctx, stdout } = makeCtx(["pip", "install", "numpy", "pandas"], new Vfs({ clock: () => 0 }));
    expect(await makeRunners(py).pip(ctx)).toBe(0);
    stdout.end();
    expect(await stdout.text()).toContain("Successfully installed numpy pandas");
    expect(py.loadedPackages).toMatchObject({ numpy: "default channel", pandas: "default channel" });
    expect(py.events.some((e) => e.startsWith("pyimport"))).toBe(false);
  });

  it("falls back to micropip for packages loadPackage does not know", async () => {
    const py = new MockPyodide();
    py.pypi.add("cowsay");
    const { ctx } = makeCtx(["pip", "install", "cowsay"], new Vfs({ clock: () => 0 }));
    expect(await makeRunners(py).pip(ctx)).toBe(0);
    expect(py.events).toContain("micropip.install:cowsay");
    expect(py.loadedPackages["cowsay"]).toBe("pypi");
  });

  it("routes version-specified requirements straight to micropip", async () => {
    const py = new MockPyodide();
    py.pypi.add("six");
    const { ctx } = makeCtx(["pip", "install", "six==1.17.0"], new Vfs({ clock: () => 0 }));
    expect(await makeRunners(py).pip(ctx)).toBe(0);
    expect(py.events.some((e) => e.startsWith("loadPackage:") && e.includes("six=="))).toBe(false);
    expect(py.events).toContain("micropip.install:six==1.17.0");
  });

  it("fails (no fake success) when loadPackage silently fails offline", async () => {
    const py = new MockPyodide();
    py.prebuilt.add("numpy");
    py.offline = true;
    const { ctx, stderr } = makeCtx(["pip", "install", "numpy"], new Vfs({ clock: () => 0 }));
    expect(await makeRunners(py).pip(ctx)).toBe(1);
    stderr.end();
    const err = await stderr.text();
    expect(err).toMatch(/CDN|network/);
    expect(err).toContain("Failed to load numpy");
  });

  // `loadedPackages` is a plain object — an `in` check would see Object.prototype
  // keys, faking success for real PyPI names like `constructor` or `toString`.
  it("does not fake success for package names that collide with Object.prototype", async () => {
    const py = new MockPyodide();
    py.offline = true;
    const { ctx, stdout } = makeCtx(["pip", "install", "constructor", "toString"], new Vfs({ clock: () => 0 }));
    expect(await makeRunners(py).pip(ctx)).toBe(1);
    stdout.end();
    expect(await stdout.text()).not.toContain("Successfully installed");
  });

  it("reports already-loaded packages as satisfied instead of claiming a fresh install", async () => {
    const py = new MockPyodide();
    py.prebuilt.add("numpy");
    const runners = makeRunners(py);
    await runners.pip(makeCtx(["pip", "install", "numpy"], new Vfs({ clock: () => 0 })).ctx);
    const { ctx, stdout } = makeCtx(["pip", "install", "numpy"], new Vfs({ clock: () => 0 }));
    expect(await runners.pip(ctx)).toBe(0);
    stdout.end();
    const out = await stdout.text();
    expect(out).toContain("Requirement already satisfied: numpy");
    expect(out).not.toContain("Successfully installed");
  });

  it("errors clearly when micropip cannot resolve a package, with a network hint", async () => {
    const py = new MockPyodide();
    const { ctx, stderr } = makeCtx(["pip", "install", "nosuchpkg"], new Vfs({ clock: () => 0 }));
    expect(await makeRunners(py).pip(ctx)).toBe(1);
    stderr.end();
    const err = await stderr.text();
    expect(err).toContain("failed to install 'nosuchpkg'");
    expect(err).toContain("PyPI is unreachable");
  });

  it("pip list prints loaded packages with their source", async () => {
    const py = new MockPyodide();
    py.prebuilt.add("numpy");
    const runners = makeRunners(py);
    await runners.pip(makeCtx(["pip", "install", "numpy"], new Vfs({ clock: () => 0 })).ctx);
    const { ctx, stdout } = makeCtx(["pip", "list"], new Vfs({ clock: () => 0 }));
    expect(await runners.pip(ctx)).toBe(0);
    stdout.end();
    expect(await stdout.text()).toContain("numpy (default channel)");
  });

  it("errors on unsupported subcommands, options, and empty installs (no fake success)", async () => {
    const py = new MockPyodide();
    const pip = makeRunners(py).pip;
    const fs = () => new Vfs({ clock: () => 0 });

    const usage = makeCtx(["pip"], fs());
    expect(await pip(usage.ctx)).toBe(1);
    usage.stderr.end();
    expect(await usage.stderr.text()).toMatch(/usage/);

    const uninstall = makeCtx(["pip", "uninstall", "x"], fs());
    expect(await pip(uninstall.ctx)).toBe(1);
    uninstall.stderr.end();
    expect(await uninstall.stderr.text()).toContain("unsupported command 'uninstall'");

    const flag = makeCtx(["pip", "install", "-q", "numpy"], fs());
    expect(await pip(flag.ctx)).toBe(1);
    flag.stderr.end();
    expect(await flag.stderr.text()).toContain("unsupported option '-q'");

    const empty = makeCtx(["pip", "install"], fs());
    expect(await pip(empty.ctx)).toBe(1);
    empty.stderr.end();
    expect(await empty.stderr.text()).toMatch(/at least one package/);
  });

  it("shares one Pyodide instance between python and pip (both orders)", async () => {
    const fs = () => new Vfs({ clock: () => 0 });

    let loads = 0;
    const py = new MockPyodide();
    py.prebuilt.add("numpy");
    const runners = createPythonRunners({
      load: async () => {
        loads += 1;
        return py;
      },
    });
    expect(await runners.python(makeCtx(["python", "-c", "1"], fs()).ctx)).toBe(0);
    expect(await runners.pip(makeCtx(["pip", "install", "numpy"], fs()).ctx)).toBe(0);
    expect(loads).toBe(1);

    let loads2 = 0;
    const py2 = new MockPyodide();
    py2.prebuilt.add("numpy");
    const runners2 = createPythonRunners({
      load: async () => {
        loads2 += 1;
        return py2;
      },
    });
    expect(await runners2.pip(makeCtx(["pip", "install", "numpy"], fs()).ctx)).toBe(0);
    expect(await runners2.python(makeCtx(["python", "-c", "1"], fs()).ctx)).toBe(0);
    expect(loads2).toBe(1);
  });

  it("prints the session-only notice and fires onInstall exactly once per successful install", async () => {
    const py = new MockPyodide();
    py.prebuilt.add("numpy");
    py.pypi.add("cowsay");
    const calls: string[][] = [];
    const runners = makeHookedRunners(py, { onInstall: (p) => calls.push(p) });

    const first = makeCtx(["pip", "install", "numpy", "cowsay"], new Vfs({ clock: () => 0 }));
    expect(await runners.pip(first.ctx)).toBe(0);
    first.stderr.end();
    const err = await first.stderr.text();
    expect(err.match(/session's Python only/g)).toHaveLength(1);
    expect(err).toContain("VM kernel installs persist");
    expect(calls).toEqual([["numpy", "cowsay"]]);

    const second = makeCtx(["pip", "install", "numpy"], new Vfs({ clock: () => 0 }));
    expect(await runners.pip(second.ctx)).toBe(0);
    expect(calls).toEqual([["numpy", "cowsay"], ["numpy"]]);
  });

  it("failed installs and pip list neither print the notice nor fire onInstall", async () => {
    const py = new MockPyodide(); // nothing prebuilt or on PyPI → install fails
    const calls: string[][] = [];
    const runners = makeHookedRunners(py, { onInstall: (p) => calls.push(p) });

    const failed = makeCtx(["pip", "install", "nosuchpkg"], new Vfs({ clock: () => 0 }));
    expect(await runners.pip(failed.ctx)).toBe(1);
    failed.stderr.end();
    expect(await failed.stderr.text()).not.toContain("session's Python only");

    const list = makeCtx(["pip", "list"], new Vfs({ clock: () => 0 }));
    expect(await runners.pip(list.ctx)).toBe(0);
    list.stderr.end();
    expect(await list.stderr.text()).toBe("");
    expect(calls).toEqual([]);
  });

  it("prints the previous session's restore hint once, on the first run (python first)", async () => {
    const py = new MockPyodide();
    const runners = makeHookedRunners(py, { previousInstalls: ["numpy", "cowsay"] });

    const first = makeCtx(["python", "-c", "1"], new Vfs({ clock: () => 0 }));
    expect(await runners.python(first.ctx)).toBe(0);
    first.stderr.end();
    expect(await first.stderr.text()).toContain("pip install numpy cowsay");

    const second = makeCtx(["pip", "list"], new Vfs({ clock: () => 0 }));
    expect(await runners.pip(second.ctx)).toBe(0);
    second.stderr.end();
    expect(await second.stderr.text()).not.toContain("pip install numpy cowsay");
  });

  it("pip-first also prints the restore hint; without previousInstalls there is no hint", async () => {
    const py = new MockPyodide();
    const hinted = makeHookedRunners(py, { previousInstalls: ["numpy"] });
    const first = makeCtx(["pip", "list"], new Vfs({ clock: () => 0 }));
    expect(await hinted.pip(first.ctx)).toBe(0);
    first.stderr.end();
    expect(await first.stderr.text()).toContain("pip install numpy");

    const bare = createPythonRunners({ load: async () => new MockPyodide() });
    const run = makeCtx(["python", "-c", "1"], new Vfs({ clock: () => 0 }));
    expect(await bare.python(run.ctx)).toBe(0);
    run.stderr.end();
    expect(await run.stderr.text()).toBe("");
  });

  it("serializes a pip run behind a pending python run; streams do not cross", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const py = new MockPyodide(async (a) => {
      events.push("python:start");
      a.out("py-out\n");
      await gate;
      events.push("python:end");
      return 0;
    });
    py.events = events;
    py.prebuilt.add("numpy");
    const runners = makeRunners(py);

    const pyCtx = makeCtx(["python", "-c", "slow"], new Vfs({ clock: () => 0 }));
    const pipCtx = makeCtx(["pip", "install", "numpy"], new Vfs({ clock: () => 0 }));
    const pythonDone = runners.python(pyCtx.ctx);
    const pipDone = runners.pip(pipCtx.ctx);

    // Give an unserialized pip plenty of time to reach loadPackage.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["python:start"]);

    release();
    expect(await pythonDone).toBe(0);
    expect(await pipDone).toBe(0);
    expect(events).toEqual(["python:start", "python:end", "loadPackage:numpy"]);

    pyCtx.stdout.end();
    pipCtx.stdout.end();
    expect(await pyCtx.stdout.text()).toBe("py-out\n");
    expect(await pipCtx.stdout.text()).not.toContain("py-out");
  });
});
