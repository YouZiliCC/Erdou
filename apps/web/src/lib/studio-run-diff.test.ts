import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Studio } from "./studio.js";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { ModelGateway } from "@erdou/model-gateway";
import { DEFAULT_MODEL } from "./model-config.js";
import type { Kernel } from "./kernel.js";
import type { DirHandleLike, FileHandleLike } from "./local-mount.js";

// Handle persistence hits IndexedDB with a structured clone of the handle —
// a MockDir (methods and all) can't clone, and that plumbing is exercised
// elsewhere. Keep the real load/save/rescan behavior (the code under test).
vi.mock("./local-mount.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-mount.js")>();
  return {
    ...actual,
    persistHandle: vi.fn(async () => {}),
    loadPersistedHandle: vi.fn(async () => null),
    clearPersistedHandle: vi.fn(async () => {}),
  };
});

const enc = new TextEncoder();

class MockFile implements FileHandleLike {
  kind = "file" as const;
  constructor(
    public data: Uint8Array,
    public lastModified = 0,
  ) {}
  async getFile() {
    const d = this.data;
    const lastModified = this.lastModified;
    return { arrayBuffer: async () => d.slice().buffer, lastModified };
  }
  async createWritable() {
    const self = this;
    return {
      async write(d: BufferSource) {
        self.data = new Uint8Array(d as Uint8Array);
      },
      async close() {},
    };
  }
}

