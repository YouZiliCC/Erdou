import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROFILE_META, VM_PROFILES, type VmProfile } from "./profiles.js";
import { assetsPresent, defaultAssets } from "./assets.js";

// assetsPresent() reads a FIXED assets/ dir, so the only way to pin what it
// actually requires — rather than mirror its `shared.every(...) && existsSync(state)`
// back at itself — is to control the answers. Everything else in node:fs stays real.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
}));
const onlyPresent = (...paths: string[]): void => {
  vi.mocked(existsSync).mockImplementation((f) => paths.includes(String(f)));
};

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
});

// assetsPresent() gates boot(): each path it approves is one loadNodeInputs then
// readFileSync's, so a `true` with any of them missing becomes an ENOENT deep inside
// boot. Drive the cases from defaultAssets — the surface boot actually consumes —
// rather than from assets.ts's private `shared` list; drift between the two is the bug.
describe("assetsPresent", () => {
  const files = (p: VmProfile): string[] => {
    const a = defaultAssets(p);
    return [a.biosPath, a.vgaBiosPath, a.kernelPath, a.statePath];
  };

  it("requires ALL of bios/vgabios/kernel AND that profile's state image", () => {
    for (const p of VM_PROFILES) {
      onlyPresent(...files(p));
      expect(assetsPresent(p), `${p}: everything present`).toBe(true);
      for (const missing of files(p)) {
        onlyPresent(...files(p).filter((f) => f !== missing));
        expect(assetsPresent(p), `${p}: without ${missing}`).toBe(false);
      }
    }
  });

  it("is per-profile: a base bake alone does not make node/sci bootable", () => {
    onlyPresent(...files("base"));
    expect(assetsPresent("base")).toBe(true);
    expect(assetsPresent("node")).toBe(false);
    expect(assetsPresent("sci")).toBe(false);
    // ...and the removed legacy state.zst is not a substitute for a per-profile bake
    onlyPresent(...files("base").slice(0, 3), join(assetsDir, "state.zst"));
    expect(assetsPresent("base")).toBe(false);
  });
});
