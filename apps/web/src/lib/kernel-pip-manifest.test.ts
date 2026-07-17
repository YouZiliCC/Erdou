// Tests for kernel.ts's pipInstallPersistence — the storage side of
// browser-kernel pip install transparency (session-only installs, FIX A3) —
// plus the WIRED path: hooks ride on the `loadPyodide` function
// (`load.pipInstalls`) through registerLanguages into createPythonRunners.
// Kept separate from kernel.test.ts so this change stays conflict-free.
import { describe, it, expect, afterEach, vi } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import type { PipPyodide } from "@erdou/lang-python";
import { registerLanguages } from "./languages.js";
import { createBrowserKernel, pipInstallPersistence, type PipManifestStore } from "./kernel.js";

const KEY = "erdou:pip-installs";

class MapStore implements PipManifestStore {
  private m = new Map<string, string>();
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
}

describe("pipInstallPersistence (browser-kernel pip manifest)", () => {
  it("starts empty and round-trips installs into the next session's previousInstalls", () => {
    const store = new MapStore();
    const s1 = pipInstallPersistence(store);
    expect(s1.previousInstalls).toEqual([]);
    s1.onInstall(["numpy", "cowsay"]);
    expect(pipInstallPersistence(store).previousInstalls).toEqual(["numpy", "cowsay"]);
  });

  it("first install of a session replaces the old manifest; later ones append deduplicated", () => {
    const store = new MapStore();
    pipInstallPersistence(store).onInstall(["stale-pkg"]);
    const s = pipInstallPersistence(store);
    s.onInstall(["numpy"]); // replaces [stale-pkg]
    s.onInstall(["cowsay", "numpy"]); // appends, dedupes
    expect(pipInstallPersistence(store).previousInstalls).toEqual(["numpy", "cowsay"]);
  });

  it("previousInstalls reflects session start, not installs made during the session", () => {
    const store = new MapStore();
    pipInstallPersistence(store).onInstall(["old"]);
    const s = pipInstallPersistence(store);
    s.onInstall(["new"]);
    expect(s.previousInstalls).toEqual(["old"]);
  });

  it("reads corrupt or wrong-shaped manifest JSON as empty, then overwrites it cleanly", () => {
    const store = new MapStore();
    store.setItem(KEY, "{not json");
    expect(pipInstallPersistence(store).previousInstalls).toEqual([]);

    store.setItem(KEY, JSON.stringify({ nope: 1 }));
    const s = pipInstallPersistence(store);
    expect(s.previousInstalls).toEqual([]);
    s.onInstall(["numpy"]);
    expect(pipInstallPersistence(store).previousInstalls).toEqual(["numpy"]);
  });
});

// Minimal fake satisfying the full Pyodide surface the runners touch (same
// shape languages.test.ts uses).
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

describe("pip manifest wiring (A3: registerLanguages -> createPythonRunners -> store)", () => {
  // Session 1 installs; session 2 (fresh runtime, same store) gets the hint.
  // Exercises the REAL pass-through: languages.ts forwards the loadPyodide
  // function verbatim, lang-python reads the hooks off `load.pipInstalls`.
  it("pip install writes the manifest; the next session prints the restore hint", async () => {
    const store = new MapStore();

    const s1 = new BrowserRuntime();
    registerLanguages(s1, {
      loadPyodide: Object.assign(async () => fakePyodide(), { pipInstalls: pipInstallPersistence(store) }),
    });
    await s1.boot();
    const install = await s1.openShell().exec("pip install cowsay");
    expect(install.code).toBe(0);
    expect(install.stderr).toContain("session's Python only");
    expect(JSON.parse(store.getItem(KEY)!)).toEqual(["cowsay"]);

    const s2 = new BrowserRuntime();
    registerLanguages(s2, {
      loadPyodide: Object.assign(async () => fakePyodide(), { pipInstalls: pipInstallPersistence(store) }),
    });
    await s2.boot();
    const list = await s2.openShell().exec("pip list");
    expect(list.code).toBe(0);
    expect(list.stderr).toContain("pip install cowsay");
  });
});

describe("createBrowserKernel pip manifest wiring (localStorage guard)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The restore hint prints before Pyodide would load, so this drives the
  // REAL kernel wiring (appPyodideLoader -> registerLanguages ->
  // createPythonRunners) without any network.
  it("with localStorage present, a seeded manifest yields the restore hint on the first python run", async () => {
    const store = new MapStore();
    store.setItem(KEY, JSON.stringify(["numpy", "cowsay"]));
    vi.stubGlobal("localStorage", store);

    const kernel = createBrowserKernel();
    await kernel.runtime.boot();
    const r = await kernel.openShell().exec("python");
    expect(r.code).toBe(2); // usage error — the hint must print even then
    expect(r.stderr).toContain("pip install numpy cowsay");
  });

  it("without localStorage the kernel still builds and prints no hint", async () => {
    vi.stubGlobal("localStorage", undefined);

    const kernel = createBrowserKernel();
    await kernel.runtime.boot();
    const r = await kernel.openShell().exec("python");
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("restore");
  });
});
