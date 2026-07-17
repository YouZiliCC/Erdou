import { describe, it, expect } from "vitest";
import { PROFILE_META, VM_PROFILES } from "@erdou/runtime-vm/profiles";
import { vmAssets } from "./vm-assets.js";

describe("vmAssets", () => {
  it("returns the Vite-served baseUrl, a resolved wasmUrl, and the base profile by default", () => {
    const a = vmAssets();
    expect(a.baseUrl).toBe("/vm-assets");
    expect(typeof a.wasmUrl).toBe("string");
    expect(a.wasmUrl.length).toBeGreaterThan(0);
    expect(a.profile).toBe("base");
    expect(a.version).toBe("alpine-3.24.1-r13-base");
  });

  it("keys each profile by its own version from PROFILE_META (single source)", () => {
    for (const p of VM_PROFILES) {
      const a = vmAssets(p);
      expect(a.profile).toBe(p);
      expect(a.version).toBe(PROFILE_META[p].version);
      expect(a.version).toBe(`alpine-3.24.1-r13-${p}`);
    }
  });

  it("binds the fetched bytes to the cache key: expectedStateVersion mirrors version for every profile", () => {
    for (const p of VM_PROFILES) {
      const a = vmAssets(p);
      expect(a.expectedStateVersion).toBe(a.version);
    }
  });
});
