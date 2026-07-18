// Ensure the pinned kernel + BIOS blobs exist in assets/ (gitignored), byte-
// identical to the sha256 pins in assets/manifest.json — makes a fresh clone
// able to bake without any manual staging. Per blob (see lib/ensure-asset.mjs):
// - present -> sha256-verified in place (mismatch fails loudly with both
//   hashes, file kept for inspection);
// - missing -> downloaded from the manifest's pinned url to a temp name,
//   sha256-verified, atomically renamed into place (bad bytes delete the temp
//   and fail with both hashes — assets/ never holds an unverified blob).
// Idempotent: a green run leaves the next run with nothing but verifies.
//
// Provenance of the pins (each URL fetched + hash-matched on 2026-07-18):
// - kernel.bin  = v86's buildroot bzImage (9p+virtio), buildroot-bzimage68.bin
//   on the v86 project's asset host i.copy.sh (no commit-addressed URL exists
//   there; the sha256 pin is the integrity anchor).
// - seabios.bin / vgabios.bin = copy/v86 repo bios/ build assets, pinned by
//   immutable commit SHA (2f1346b0…, master at pin time; bytes last changed
//   2023-08-06 in b8a39b11…).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAsset } from "./lib/ensure-asset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const manifest = JSON.parse(fs.readFileSync(path.join(assets, "manifest.json"), "utf8"));

const blobs = [
  { dest: path.join(assets, manifest.kernel.file), url: manifest.kernel.url, sha256: manifest.kernel.sha256 },
  { dest: path.join(assets, manifest.bios.seabios), url: manifest.bios.seabiosUrl, sha256: manifest.bios.seabiosSha256 },
  { dest: path.join(assets, manifest.bios.vgabios), url: manifest.bios.vgabiosUrl, sha256: manifest.bios.vgabiosSha256 },
];
for (const blob of blobs) {
  const action = await ensureAsset(blob);
  console.log(`${action} ${path.basename(blob.dest)} (${fs.statSync(blob.dest).size} bytes, sha256 ${blob.sha256})`);
}
console.log("assets ready");
