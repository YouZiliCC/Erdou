import { describe, it, expect } from "vitest";
import type { RuntimeCapabilities } from "@erdou/runtime-contract";
import { buildSystemPrompt, ERDOU_MD_TEMPLATE, type EnvironmentCatalog } from "./prompt.js";

const caps: RuntimeCapabilities = {
  nativeProcesses: true,
  virtualPorts: true,
  persistentStorage: true,
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

  it("frames a REAL Linux machine, project root, package managers and the speed warning", () => {
    const p = buildSystemPrompt({}, realCaps);
    expect(p).toMatch(/REAL Linux/);
    expect(p).not.toMatch(/simulated/i);
    // The project root is `/` on every kernel (the VM chroots so `/` IS the
    // project); the prompt frames `/` as the root, and never mentions /workspace.
    expect(p).toMatch(/rooted at `?\//);
    expect(p).not.toContain("workspace"); // no lingering /workspace framing
    expect(p).toContain("npm, pip"); // runtime installers…
    expect(p).toMatch(/apk.*baked into the image/i); // …apk is bake-time only, not "installs work"
    expect(p).toMatch(/slower than native/i);
    expect(p).toMatch(/2048MB/);
  });

  it("phrases full egress and no package managers correctly", () => {
    const p = buildSystemPrompt({}, { ...realCaps, packageManagers: [], networkEgress: "full" as const });
    expect(p).toMatch(/No package manager/);
    expect(p).toMatch(/Outbound network is available/);
  });

  it("phrases cors-only egress truthfully — npm/pip via a gateway, arbitrary hosts unreachable", () => {
    const p = buildSystemPrompt({}, realCaps); // realCaps.networkEgress === "cors-only"
    expect(p).toMatch(/npm\/pip/);
    expect(p).toMatch(/gateway/i);
    expect(p).toMatch(/arbitrary hosts are NOT reachable/);
  });
});

describe("buildSystemPrompt (environments catalog)", () => {
  const realCaps: RuntimeCapabilities = {
    ...caps,
    realOs: true,
    interpreters: ["python3"],
    packageManagers: ["apk", "pip"],
    networkEgress: "cors-only",
    memoryLimitMB: 512,
  };

  const catalog: EnvironmentCatalog = {
    current: "vm:base",
    available: [
      {
        id: "browser",
        label: "Browser kernel",
        interpreters: ["python (Pyodide)", "wasi"],
        packageManagers: ["pip (micropip)"],
        installRecipes: [
          "pip install <package> — micropip: pure-Python wheels from PyPI only; installs reset on page reload.",
        ],
        switchGuidance: "Default. Fastest start, no real Linux.",
        speed: "instant",
      },
      {
        id: "vm:base",
        label: "Linux VM · Python",
        interpreters: ["python3"],
        packageManagers: ["apk", "pip"],
        installRecipes: [
          "pip install <package> — via the package gateway; user-site persists in the project; a full venv is heavy (~1.5k files).",
        ],
        switchGuidance: "Real Alpine shell with Python + pip.",
        speed: "slow — emulated x86",
      },
      {
        id: "vm:node",
        label: "Linux VM · Node.js",
        interpreters: ["python3", "node"],
        packageManagers: ["apk", "pip", "npm"],
        installRecipes: [
          "npm install <package> — via the package gateway; node_modules persists in the project.",
        ],
        switchGuidance: "Alpine with Node.js + npm.",
        speed: "slow — emulated x86",
      },
      {
        id: "vm:sci",
        label: "Linux VM · NumPy/Pandas",
        interpreters: ["python3"],
        packageManagers: ["apk", "pip"],
        installRecipes: [
          "NumPy and Pandas are baked in; the first import numpy/pandas takes ~50 s per process.",
        ],
        switchGuidance: "Data work beyond pure-Python wheels.",
        speed: "slow — emulated x86",
      },
    ],
  };

  it("renders the catalog with the current env, every available env and its per-env facts", () => {
    const p = buildSystemPrompt({ catalog }, realCaps);
    expect(p).toMatch(/ENVIRONMENTS & PACKAGES/);
    // current env is named
    expect(p).toMatch(/Linux VM · Python \(vm:base\)/);
    expect(p).toMatch(/\[current\]/);
    // every available env id + label appears
    for (const id of ["browser", "vm:base", "vm:node", "vm:sci"]) expect(p).toContain(id);
    expect(p).toContain("Linux VM · Node.js");
    // interpreters + package managers rendered
    expect(p).toContain("python (Pyodide)");
    expect(p).toMatch(/apk, pip, npm/);
    // install recipes (truthful narratives) rendered verbatim from the supplied data
    expect(p).toMatch(/user-site persists/);
    expect(p).toMatch(/venv is heavy/);
    expect(p).toMatch(/node_modules persists/);
    expect(p).toMatch(/reset on page reload/);
    expect(p).toMatch(/~50 s per process/);
  });

  it("tells the model when/how to switch and to trust the latest tool result (M3)", () => {
    const p = buildSystemPrompt({ catalog }, realCaps);
    expect(p).toMatch(/switch_environment/);
    expect(p).toMatch(/project files.*follow you/i); // files follow the switch
    expect(p).toMatch(/change.*mid-run/i);
    expect(p).toMatch(/latest tool result/i);
  });

  it("states installs go through the gateway and apk is bake-time only", () => {
    const p = buildSystemPrompt({ catalog }, realCaps);
    expect(p).toMatch(/package gateway/i);
    expect(p).toMatch(/apk/);
    expect(p).toMatch(/baked|bake/i);
  });

  it("appends the catalog to the simulated browser prompt too", () => {
    const p = buildSystemPrompt({ catalog }, caps); // caps.realOs === false
    expect(p).toMatch(/simulated.*browser-native/i);
    expect(p).toMatch(/ENVIRONMENTS & PACKAGES/);
    expect(p).toMatch(/switch_environment/);
  });

  it("omits the catalog section entirely when no catalog is supplied (back-compat)", () => {
    expect(buildSystemPrompt({}, realCaps)).not.toMatch(/ENVIRONMENTS & PACKAGES/);
    expect(buildSystemPrompt({ languages: ["python"] }, caps)).not.toMatch(/ENVIRONMENTS & PACKAGES/);
  });
});

describe("Erdou environment orientation (both kernels)", () => {
  const realCaps: RuntimeCapabilities = { ...caps, realOs: true, interpreters: ["python3"], packageManagers: ["pip"], networkEgress: "cors-only" };
  for (const [name, c] of [["simulated", caps], ["real OS", realCaps]] as const) {
    it(`${name}: orients the agent to Erdou + the preview 0.0.0.0/relative-URL rule + the ERDOU.md instruction`, () => {
      const p = buildSystemPrompt({}, c);
      expect(p).toContain("ABOUT ERDOU");
      expect(p).toMatch(/browser-first agent OS/i);
      expect(p).toMatch(/bind 0\.0\.0\.0/); // the preview rule that bit users
      expect(p).toMatch(/RELATIVE asset URLs/i);
      expect(p).toContain("ERDOU.md"); // maintain-the-notes instruction
      expect(p).toMatch(/Project adaptations/); // the section the agent extends
    });

    it(`${name}: orients the agent to the delegate tool honestly (independent subtasks, different files)`, () => {
      const p = buildSystemPrompt({}, c);
      expect(p).toMatch(/When a delegate tool is available/);
    expect(p).toMatch(/When the preview observation tools are available/);
      expect(p).toMatch(/isolated copy of the project/i);
      expect(p).toMatch(/DIFFERENT files/);
    });
  }
});

describe("ERDOU_MD_TEMPLATE", () => {
  it("is a seedable intro with an empty Project adaptations section", () => {
    expect(ERDOU_MD_TEMPLATE).toContain("# Running in Erdou");
    expect(ERDOU_MD_TEMPLATE).toContain("## Project adaptations");
    expect(ERDOU_MD_TEMPLATE).toContain("0.0.0.0");
    expect(ERDOU_MD_TEMPLATE).toContain("(none yet)");
  });
});
