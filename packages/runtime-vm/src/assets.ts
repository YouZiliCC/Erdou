import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { V86Assets } from "./v86-host.js";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const files = ["kernel.bin", "seabios.bin", "vgabios.bin", "state.zst"];

export function assetsPresent(): boolean {
  return files.every((f) => existsSync(join(assetsDir, f)));
}

/** Decompress state.zst to a sibling state.bin path v86 can load, then return the asset paths. */
export function defaultAssets(): V86Assets {
  const statePath = join(assetsDir, "state.bin");
  if (!existsSync(statePath)) {
    const meta = JSON.parse(readFileSync(join(assetsDir, "state.meta.json"), "utf8")) as { codec: string };
    if (meta.codec !== "gzip") throw new Error(`unknown state codec ${meta.codec}`);
    writeFileSync(statePath, gunzipSync(readFileSync(join(assetsDir, "state.zst"))));
  }
  return {
    biosPath: join(assetsDir, "seabios.bin"),
    vgaBiosPath: join(assetsDir, "vgabios.bin"),
    kernelPath: join(assetsDir, "kernel.bin"),
    statePath,
    memoryMB: 512,
  };
}
