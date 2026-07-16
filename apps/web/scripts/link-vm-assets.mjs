// Symlink the v86 boot assets into public/vm-assets/ so Vite serves them (dev)
// and dereferences them into the build. Targets are gitignored — this runs on
// predev/prebuild. Idempotent (ln -sfn).
import { mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public", "vm-assets");
const assetsDir = join(here, "..", "..", "..", "packages", "runtime-vm", "assets");
mkdirSync(pub, { recursive: true });
for (const f of ["kernel.bin", "seabios.bin", "vgabios.bin", "state.zst"]) {
  const target = join(assetsDir, f);
  const link = join(pub, f);
  if (!existsSync(target)) { console.warn(`[link-vm-assets] missing ${target} — run \`pnpm --filter @erdou/runtime-vm bake\``); continue; }
  try { rmSync(link, { force: true }); } catch {}
  symlinkSync(relative(pub, target), link);
}
console.log("[link-vm-assets] linked vm-assets");
