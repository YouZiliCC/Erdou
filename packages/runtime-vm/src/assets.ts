import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { V86BootInputs } from "./v86-host.js";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const files = ["kernel.bin", "seabios.bin", "vgabios.bin", "state.zst"];

export interface V86Assets {
  biosPath: string; vgaBiosPath: string; kernelPath: string; statePath: string; memoryMB: number;
}

export function assetsPresent(): boolean {
  return files.every((f) => existsSync(join(assetsDir, f)));
}

export function defaultAssets(): V86Assets {
  return {
    biosPath: join(assetsDir, "seabios.bin"),
    vgaBiosPath: join(assetsDir, "vgabios.bin"),
    kernelPath: join(assetsDir, "kernel.bin"),
    statePath: join(assetsDir, "state.zst"),
    memoryMB: 512,
  };
}

const exactBuffer = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;

/** Node inputs loader: read files, gunzip state.zst, resolve v86.wasm via the package. */
export async function loadNodeInputs(assets: V86Assets): Promise<V86BootInputs> {
  // BARE filesystem path — v86's Node loader does `fs.promises.readFile(wasm_path)`
  // (libv86.mjs). A file:// URL string ENOENTs there, the load rejects unhandled,
  // emulator-ready never fires → boot hangs. This is the exact value the shipped
  // pre-refactor code passed; keep it.
  const wasmUrl = join(dirname(createRequire(import.meta.url).resolve("v86")), "v86.wasm");
  const meta = JSON.parse(readFileSync(join(assets.statePath, "..", "state.meta.json"), "utf8")) as { codec: string };
  if (meta.codec !== "gzip") throw new Error(`unknown state codec ${meta.codec} — expected gzip`);
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
