import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio } from "./studio.js";
import { Vfs } from "@erdou/runtime-browser";
import { DEFAULT_MODEL } from "./model-config.js";

vi.mock("./local-mount.js", async (o) => ({
  ...(await o<typeof import("./local-mount.js")>()),
  persistHandle: vi.fn(async () => {}),
  loadPersistedHandle: vi.fn(async () => null),
  clearPersistedHandle: vi.fn(async () => {}),
}));

describe("Studio.switchKernel", () => {
  it("switches to a (fake) vm kernel, copies the workspace, and swaps", async () => {
    const studio = new Studio();
    await studio.boot();
    await studio.fs.mkdir?.("/p", { recursive: true });
    studio.fs.writeFile("/keep.txt", "follows-me");
    // inject a fake vm kernel with its OWN fs (distinct Vfs) so the copy is
    // actually asserted, not just a shared-reference illusion.
    const vmFs = new Vfs();
    const fakeVm = {
      kind: "vm" as const,
      runtime: studio.runtime,
      fs: vmFs,
      openShell: () => studio.shell,
      openPty: async () => ({}) as any,
    };
    await studio.switchKernel("vm", {
      makeKernel: async ({ onProgress }) => {
        onProgress?.("boot");
        return fakeVm;
      },
    });
    expect(studio.kernelKind).toBe("vm");
    // the workspace file was copied into the vm kernel's (distinct) fs
    expect(new TextDecoder().decode(studio.fs.readFile("/keep.txt"))).toBe("follows-me");
    expect(studio.fs).toBe(vmFs);
  });

  it("switching back to browser reuses the cached browser kernel and copies the workspace back", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/a.txt", "one");
    const browserFs = studio.fs;

    const vmFs = new Vfs();
    const fakeVm = {
      kind: "vm" as const,
      runtime: studio.runtime,
      fs: vmFs,
      openShell: () => studio.shell,
      openPty: async () => ({}) as any,
    };
    await studio.switchKernel("vm", { makeKernel: async () => fakeVm });
    expect(studio.kernelKind).toBe("vm");

    // Mutate in the vm kernel, then switch back — the change should follow.
    studio.fs.writeFile("/b.txt", "two");
    await studio.switchKernel("browser");
    expect(studio.kernelKind).toBe("browser");
    expect(studio.fs).toBe(browserFs);
    expect(new TextDecoder().decode(studio.fs.readFile("/a.txt"))).toBe("one");
    expect(new TextDecoder().decode(studio.fs.readFile("/b.txt"))).toBe("two");

    // Switching to "vm" again reuses the cached vm kernel (no second makeKernel call).
    const makeKernel = vi.fn(async () => fakeVm);
    await studio.switchKernel("vm", { makeKernel });
    expect(makeKernel).not.toHaveBeenCalled();
    expect(studio.fs).toBe(vmFs);
  });

  it("is a no-op when a run is active, when already on the target kernel, or mid-switch", async () => {
    const studio = new Studio();
    await studio.boot();

    // Already on "browser": switching to "browser" is a no-op.
    await studio.switchKernel("browser");
    expect(studio.kernelKind).toBe("browser");

    // Simulate a run in progress.
    (studio as unknown as { running: boolean }).running = true;
    await studio.switchKernel("vm", { makeKernel: async () => ({ kind: "vm" as const, runtime: studio.runtime, fs: new Vfs(), openShell: () => studio.shell }) });
    expect(studio.kernelKind).toBe("browser"); // guarded: no switch while running
    (studio as unknown as { running: boolean }).running = false;
  });

  // Final-review Fix 1: the boot-await window (~40 MB fetch + boot) is long
  // enough for a run to start on the OLD kernel while switchKernel is still
  // awaiting the new one — the entry guard above only catches a run already in
  // progress at the moment the switch was requested. Close that window three
  // ways; these two tests cover the Studio-level halves (startRun/replyToRun
  // refusing to start, and switchKernel aborting the swap).
  it("startRun and replyToRun are no-ops while a kernel switch is mid-boot", async () => {
    const studio = new Studio();
    await studio.boot();

    let resolveMake: (k: unknown) => void = () => {};
    const pending = new Promise((res) => {
      resolveMake = res;
    });
    const vmFs = new Vfs();

    const switchPromise = studio.switchKernel("vm", { makeKernel: async () => pending as any });
    // switchKernel sets `switchingKernel` synchronously, before awaiting the boot.
    expect(studio.switchingKernel).not.toBeNull();

    await studio.startRun("write a file", DEFAULT_MODEL, "auto");
    expect(studio.running).toBe(false);
    expect(studio.runs.length).toBe(0); // no run was created
    expect(studio.activeRun).toBeUndefined();

    // replyToRun's guard fires before it even looks up the run.
    await studio.replyToRun("does-not-exist", "reply", DEFAULT_MODEL, "auto");
    expect(studio.running).toBe(false);

    // Resolve the switch so it finishes cleanly (no dangling promise/timer).
    resolveMake({ kind: "vm" as const, runtime: studio.runtime, fs: vmFs, openShell: () => studio.shell });
    await switchPromise;
    expect(studio.kernelKind).toBe("vm");
    expect(studio.switchingKernel).toBeNull();
  });

  it("switchKernel aborts the swap if a run starts during the boot-await window (stays on the old kernel; the booted vm is still cached for next time)", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/keep.txt", "original");
    const browserFs = studio.fs;

    let resolveMake: (k: unknown) => void = () => {};
    const pending = new Promise((res) => {
      resolveMake = res;
    });
    const vmFs = new Vfs();
    const fakeVm = { kind: "vm" as const, runtime: studio.runtime, fs: vmFs, openShell: () => studio.shell };

    const switchPromise = studio.switchKernel("vm", { makeKernel: async () => pending as any });
    // Simulate a run starting during the cold-boot await window (the race this fix closes).
    (studio as unknown as { running: boolean }).running = true;
    resolveMake(fakeVm);
    await switchPromise;

    expect(studio.kernelKind).toBe("browser"); // aborted — never swapped to the vm kernel
    expect(studio.fs).toBe(browserFs);
    expect(studio.switchingKernel).toBeNull(); // cleared by the `finally`

    // The freshly-booted vm kernel stays cached even though the swap was
    // aborted: a later switch (once the run has ended) reuses it instead of
    // booting a second one.
    (studio as unknown as { running: boolean }).running = false;
    const makeKernel = vi.fn(async () => fakeVm);
    await studio.switchKernel("vm", { makeKernel });
    expect(makeKernel).not.toHaveBeenCalled();
    expect(studio.kernelKind).toBe("vm");
    expect(studio.fs).toBe(vmFs);
  });
});
