// Environments catalog — the single app-side source of truth for what each
// execution environment is, consumed by the kernel selector (options), the
// switch_environment tool schema, AgentOptions.environment, and (as prose)
// docs/help.md. VM entries are DERIVED from runtime-vm's profiles.data.json —
// the data JSON, not the TS profiles module, so this file stays out of the
// v86 bundle graph (kernel.ts documents the barrel-import bundle trap).
import profilesData from "../../../../packages/runtime-vm/src/profiles.data.json";

export type VmProfileId = "base" | "node" | "sci";
export type EnvironmentId = "browser" | `vm:${VmProfileId}`;

export interface EnvironmentDescriptor {
  readonly id: EnvironmentId;
  readonly kernel: "browser" | "vm";
  /** VM profile id; undefined on the browser kernel. */
  readonly profile?: VmProfileId;
  readonly label: string;
  /** Human-readable speed class shown in help + switch guidance. */
  readonly speed: string;
  readonly interpreters: readonly string[];
  readonly packageManagers: readonly string[];
  /** One line per supported install path. */
  readonly installRecipes: readonly string[];
  /** When to pick this environment (help + tool schema descriptions). */
  readonly switchGuidance: string;
  /** Baked image version; undefined on the browser kernel. */
  readonly version?: string;
}

const VM_SPEED = "slow — emulated x86, roughly 10-100x slower than native";

// Runtime install recipes per package manager (apk is bake-time only).
const INSTALL_RECIPES: Record<string, string> = {
  pip: "pip install <package> — via the package gateway, ~40 s for a small package; persists in the project (/root/.local user-site). Prefer user-site over venv: a venv adds ~1.5k files to every snapshot.",
  npm: "npm install <package> — via the package gateway, ~30 s for a small package; persists in the project (node_modules).",
  apk: "apk packages are baked into the image, not installed at runtime — switch to a profile that already includes what you need.",
};

const SWITCH_GUIDANCE: Record<VmProfileId, string> = {
  base: "Smallest Linux VM. Real Alpine shell with Python + pip. Pick when you need a real Linux but not Node.js or the scientific stack.",
  node: "Alpine with Node.js + npm (plus Python + pip). Pick for JavaScript/Node projects or when npm installs are needed.",
  sci: "Alpine with NumPy + Pandas preinstalled (plus pip). Slower than the browser kernel — first `import pandas` takes ~50 s per process — so prefer the browser kernel for NumPy/Pandas; pick this only when you need installs to persist across reloads or a package Pyodide doesn't provide.",
};

function vmDescriptor(profile: VmProfileId): EnvironmentDescriptor {
  const meta = profilesData[profile];
  return {
    id: `vm:${profile}`,
    kernel: "vm",
    profile,
    label: `Linux VM · ${meta.label}`,
    speed: VM_SPEED,
    interpreters: meta.interpreters,
    packageManagers: meta.packageManagers,
    installRecipes: meta.packageManagers.map((pm) => {
      const recipe = INSTALL_RECIPES[pm];
      if (!recipe) throw new Error(`environments: no install recipe for package manager "${pm}" (profile ${profile})`);
      return recipe;
    }),
    switchGuidance: SWITCH_GUIDANCE[profile],
    version: meta.version,
  };
}

export const ENVIRONMENTS: readonly EnvironmentDescriptor[] = [
  {
    id: "browser",
    kernel: "browser",
    label: "Browser kernel",
    speed: "instant — starts in milliseconds, runs at native browser speed",
    interpreters: ["python (Pyodide)", "wasi"],
    packageManagers: ["pip (Pyodide wheels + micropip)"],
    installRecipes: [
      "pip install <package> — Pyodide prebuilt wheels (NumPy/Pandas/SciPy/lxml/Pillow…) load natively via loadPackage, plus pure-Python PyPI wheels via micropip. The document libraries (python-pptx, python-docx, openpyxl, fpdf2) are pre-bundled: their own wheels install from Erdou's origin, version-locked, with no PyPI round-trip (openpyxl is pure-Python; the others still pull lxml/Pillow from the Pyodide CDN). Installs are session-only (reset on page reload).",
    ],
    switchGuidance:
      "Default, and the right home for most Python — including NumPy/Pandas, which run natively here. Fastest start, no real Linux. Switch to a Linux VM only for a real shell, npm, a package with native code Pyodide lacks, or installs that must persist across reloads.",
  },
  vmDescriptor("base"),
  vmDescriptor("node"),
  vmDescriptor("sci"),
];

export function environmentById(id: string): EnvironmentDescriptor {
  const env = ENVIRONMENTS.find((e) => e.id === id);
  if (!env) throw new Error(`environments: unknown environment id "${id}" (known: ${ENVIRONMENTS.map((e) => e.id).join(", ")})`);
  return env;
}

export interface EnvironmentOption {
  readonly value: EnvironmentId;
  readonly label: string;
  readonly disabled?: boolean;
  readonly hint?: string;
}

/** Pure selector-options mapper: VM profiles missing from `presentProfiles`
 *  (the linked-assets manifest, /vm-assets/profiles.json) come back disabled
 *  with a bake hint. The component consuming this stays a dumb renderer. */
export function environmentOptions(
  catalog: readonly EnvironmentDescriptor[],
  presentProfiles: readonly string[],
): EnvironmentOption[] {
  return catalog.map((env) => {
    if (env.kernel === "vm" && env.profile !== undefined && !presentProfiles.includes(env.profile)) {
      return {
        value: env.id,
        label: env.label,
        disabled: true,
        hint: `image not baked — run: pnpm --filter @erdou/runtime-vm bake --profile ${env.profile}`,
      };
    }
    return { value: env.id, label: env.label };
  });
}
