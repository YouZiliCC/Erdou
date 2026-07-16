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

describe("buildSystemPrompt", () => {
  it("frames the environment as a simulated browser OS and lists real constraints", () => {
    const p = buildSystemPrompt({ languages: ["python", "wasi"] }, caps);
    expect(p).toMatch(/simulated.*browser-native/i);
    expect(p).toContain("python, wasi");
    expect(p).toMatch(/wasi \/path\/to\/prog\.wasm/); // wasm note present
    expect(p).toMatch(/Node\.js and npm/); // node explicitly unavailable
    expect(p).toMatch(/apt, yum, brew/);
    expect(p).toMatch(/offline/); // network:false reflected
  });

  it("omits the wasm note when wasi is not registered and reflects network access", () => {
    const p = buildSystemPrompt({ languages: [] }, { ...caps, network: true });
    expect(p).toContain("none beyond the shell built-ins");
    expect(p).not.toMatch(/wasi \/path/);
    expect(p).toMatch(/network is limited/i);
  });
});
