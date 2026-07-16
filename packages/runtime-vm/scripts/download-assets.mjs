// Fetch the pinned kernel + BIOS blobs into assets/ (gitignored). Reads
// assets/manifest.json for the source locations; verifies sha256 when present.
//
// NOTE on regeneration: the kernel/BIOS blobs are the v86 buildroot bzImage +
// SeaBIOS/VGABIOS build assets verified across the R11 spikes (spike dirs
// a/b/c all used identical copies — buildroot-bzimage68.bin, seabios.bin,
// vgabios.bin). There is no stable public release URL pinned for them yet
// (see manifest.json's kernel.source / bios.source); until one is set, this
// script is a no-op if the three files are already staged in assets/ (as they
// are after a manual copy for the first bake) — it only fetches when a file is
// missing AND a manifest.*.url is configured. Fill manifest.kernel.url +
// manifest.bios.seabiosUrl/vgabiosUrl (a release attachment or the team's
// asset store) to make this script able to (re)fetch from scratch.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const manifest = JSON.parse(fs.readFileSync(path.join(assets, "manifest.json"), "utf8"));

async function get(url, dest, sha256) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha256 && sha256 !== "<fill-from-download>") {
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`sha256 mismatch for ${dest}: expected ${sha256}, got ${got}`);
  }
  fs.writeFileSync(dest, buf);
  console.log(`wrote ${dest} (${buf.length} bytes)`);
}

const kernelDest = path.join(assets, "kernel.bin");
const seabiosDest = path.join(assets, "seabios.bin");
const vgabiosDest = path.join(assets, "vgabios.bin");

if (fs.existsSync(kernelDest) && fs.existsSync(seabiosDest) && fs.existsSync(vgabiosDest)) {
  console.log("assets already staged (kernel.bin, seabios.bin, vgabios.bin present) — skipping fetch.");
  console.log("To force a re-fetch, delete them and set manifest.kernel.url + bios.seabiosUrl/vgabiosUrl.");
  process.exit(0);
}

// NOTE: set manifest.kernel.url / manifest.bios.*.url to the pinned source your
// bake was verified against (a release attachment or the team asset store).
const kernelUrl = manifest.kernel.url;
const seabiosUrl = manifest.bios.seabiosUrl;
const vgabiosUrl = manifest.bios.vgabiosUrl;
if (!kernelUrl || !seabiosUrl || !vgabiosUrl) {
  throw new Error(
    "assets/manifest.json needs kernel.url + bios.seabiosUrl + bios.vgabiosUrl (pin your sources) — " +
    "or copy the three verified blobs into assets/ manually for a first bake (see manifest kernel/bios .source notes)."
  );
}
await get(kernelUrl, kernelDest, manifest.kernel.sha256);
await get(seabiosUrl, seabiosDest, manifest.bios.seabiosSha256);
await get(vgabiosUrl, vgabiosDest, manifest.bios.vgabiosSha256);
console.log("assets ready");