class MockDir implements DirHandleLike {
  kind = "directory" as const;
  children = new Map<string, MockFile | MockDir>();
  constructor(public name: string) {}
  async *entries(): AsyncIterableIterator<[string, FileHandleLike | DirHandleLike]> {
    for (const [k, v] of this.children) yield [k, v];
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike> {
    let d = this.children.get(name);
    if (!d) {
      if (!opts?.create) throw new Error("ENOENT");
      d = new MockDir(name);
      this.children.set(name, d);
    }
    return d as MockDir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike> {
    let f = this.children.get(name);
    if (!f) {
      if (!opts?.create) throw new Error("ENOENT");
      f = new MockFile(new Uint8Array());
      this.children.set(name, f);
    }
    return f as MockFile;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new Error("ENOENT");
  }
}

// Chat-mock gateway (the run-lifecycle idiom): each mock supplies one model turn.
type ChatMock = ReturnType<typeof vi.fn>;
const gatewayWith = (chat: ChatMock): ModelGateway => ({ chat }) as unknown as ModelGateway;
const setGateway = (studio: Studio, chat: ChatMock): void => {
  (studio as unknown as { gateway: ModelGateway }).gateway = gatewayWith(chat);
};
const toolCallTurn = (id: string, name: string, args: unknown) => ({
  content: "",
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
const finalTurn = { content: "done", toolCalls: [] };

const changeKeys = (studio: Studio, task: string): string[] => {
  const run = studio.runs.find((r) => r.task === task);
  expect(run).toBeDefined();
  return run!.changes.map((c) => `${c.kind}:${c.path}`);
};

describe("run diff — external disk edits pulled mid-run are the USER's, not the agent's (a)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Boot + mount with the window/document stubs the mount watcher needs, and
   *  capture the watcher's "focus" listener so a test can fire a rescan tick
   *  deterministically (same tick as the 5s interval — the scheduling itself is
   *  covered by studio-mount.test.ts). */
  async function mountedStudio(root: MockDir): Promise<{ studio: Studio; tickNow: () => void }> {
    const winListeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: vi.fn((ev: string, fn: () => void) => winListeners.set(ev, fn)),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { hidden: false, visibilityState: "visible", addEventListener: vi.fn() });
    const studio = new Studio();
    await studio.boot();
    await studio.mountFolder(root);
    const onFocus = winListeners.get("focus");
    expect(onFocus).toBeDefined();
    return { studio, tickNow: onFocus! };
  }

  it("a rescan pull during a run does NOT land in run.changes — only the agent's own edit does", async () => {
    const root = new MockDir("project");
    root.children.set("user.txt", new MockFile(enc.encode("disk v1"), 1000));
    const { studio, tickNow } = await mountedStudio(root);

    // The model parks mid-run so the rescan tick fires while the run is live.
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((r) => (releaseModel = r));
    let modelStarted!: () => void;
    const started = new Promise<void>((r) => (modelStarted = r));
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        modelStarted();
        await modelGate;
        return toolCallTurn("c1", "write_file", { path: "/agent.txt", content: "agent work" });
      })
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    const turn = studio.startRun("mid-run external edit", DEFAULT_MODEL, "auto");
    await started;

    // The user saves user.txt in an external editor; the watcher pulls it in.
    root.children.set("user.txt", new MockFile(enc.encode("disk v2"), 2000));
    tickNow();
    await vi.waitFor(async () => {
      expect(await studio.readFileText("/user.txt")).toBe("disk v2");
    });
    // Let the pull's discount settle (one macrotask) before the turn continues.
    await new Promise((r) => setTimeout(r, 5));

    releaseModel();
    await turn;

    const run = studio.runs.find((r) => r.task === "mid-run external edit");
    expect(run).toBeDefined();
    // The agent's own edit is attributed; the user's external edit is NOT.
    expect(run!.changes.map((c) => c.path)).toContain("/agent.txt");
    expect(run!.changes.map((c) => c.path)).not.toContain("/user.txt");
    expect(run!.status).toBe("review");

    await studio.unmount(); // clear the real 5s interval
  });

  it("an agent write to the SAME file AFTER a mid-run pull is still attributed (span: run-start -> agent content)", async () => {
    const root = new MockDir("project");
    root.children.set("user.txt", new MockFile(enc.encode("disk v1"), 1000));
    const { studio, tickNow } = await mountedStudio(root);

    let releaseModel!: () => void;
    const modelGate = new Promise<void>((r) => (releaseModel = r));
    let modelStarted!: () => void;
    const started = new Promise<void>((r) => (modelStarted = r));
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        modelStarted();
        await modelGate;
        return toolCallTurn("c1", "write_file", { path: "/user.txt", content: "agent version" });
      })
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    const turn = studio.startRun("pull then agent edit", DEFAULT_MODEL, "auto");
    await started;

    root.children.set("user.txt", new MockFile(enc.encode("disk v2"), 2000));
    tickNow();
    await vi.waitFor(async () => {
      expect(await studio.readFileText("/user.txt")).toBe("disk v2");
    });
    await new Promise((r) => setTimeout(r, 5));

    releaseModel();
    await turn;

    const run = studio.runs.find((r) => r.task === "pull then agent edit");
    const change = run!.changes.find((c) => c.path === "/user.txt");
    // The agent DID change this file after the pull — attributed, spanning
    // run-start content to the agent's content.
    expect(change).toBeDefined();
    expect(change!.kind).toBe("modify");
    expect(change!.before).toBe("disk v1");
    expect(change!.after).toBe("agent version");

    await studio.unmount();
  });
});

