// Vite serves the v86 boot assets from public/vm-assets/ (symlinked by
// scripts/link-vm-assets.mjs). v86.wasm comes via a ?url asset import (Vite emits
// a hashed URL in the build). Per-profile versions come from PROFILE_META
// (profiles.data.json — the single source, also read by bake-image.mjs): they
// key the IndexedDB state cache AND are passed as expectedStateVersion so
// loadBrowserInputs fail-fasts on a stale/cross-linked on-disk state image
// instead of caching old bytes under the new key.
// Subpath import ONLY — the barrel drags ~700KB of v86 into the main bundle.
import wasmUrl from "v86/build/v86.wasm?url";
import { PROFILE_META, type VmProfile } from "@erdou/runtime-vm/profiles";

export function vmAssets(profile: VmProfile = "base"): {
  baseUrl: string; wasmUrl: string; profile: VmProfile; version: string; expectedStateVersion: string;
} {
  const version = PROFILE_META[profile].version;
  return { baseUrl: "/vm-assets", wasmUrl, profile, version, expectedStateVersion: version };
}
