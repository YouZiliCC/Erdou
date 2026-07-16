import { describe, it, expect } from "vitest";
import type { RuntimeCapabilities } from "@erdou/runtime-contract";
import { buildSystemPrompt } from "./prompt.js";

const caps: RuntimeCapabilities = {
  nativeProcesses: true,
  virtualPorts: true,
  persistentStorage: true,
  network: false,
  threads: false,
  nativeAddons: false,
  realOs: false,
  interpreters: [],
  packageManagers: [],
  networkEgress: "none",
  memoryLimitMB: null,
  snapshotCost: "cheap",
};

describe("buildSystemPrompt (simulated kernel)", () => {
  it("frames the environment as a simulated browser OS and lists real constraints", () => {
    const p = buildSystemPrompt({ languages: ["python", "wasi"] }, caps);
    expect(p).toMatch(/simulated.*browser-native/i);
    expect(p).toContain("python, wasi");
    expect(p).toMatch(/wasi \/path\/to\/prog\.wasm/); // wasm note present
    expect(p).toMatch(/Node\.js and npm/); // node explicitly unavailable
    expect(p).toMatch(/apt, yum, brew/); // no package managers
    expect(p).toMatch(/offline/); // networkEgress "none" reflected
  });

  it("omits the wasm note when wasi is not registered and reflects cors-only network", () => {
    const p = buildSystemPrompt({ languages: [] }, { ...caps, networkEgress: "cors-only" });
    expect(p).toContain("none beyond the shell built-ins");
    expect(p).not.toMatch(/wasi \/path/);
    expect(p).toMatch(/network is limited/i);
  });

  it("falls back to capabilities.interpreters when the caller supplies no languages", () => {
    const p = buildSystemPrompt({}, { ...caps, interpreters: ["python", "git"] });
    expect(p).toContain("python, git");
  });
});

describe("buildSystemPrompt (real OS)", () => {
  const realCaps = {
    ...caps,
    realOs: true,
    interpreters: ["python3", "node", "gcc", "git"],
    packageManagers: ["apk", "npm", "pip"],
    networkEgress: "cors-only" as const,
    memoryLimitMB: 2048,
    snapshotCost: "cheap" as const,
  };

  it("frames a REAL Linux machine, /workspace, package managers and the speed warning", () => {
    const p = buildSystemPrompt({}, realCaps);
    expect(p).toMatch(/REAL Linux/);
    expect(p).not.toMatch(/simulated/i);
    expect(p).toContain("/workspace");
    expect(p).toContain("apk, npm, pip");
    expect(p).toMatch(/slower than native/i);
    expect(p).toMatch(/2048MB/);
  });

  it("phrases full egress and no package managers correctly", () => {
    const p = buildSystemPrompt({}, { ...realCaps, packageManagers: [], networkEgress: "full" as const });
    expect(p).toMatch(/No package manager/);
    expect(p).toMatch(/Outbound network is available/);
  });
});
