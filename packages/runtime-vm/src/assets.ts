import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { V86BootInputs } from "./v86-host.js";
import type { VmProfile } from "./profiles.js";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
// kernel/bios are profile-agnostic; the state image is per-profile (state-<p>.zst).
const shared = ["kernel.bin", "seabios.bin", "vgabios.bin"];

export interface V86Assets {
  biosPath: string; vgaBiosPath: string; kernelPath: string; statePath: string; memoryMB: number;
  profile?: VmProfile;
}

// Per-profile state image: state-<profile>.zst, produced by
// `pnpm --filter @erdou/runtime-vm bake --profile <p>`. (The pre-R13 legacy
// single-image state.zst fallback was removed in T10 once the real profile
// bakes landed.)
function resolveStatePath(profile: VmProfile): string {
  return join(assetsDir, `state-${profile}.zst`);
}

export function assetsPresent(profile: VmProfile = "base"): boolean {
  return shared.every((f) => existsSync(join(assetsDir, f))) && existsSync(resolveStatePath(profile));
}

export function defaultAssets(profile: VmProfile = "base"): V86Assets {
  return {
    biosPath: join(assetsDir, "seabios.bin"),
    vgaBiosPath: join(assetsDir, "vgabios.bin"),
    kernelPath: join(assetsDir, "kernel.bin"),
    statePath: resolveStatePath(profile),
    memoryMB: 512,
    profile,
  };
}

const exactBuffer = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;

/** Node inputs loader: read files, gunzip the state image, resolve v86.wasm via the package. */
export async function loadNodeInputs(assets: V86Assets): Promise<V86BootInputs> {
  // BARE filesystem path — v86's Node loader does `fs.promises.readFile(wasm_path)`
  // (libv86.mjs). A file:// URL string ENOENTs there, the load rejects unhandled,
  // emulator-ready never fires → boot hangs. This is the exact value the shipped
  // pre-refactor code passed; keep it.
  const wasmUrl = join(dirname(createRequire(import.meta.url).resolve("v86")), "v86.wasm");
  const metaPath = assets.statePath.replace(/\.zst$/, ".meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { codec: string; profile?: string };
  if (meta.codec !== "gzip") throw new Error(`unknown state codec ${meta.codec} — expected gzip`);
  // Cross-linked asset guard: baked metas stamp their profile; refuse a state
  // whose stamped profile doesn't match the requested one.
  if (assets.profile && meta.profile && meta.profile !== assets.profile) {
    throw new Error(`${metaPath} is a "${meta.profile}" bake but profile "${assets.profile}" was requested — cross-linked assets; re-bake with \`pnpm --filter @erdou/runtime-vm bake --profile ${assets.profile}\``);
  }
  const stateGz = readFileSync(assets.statePath);
  return {
    bios: exactBuffer(readFileSync(assets.biosPath)),
    vgaBios: exactBuffer(readFileSync(assets.vgaBiosPath)),
    kernel: exactBuffer(readFileSync(assets.kernelPath)),
    state: exactBuffer(gunzipSync(stateGz)),
    wasmUrl,
    memoryMB: assets.memoryMB,
  };
}
