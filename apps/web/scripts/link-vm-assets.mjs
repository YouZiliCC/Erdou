// Symlink the v86 boot assets into public/vm-assets/ so Vite serves them (dev)
// and dereferences them into the build. Targets are gitignored — this runs on
// predev/prebuild. Idempotent (ln -sfn). Per-profile state images are linked
// when present (a partially-baked assets dir still serves what exists; an
// unbaked profile fails loudly at boot with the bake hint), and profiles.json
// records which profiles actually linked — the environment selector reads it.
import { mkdirSync, symlinkSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public", "vm-assets");
const assetsDir = join(here, "..", "..", "..", "packages", "runtime-vm", "assets");
// Same single source as profiles.ts / bake-image.mjs (plain .mjs can't import TS).
const profiles = Object.keys(JSON.parse(readFileSync(
  join(here, "..", "..", "..", "packages", "runtime-vm", "src", "profiles.data.json"), "utf8",
)));
mkdirSync(pub, { recursive: true });

function link(f, hint) {
  const target = join(assetsDir, f);
  if (!existsSync(target)) { console.warn(`[link-vm-assets] missing ${target} — run \`${hint}\``); return false; }
  const l = join(pub, f);
  try { rmSync(l, { force: true }); } catch {}
  symlinkSync(relative(pub, target), l);
  return true;
}

for (const f of ["kernel.bin", "seabios.bin", "vgabios.bin"]) {
  link(f, "pnpm --filter @erdou/runtime-vm download-assets");
}
// state-<p>.meta.json must be served: loadBrowserInputs fetches it on cache miss
// to verify the bake version/profile (expectedStateVersion) before caching.
const present = profiles.filter((p) =>
  [`state-${p}.zst`, `state-${p}.meta.json`]
    .map((f) => link(f, `pnpm --filter @erdou/runtime-vm bake --profile ${p}`))
    .every(Boolean));
// Drop pre-R13 single-image links from earlier runs — nothing fetches them.
for (const f of ["state.zst", "state.meta.json"]) rmSync(join(pub, f), { force: true });
writeFileSync(join(pub, "profiles.json"), JSON.stringify(present));
console.log(`[link-vm-assets] linked vm-assets (profiles: ${present.join(", ") || "none baked yet"})`);
