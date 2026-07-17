import { describe, it, expect } from "vitest";
import { vmCapabilities } from "./capabilities.js";

describe("vmCapabilities", () => {
  it("describes a real 32-bit Alpine guest with real package-registry egress", () => {
    const caps = vmCapabilities(["python3"]);
    expect(caps.realOs).toBe(true);
    expect(caps.nativeProcesses).toBe(true);
    expect(caps.nativeAddons).toBe(true); // a real machine runs native binaries
    expect(caps.interpreters).toEqual(["python3"]);
    expect(caps.packageManagers).toEqual(["apk", "pip"]); // base profile default
    // R13: pip/npm reach the real registries through the fetch-NAT gateway (inbound
    // preview + outbound package installs); arbitrary hosts still unreachable.
    expect(caps.networkEgress).toBe("cors-only");
    expect(caps.memoryLimitMB).toBe(512);
    expect(caps.snapshotCost).toBe("cheap"); // workspace-scoped, not the whole machine
  });

  it("takes per-profile package managers (the node profile adds npm)", () => {
    const caps = vmCapabilities(["python3", "node"], ["apk", "pip", "npm"]);
    expect(caps.interpreters).toEqual(["python3", "node"]);
    expect(caps.packageManagers).toEqual(["apk", "pip", "npm"]);
    expect(caps.networkEgress).toBe("cors-only");
  });
});