describe("run diff — directory changes (b)", () => {
  it("an EMPTY new directory is invisible in the diff (a content diff has nothing to show) and does not corrupt the run", async () => {
    const studio = new Studio();
    await studio.boot();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "make_dir", { path: "/empty" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("mkdir only", DEFAULT_MODEL, "auto");

    const run = studio.runs.find((r) => r.task === "mkdir only");
    expect(run!.trace.some((l) => l.kind === "error")).toBe(false);
    expect(run!.changes).toEqual([]);
    expect(run!.status).toBe("done"); // nothing reviewable — documented semantics
    expect(studio.fs.exists("/empty")).toBe(true);
  });

  it("deleting a directory shows a delete entry for EVERY file that lived beneath it", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.mkdir("/proj/sub", { recursive: true });
    studio.fs.writeFile("/proj/a.txt", "alpha");
    studio.fs.writeFile("/proj/sub/b.txt", "beta");
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "remove_path", { path: "/proj" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("delete a dir", DEFAULT_MODEL, "auto");

    expect(changeKeys(studio, "delete a dir")).toEqual(["delete:/proj/a.txt", "delete:/proj/sub/b.txt"]);
    const run = studio.runs.find((r) => r.task === "delete a dir")!;
    expect(run.changes.map((c) => c.before)).toEqual(["alpha", "beta"]);
    expect(run.status).toBe("review");
  });

  it("renaming a directory shows per-file delete + create entries (the move is not invisible)", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.mkdir("/old");
    studio.fs.writeFile("/old/f.txt", "moved");
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "run_shell", { command: "mv /old /new" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("rename a dir", DEFAULT_MODEL, "auto");

    expect(changeKeys(studio, "rename a dir")).toEqual(["create:/new/f.txt", "delete:/old/f.txt"]);
    const run = studio.runs.find((r) => r.task === "rename a dir")!;
    expect(run.changes.find((c) => c.path === "/new/f.txt")!.after).toBe("moved");
    expect(run.changes.find((c) => c.path === "/old/f.txt")!.before).toBe("moved");
  });

  it("a run-created symlink-to-directory stays INVISIBLE — no phantom creates through the link, revert cannot reach the real files", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.mkdir("/srcd");
    studio.fs.writeFile("/srcd/real.txt", "data");

    // Park the model mid-turn so the symlink lands while the run-diff
    // subscription is live — exactly what tool-git's fs-adapter does when a
    // checkout materializes a symlink onto the run's fs.
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((r) => (releaseModel = r));
    let modelStarted!: () => void;
    const started = new Promise<void>((r) => (modelStarted = r));
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        modelStarted();
        await modelGate;
        return toolCallTurn("c1", "write_file", { path: "/own.txt", content: "agent work" });
      })
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    const turn = studio.startRun("symlink to dir", DEFAULT_MODEL, "auto");
    await started;
    studio.fs.symlink("/srcd", "/link");
    releaseModel();
    await turn;

    // stat FOLLOWS symlinks: gating the live expansion on it fabricated
    // create:/link/real.txt — and reverting that phantom entry deleted the
    // REAL /srcd/real.txt, a file the agent never touched. The lstat gate
    // keeps the link out: only the agent's own edit shows, and the target
    // tree is untouchable from the Review panel.
    expect(changeKeys(studio, "symlink to dir")).toEqual(["create:/own.txt"]);
    expect(await studio.readFileText("/srcd/real.txt")).toBe("data");
    expect(studio.runs.find((r) => r.task === "symlink to dir")!.status).toBe("review");
  });

  it("revert of a file deleted via its directory recreates the missing parent directories too", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.mkdir("/proj/sub", { recursive: true });
    studio.fs.writeFile("/proj/sub/b.txt", "beta");
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "remove_path", { path: "/proj" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("revert dir delete", DEFAULT_MODEL, "auto");
    const run = studio.runs.find((r) => r.task === "revert dir delete")!;
    expect(run.changes.map((c) => c.path)).toContain("/proj/sub/b.txt");

    await studio.revertChange(run.id, "/proj/sub/b.txt");
    expect(await studio.readFileText("/proj/sub/b.txt")).toBe("beta");
  });
});

