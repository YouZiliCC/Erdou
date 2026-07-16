import { describe, it, expect } from "vitest";
import { assertFs9pSymbols } from "./v86-host.js";

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
