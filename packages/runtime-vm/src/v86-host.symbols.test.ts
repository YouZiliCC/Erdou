import { describe, it, expect } from "vitest";
import { assertFs9pSymbols, V86Host, type V86BootInputs } from "./v86-host.js";

describe("assertFs9pSymbols", () => {
  it("passes on an object with all required fs9p methods", () => {
    const ok: Record<string, unknown> = { inodes: [] };
    for (const m of ["GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile", "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file"]) ok[m] = () => {};
    expect(() => assertFs9pSymbols(ok)).not.toThrow();
  });

  it("throws a clear error naming the missing method", () => {
    const bad: Record<string, unknown> = { inodes: [], CreateFile: () => {} };
    expect(() => assertFs9pSymbols(bad)).toThrow(/fs9p.*missing.*(SearchPath|CreateDirectory)/);
  });
});

const inputs: V86BootInputs = {
  bios: new ArrayBuffer(8), vgaBios: new ArrayBuffer(8), kernel: new ArrayBuffer(8),
  wasmUrl: "file:///nope/v86.wasm", memoryMB: 512,
};

describe("V86Host.boot timeout", () => {
  it("rejects with a clear error if emulator-ready never fires (the silent wasm hang)", async () => {
    // A fake emulator that NEVER emits emulator-ready — simulates the wasm 404 hang.
    class HangHost extends V86Host {
      protected makeEmulator(): any {
        return { add_listener() {}, bus: { send() {} } };
      }
    }
    const host = new HangHost();
    await expect(host.boot(inputs, { bootTimeoutMs: 50 })).rejects.toThrow(/v86.*not.*ready|wasm|asset/i);
  });
});
