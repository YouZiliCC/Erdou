// Vite serves the v86 boot assets from public/vm-assets/ (symlinked by
// scripts/link-vm-assets.mjs). v86.wasm comes via a ?url asset import (Vite emits
// a hashed URL in the build). `version` keys the IndexedDB state cache; bump on
// a re-bake. (Derive from the asset's own hash later; a constant is fine now.)
import wasmUrl from "v86/build/v86.wasm?url";

// Must equal STATE_VERSION in packages/runtime-vm/scripts/bake-image.mjs (bump
// both on re-bake): passed as expectedStateVersion so loadBrowserInputs
// fail-fasts on a stale on-disk state.zst instead of caching old bytes under
// this key.
const VERSION = "alpine-3.24.1-r12-lo-baked";

export function vmAssets(): { baseUrl: string; wasmUrl: string; version: string; expectedStateVersion: string } {
  return { baseUrl: "/vm-assets", wasmUrl, version: VERSION, expectedStateVersion: VERSION };
}
