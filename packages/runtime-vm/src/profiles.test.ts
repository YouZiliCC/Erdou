import { describe, it, expect, vi, afterEach } from "vitest";
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
  afterEach(() => vi.restoreAllMocks());

  it("resolves state-<profile>.zst for non-base profiles (no legacy fallback)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const p of ["node", "sci"] as VmProfile[]) {
      expect(defaultAssets(p).statePath).toBe(join(assetsDir, `state-${p}.zst`));
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults to the base profile", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(defaultAssets().statePath).toMatch(/state(-base)?\.zst$/);
    expect(defaultAssets().profile).toBe("base");
  });

  // LEGACY pre-R13 single-image transition — delete this test together with the
  // fallback in T10 (it self-skips once state-base.zst is baked).
  it.skipIf(existsSync(join(assetsDir, "state-base.zst")) || !existsSync(join(assetsDir, "state.zst")))(
    "falls back to legacy state.zst for base when state-base.zst is absent, loudly",
    () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const a = defaultAssets("base");
      expect(a.statePath).toBe(join(assetsDir, "state.zst"));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/state-base\.zst absent.*legacy state\.zst/));
      expect(assetsPresent("base")).toBe(true); // conformance gate stays green pre-T10
    },
  );

  it("assetsPresent(profile) requires that profile's state image", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const p of ["node", "sci"] as VmProfile[]) {
      expect(assetsPresent(p)).toBe(existsSync(join(assetsDir, `state-${p}.zst`)));
    }
  });
});
