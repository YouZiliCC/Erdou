// Single source of truth for the VM image profiles. The DATA lives in
// profiles.data.json so plain-Node scripts (bake-image.mjs, link-vm-assets.mjs)
// can read the very same file; this module only adds the types. Exported as the
// `@erdou/runtime-vm/profiles` subpath — apps/web main-bundle code MUST import
// from here, never the barrel (which drags ~700KB of v86; guarded by
// index.browser-clean.test.ts). Imports ONLY the JSON — keep it that way.
import data from "./profiles.data.json";

export type VmProfile = "base" | "node" | "sci";

export interface VmProfileMeta {
  /** Cache/drift key — must equal the baked state-<profile>.meta.json version
   *  (bump both on re-bake; mismatch fail-fasts at boot via expectedStateVersion). */
  version: string;
  /** Leaf name only — presentation context is the consumer's (apps/web renders "Linux VM · <label>"). */
  label: string;
  /** apk root packages baked into the image. Every profile MUST include python3 —
   *  guestd.py/ptybridge.py are Python. */
  packages: string[];
  interpreters: string[];
  packageManagers: string[];
}

export const PROFILE_META: Record<VmProfile, VmProfileMeta> = data;

export const VM_PROFILES = Object.keys(PROFILE_META) as VmProfile[];
