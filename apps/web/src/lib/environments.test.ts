import { describe, expect, it } from "vitest";
import profilesData from "../../../../packages/runtime-vm/src/profiles.data.json";
import {
  ENVIRONMENTS,
  environmentById,
  environmentOptions,
  type EnvironmentDescriptor,
} from "./environments.js";

const VM_PROFILE_IDS = ["base", "node", "sci"] as const;

describe("ENVIRONMENTS catalog", () => {
  it("lists browser first, then one entry per VM profile, with stable ids", () => {
    expect(ENVIRONMENTS.map((e) => e.id)).toEqual(["browser", "vm:base", "vm:node", "vm:sci"]);
  });

  it("derives VM entries from profiles.data.json (single source of truth)", () => {
    for (const p of VM_PROFILE_IDS) {
      const env = environmentById(`vm:${p}`);
      expect(env.kernel).toBe("vm");
      expect(env.profile).toBe(p);
      expect(env.label).toBe(`Linux VM · ${profilesData[p].label}`);
      expect(env.version).toBe(profilesData[p].version);
      expect(env.interpreters).toEqual(profilesData[p].interpreters);
      expect(env.packageManagers).toEqual(profilesData[p].packageManagers);
    }
  });

  it("gives every entry a label, speed class, install recipes and switch guidance", () => {
    for (const env of ENVIRONMENTS) {
      expect(env.label).not.toBe("");
      expect(env.speed).not.toBe("");
      expect(env.installRecipes.length).toBeGreaterThan(0);
      expect(env.switchGuidance).not.toBe("");
    }
  });

  it("browser entry has no VM profile or bake version", () => {
    const browser = environmentById("browser");
    expect(browser.kernel).toBe("browser");
    expect(browser.profile).toBeUndefined();
    expect(browser.version).toBeUndefined();
  });

  it("environmentById throws on unknown ids", () => {
    expect(() => environmentById("vm:gpu")).toThrow(/vm:gpu/);
  });
});

describe("environmentOptions", () => {
  it("enables everything when all profiles are present", () => {
    const opts = environmentOptions(ENVIRONMENTS, ["base", "node", "sci"]);
    expect(opts.map((o) => o.value)).toEqual(["browser", "vm:base", "vm:node", "vm:sci"]);
    for (const o of opts) {
      expect(o.disabled).toBeUndefined();
      expect(o.hint).toBeUndefined();
      expect(o.label).not.toBe("");
    }
  });

  it("disables absent profiles with a bake hint; browser is never disabled", () => {
    const opts = environmentOptions(ENVIRONMENTS, ["base"]);
    const byValue = Object.fromEntries(opts.map((o) => [o.value, o]));
    expect(byValue["browser"]?.disabled).toBeUndefined();
    expect(byValue["vm:base"]?.disabled).toBeUndefined();
    expect(byValue["vm:node"]?.disabled).toBe(true);
    expect(byValue["vm:node"]?.hint).toMatch(/bake --profile node/);
    expect(byValue["vm:sci"]?.disabled).toBe(true);
    expect(byValue["vm:sci"]?.hint).toMatch(/bake --profile sci/);
  });

  it("disables all VM entries when no profile is baked", () => {
    const opts = environmentOptions(ENVIRONMENTS, []);
    expect(opts.filter((o) => o.disabled).map((o) => o.value)).toEqual(["vm:base", "vm:node", "vm:sci"]);
  });

  it("is pure: does not mutate the catalog", () => {
    const before = JSON.stringify(ENVIRONMENTS);
    environmentOptions(ENVIRONMENTS, []);
    environmentOptions(ENVIRONMENTS, ["base", "node", "sci"]);
    expect(JSON.stringify(ENVIRONMENTS)).toBe(before);
  });

  it("accepts any catalog subset (pure function of its inputs)", () => {
    const vmNode = ENVIRONMENTS.find((e): e is EnvironmentDescriptor => e.id === "vm:node");
    expect(vmNode).toBeDefined();
    const opts = environmentOptions([vmNode as EnvironmentDescriptor], ["node"]);
    expect(opts).toEqual([{ value: "vm:node", label: vmNode?.label }]);
  });
});
