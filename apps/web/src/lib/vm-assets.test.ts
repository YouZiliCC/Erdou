import { describe, it, expect } from "vitest";
import { vmAssets } from "./vm-assets.js";

describe("vmAssets", () => {
  it("returns the Vite-served baseUrl, a resolved wasmUrl, and a version cache key", () => {
    const a = vmAssets();
    expect(a.baseUrl).toBe("/vm-assets");
    expect(typeof a.wasmUrl).toBe("string");
    expect(a.wasmUrl.length).toBeGreaterThan(0);
    expect(a.version).toBe("alpine-3.24.1-r12-lo-baked");
  });

  it("binds the fetched bytes to the cache key: expectedStateVersion mirrors version", () => {
    const a = vmAssets();
    expect(a.expectedStateVersion).toBe(a.version);
  });
});
