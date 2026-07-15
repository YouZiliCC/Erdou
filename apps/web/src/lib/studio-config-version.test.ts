import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Studio } from "./studio.js";
import { writeFolderState } from "./folder-state.js";
import { loadModel, loadApprovalMode } from "./model-config.js";
import { MockDir } from "./test-support/mock-dir.js";

// Studio persists the mount handle to IndexedDB, which isn't polyfilled in this
// package's (node) test environment — stub that plumbing out, same as
// studio-mount.test.ts.
vi.mock("./local-mount.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-mount.js")>();
  return {
    ...actual,
    persistHandle: vi.fn(async () => {}),
    loadPersistedHandle: vi.fn(async () => null),
    clearPersistedHandle: vi.fn(async () => {}),
  };
});

/** Minimal in-memory localStorage — this test environment has none by default. */
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("Studio configVersion (folder-hydrated config, no reload)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vi.stubGlobal("document", { hidden: false, documentElement: { setAttribute: vi.fn() } });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bumps configVersion when mountFolder hydrates a DIFFERENT config from .erdou/", async () => {
    // Simulate the app's current (pre-mount) config.
    localStorage.setItem("erdou:model", JSON.stringify({ provider: "openai-compatible", baseUrl: "/llm/v1", apiKey: "old-key", model: "old-model" }));
    localStorage.setItem("erdou:approval-mode", "auto");

    const root = new MockDir("project");
    await writeFolderState(root, {
      runs: [],
      config: {
        theme: "light",
        approvalMode: "confirm",
        model: { provider: "openai-compatible", baseUrl: "/llm/v1", apiKey: "folder-key", model: "folder-model" },
      },
    });

    const studio = new Studio();
    expect(studio.configVersion).toBe(0);

    await studio.mountFolder(root);

    // Hydrate ran and changed the persisted config -> bump.
    expect(studio.configVersion).toBe(1);
    expect(loadModel()).toEqual({ provider: "openai-compatible", baseUrl: "/llm/v1", apiKey: "folder-key", model: "folder-model" });
    expect(loadApprovalMode()).toBe("confirm");
  });

  it("does NOT bump configVersion when mounting a folder with no .erdou/ yet (seed, not hydrate)", async () => {
    const root = new MockDir("project"); // no .erdou/ — mountFolder seeds it instead of hydrating
    const studio = new Studio();

    await studio.mountFolder(root);

    expect(studio.configVersion).toBe(0);
  });

  it("does not bump on unrelated notifies (e.g. a plain file change)", async () => {
    const root = new MockDir("project");
    const studio = new Studio();
    await studio.mountFolder(root);
    expect(studio.configVersion).toBe(0);

    const versionBefore = studio.version;
    studio.logSystem("system", "unrelated notify");
    expect(studio.version).toBeGreaterThan(versionBefore); // version bumps on every notify...
    expect(studio.configVersion).toBe(0); // ...but configVersion doesn't
  });
});
