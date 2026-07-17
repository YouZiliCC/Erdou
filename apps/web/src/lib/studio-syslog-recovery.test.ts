// Regression tests for systemLog error-line recovery (audit B3/B2 interplay):
// Conversation's .sysbar strip pins systemLog errors with no dismissal and no
// recency window, so a failure that later RECOVERS must retire its own stale
// error line — otherwise the user keeps seeing a data-loss alert (role="alert")
// for a condition that no longer holds. The mount-rescan path is the
// transition-guarded twin of Studio.save()'s snapshot path (covered in
// studio-persistence.test.ts).
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Studio } from "./studio.js";
import { MockDir, MockFile } from "./test-support/mock-dir.js";

// Handle persistence is IndexedDB-backed plumbing exercised elsewhere — stub it
// out, keep the real load/save/rescan behavior (the studio-mount.test.ts idiom).
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
const brokenEntries = () => {
  throw new Error("NotAllowedError: write permission lost");
};

describe("Studio mount-rescan systemLog recovery (B3/B2 stale error strip)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a failing rescan pins ONE error line; the next successful rescan retires it and notes the recovery", async () => {
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));
    const studio = new Studio();
    await studio.mountFolder(root);

    const failLines = () => studio.systemLog.filter((l) => l.kind === "error" && l.text === "Mount rescan failed");
    const recoveryLines = () => studio.systemLog.filter((l) => l.text.startsWith("Mount rescan recovered"));

    // Break the rescan walk (permission revoked / device gone).
    const entriesOk = root.entries.bind(root);
    root.entries = brokenEntries;
    await vi.advanceTimersByTimeAsync(5000);
    expect(failLines()).toHaveLength(1);
    expect(failLines()[0]!.detail).toContain("NotAllowedError");
    // Keeps failing: still one line, no 5s spam.
    await vi.advanceTimersByTimeAsync(5000);
    expect(failLines()).toHaveLength(1);

    // Recovery: the stale error line is REMOVED (so the .sysbar strip clears)
    // and a recovery note lands in the system channel.
    root.entries = entriesOk;
    await vi.advanceTimersByTimeAsync(5000);
    expect(failLines()).toHaveLength(0);
    expect(recoveryLines()).toHaveLength(1);

    // Steady-state success stays quiet.
    await vi.advanceTimersByTimeAsync(5000);
    expect(recoveryLines()).toHaveLength(1);

    // A NEW failure after recovery is a fresh transition: it logs again.
    root.entries = brokenEntries;
    await vi.advanceTimersByTimeAsync(5000);
    expect(failLines()).toHaveLength(1);
  });
});