describe("run diff — a mid-run kernel switch's own writes stay out of the diff (c)", () => {
  /** A fake VM kernel backed by a real BrowserRuntime (the agent-switch test
   *  idiom): working writeFile/subscribe/createSnapshot + a distinct fs. */
  async function fakeVmKernel(profile: "base" | "node" | "sci"): Promise<Kernel> {
    const runtime = new BrowserRuntime();
    await runtime.boot();
    return {
      kind: "vm",
      profile,
      runtime,
      fs: runtime.fs,
      openShell: () => runtime.openShell(),
      shutdown: async () => {},
    };
  }

  it("the R20 quarantine rename during an agent vm->browser switch does not land in run.changes", async () => {
    const studio = new Studio();
    await studio.boot();
    // A leaked non-empty /etc sits in the BROWSER workspace (the pre-R13 leak).
    studio.fs.mkdir("/etc");
    studio.fs.writeFile("/etc/pip.conf", "leaked config");
    // Move to a fake VM kernel (user switch, outside any run).
    const fakeNode = await fakeVmKernel("node");
    (studio as unknown as { vmKernel: Kernel | null }).vmKernel = fakeNode;
    await studio.switchEnvironment("vm:node");
    expect(studio.currentEnvId).toBe("vm:node");

    // Mid-run, the agent switches back to the browser kernel — performSwitch
    // runs cleanLeakedVmEntries, which quarantine-renames /etc -> /etc.vm-leaked
    // on the incoming browser fs BEFORE the run-diff subscription re-points.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "switch_environment", { target: "browser" }))
      .mockResolvedValueOnce(toolCallTurn("c2", "write_file", { path: "/post.txt", content: "after" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("switch back", DEFAULT_MODEL, "auto");

    expect(studio.currentEnvId).toBe("browser");
    // The quarantine DID happen on the browser workspace…
    expect(studio.fs.exists("/etc.vm-leaked/pip.conf")).toBe(true);
    expect(studio.fs.exists("/etc")).toBe(false);
    // …but none of it is attributed to the agent: only its own edit shows.
    expect(changeKeys(studio, "switch back")).toEqual(["create:/post.txt"]);
    const run = studio.runs.find((r) => r.task === "switch back")!;
    expect(run.changes.some((c) => c.path.startsWith("/etc"))).toBe(false);
    expect(run.status).toBe("review");
  });
});

describe("run diff — empty-content edge cases in mergeChanges (d)", () => {
  it("creating an EMPTY file shows as a create (it used to vanish from the diff)", async () => {
    const studio = new Studio();
    await studio.boot();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "write_file", { path: "/empty.txt", content: "" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("create empty file", DEFAULT_MODEL, "auto");

    expect(changeKeys(studio, "create empty file")).toEqual(["create:/empty.txt"]);
    expect(studio.runs.find((r) => r.task === "create empty file")!.status).toBe("review");
  });

  it("truncating a file to empty shows as a MODIFY, not a delete (the file still exists)", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/t.txt", "content");
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "write_file", { path: "/t.txt", content: "" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("truncate", DEFAULT_MODEL, "auto");

    expect(changeKeys(studio, "truncate")).toEqual(["modify:/t.txt"]);
    const change = studio.runs.find((r) => r.task === "truncate")!.changes[0]!;
    expect(change.before).toBe("content");
    expect(change.after).toBe("");
    expect(studio.fs.exists("/t.txt")).toBe(true);
  });

  it("deleting an EMPTY file shows as a delete (it used to vanish from the diff)", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/e.txt", "");
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "remove_path", { path: "/e.txt" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("delete empty", DEFAULT_MODEL, "auto");

    expect(changeKeys(studio, "delete empty")).toEqual(["delete:/e.txt"]);
    expect(studio.fs.exists("/e.txt")).toBe(false);
  });

  it("multi-turn: create in turn 1 + delete in turn 2 still nets out to no change", async () => {
    const studio = new Studio();
    await studio.boot();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "write_file", { path: "/tmp1.txt", content: "x" }))
      .mockResolvedValueOnce(finalTurn)
      .mockResolvedValueOnce(toolCallTurn("c2", "remove_path", { path: "/tmp1.txt" }))
      .mockResolvedValueOnce(finalTurn);
    setGateway(studio, chat);

    await studio.startRun("net noop", DEFAULT_MODEL, "auto");
    const run = studio.runs.find((r) => r.task === "net noop")!;
    expect(run.changes.map((c) => c.path)).toEqual(["/tmp1.txt"]);

    await studio.replyToRun(run.id, "now remove it", DEFAULT_MODEL, "auto");
    expect(run.changes).toEqual([]);
    expect(run.status).toBe("done");
  });
});
