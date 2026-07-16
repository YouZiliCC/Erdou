// Vite serves the v86 boot assets from public/vm-assets/ (symlinked by
// scripts/link-vm-assets.mjs). v86.wasm comes via a ?url asset import (Vite emits
// a hashed URL in the build). `version` keys the IndexedDB state cache; bump on
// a re-bake. (Derive from the asset's own hash later; a constant is fine now.)
import wasmUrl from "v86/build/v86.wasm?url";

export function vmAssets(): { baseUrl: string; wasmUrl: string; version: string } {
  return { baseUrl: "/vm-assets", wasmUrl, version: "alpine-3.24.1-r11b" };
}
