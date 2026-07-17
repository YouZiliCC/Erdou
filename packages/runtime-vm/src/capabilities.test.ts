import { describe, it, expect } from "vitest";
import { vmCapabilities } from "./capabilities.js";

describe("vmCapabilities", () => {
  it("describes a real 32-bit Alpine guest", () => {
    const caps = vmCapabilities(["python3"]);
    expect(caps.realOs).toBe(true);
    expect(caps.nativeProcesses).toBe(true);
    expect(caps.nativeAddons).toBe(true); // a real machine runs native binaries
    expect(caps.interpreters).toEqual(["python3"]);
    expect(caps.packageManagers).toEqual(["apk", "pip"]);
    expect(caps.networkEgress).toBe("none"); // NAT-dispatch is inbound-only (preview); egress gateway is a future round
    expect(caps.memoryLimitMB).toBe(512);
    expect(caps.snapshotCost).toBe("cheap"); // workspace-scoped, not the whole machine
  });
});
