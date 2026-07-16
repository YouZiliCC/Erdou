import { describe, it, expect, vi } from "vitest";
import { createVmKernel } from "./vm-kernel.js";

// Inject a fake runtime factory so the test doesn't boot a real VM.
const fakeRuntime = () => {
  const events: unknown[] = [];
  // syncFs must return the SAME object on every call (like the real VmRuntime's
  // guest-backed fs), so the `toBe` identity check below is meaningful.
  const fs = { readFile() { return new Uint8Array(); }, writeFile() {}, readdir() { return []; }, mkdir() {}, rm() {}, exists() { return false; }, stat() { return {} as any; } };
  return {
    booted: true,
    boot: vi.fn(async () => {}),
    exec: vi.fn(),
    openPty: vi.fn(async () => ({ write() {}, onData() {}, resize() {}, dispose: async () => {} })),
    syncFs: () => fs,
    subscribe: () => () => {},
    _events: events,
  };
};

describe("createVmKernel", () => {
  it("boots the runtime, kind is 'vm', exposes fs (syncFs) + openShell + openPty", async () => {
    const rt = fakeRuntime();
    const kernel = await createVmKernel({ makeRuntime: () => rt as any });
    expect(kernel.kind).toBe("vm");
    expect(rt.boot).toHaveBeenCalled();
    expect(kernel.fs).toBe(rt.syncFs() as any); // fs is the runtime's syncFs (compare shape)
    expect(typeof kernel.openShell().exec).toBe("function"); // exec-shell
    expect(typeof kernel.openPty).toBe("function");
  });
});
