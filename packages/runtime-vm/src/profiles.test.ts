import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROFILE_META, VM_PROFILES, type VmProfile } from "./profiles.js";
import { assetsPresent, defaultAssets } from "./assets.js";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

describe("PROFILE_META", () => {
  it("defines exactly the base/node/sci profiles", () => {
    expect(VM_PROFILES).toEqual(["base", "node", "sci"]);
    expect(Object.keys(PROFILE_META)).toEqual(VM_PROFILES);
  });

  it("stamps per-profile versions alpine-3.24.1-r13-<profile> (must equal the baked meta)", () => {
    for (const p of VM_PROFILES) expect(PROFILE_META[p].version).toBe(`alpine-3.24.1-r13-${p}`);
  });

  it("bakes python3 into EVERY profile — guestd.py/ptybridge.py are Python", () => {
    for (const p of VM_PROFILES) {
      expect(PROFILE_META[p].packages, p).toContain("python3");
      expect(PROFILE_META[p].interpreters, p).toContain("python3");
    }
  });

  it("gives every profile apk + pip package managers", () => {
    for (const p of VM_PROFILES) {
      expect(PROFILE_META[p].packageManagers, p).toEqual(expect.arrayContaining(["apk", "pip"]));
    }
  });

  it("node profile adds nodejs/npm; sci adds numpy/pandas", () => {
    expect(PROFILE_META.node.packages).toEqual(expect.arrayContaining(["nodejs", "npm"]));
    expect(PROFILE_META.node.interpreters).toContain("node");
    expect(PROFILE_META.node.packageManagers).toContain("npm");
    expect(PROFILE_META.sci.packages).toEqual(expect.arrayContaining(["py3-numpy", "py3-pandas"]));
  });

  it("has a distinct non-empty label per profile", () => {
    const labels = VM_PROFILES.map((p) => PROFILE_META[p].label);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("defaultAssets profile naming", () => {
  it("resolves state-<profile>.zst for non-base profiles (no legacy fallback)", () => {
    for (const p of ["node", "sci"] as VmProfile[]) {
      expect(defaultAssets(p).statePath).toBe(join(assetsDir, `state-${p}.zst`));
    }
  });

  // The pre-R13 legacy state.zst fallback was removed in T10 (assets.ts): base
  // resolves state-base.zst UNCONDITIONALLY, so a stale assets/state.zst on a dev
  // machine must not change the answer.
  it("defaults to the base profile and never resolves the removed legacy state.zst", () => {
    expect(defaultAssets().statePath).toBe(join(assetsDir, "state-base.zst"));
    expect(defaultAssets().profile).toBe("base");
    expect(defaultAssets("base").statePath).toBe(join(assetsDir, "state-base.zst"));
  });

  it("assetsPresent(profile) requires that profile's state image", () => {
    for (const p of VM_PROFILES) {
      expect(assetsPresent(p), p).toBe(existsSync(join(assetsDir, `state-${p}.zst`)));
    }
  });
});
