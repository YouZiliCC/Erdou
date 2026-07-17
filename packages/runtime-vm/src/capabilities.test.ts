import { describe, it, expect } from "vitest";
import { vmCapabilities } from "./capabilities.js";
import { VmRuntime } from "./vm-runtime.js";
import { PROFILE_META } from "./profiles.js";

// A loader that must never run: getCapabilities is a pure profile lookup, so it
// must resolve WITHOUT booting the VM (no assets, no v86). If it ever awaits the
// loader this throws and the test fails loudly rather than hanging on a real boot.
const NEVER_LOADS = async (): Promise<never> => { throw new Error("getCapabilities must not boot the VM"); };

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

// The agent reads getCapabilities() to learn what the running image ships. It
// must reflect the image PROFILE the runtime was constructed for — not a
// hardcoded python3 — or a run started on vm:node is told only python3+apk+pip
// and never learns node/npm exist. Profile is a pure lookup, so these assert
// WITHOUT booting (NEVER_LOADS above).
describe("VmRuntime.getCapabilities is per-profile", () => {
  it("node profile reports node + npm (per PROFILE_META.node)", async () => {
    const caps = await new VmRuntime(NEVER_LOADS, { profile: "node" }).getCapabilities();
    expect(caps.interpreters).toContain("node");
    expect(caps.packageManagers).toContain("npm");
    expect(caps.interpreters).toEqual(PROFILE_META.node.interpreters);
    expect(caps.packageManagers).toEqual(PROFILE_META.node.packageManagers);
  });

  it("defaults to the base profile (no node/npm) when none is given", async () => {
    const caps = await new VmRuntime(NEVER_LOADS).getCapabilities();
    expect(caps.interpreters).not.toContain("node");
    expect(caps.packageManagers).not.toContain("npm");
    expect(caps.interpreters).toEqual(PROFILE_META.base.interpreters);
    expect(caps.packageManagers).toEqual(PROFILE_META.base.packageManagers);
  });

  it("sci profile reports its baked stack per PROFILE_META.sci", async () => {
    // numpy/pandas ship as apk `packages`, which RuntimeCapabilities has no field
    // for; the truthful sci capability is still python3 + apk/pip (== PROFILE_META).
    const caps = await new VmRuntime(NEVER_LOADS, { profile: "sci" }).getCapabilities();
    expect(caps.interpreters).toEqual(PROFILE_META.sci.interpreters);
    expect(caps.packageManagers).toEqual(PROFILE_META.sci.packageManagers);
  });
});
