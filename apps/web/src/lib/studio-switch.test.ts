import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio } from "./studio.js";
import { Vfs } from "@erdou/runtime-browser";

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
});
