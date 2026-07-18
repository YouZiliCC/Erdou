// Ensure-one-asset logic for download-assets.mjs (plain JS in scripts/lib so
// the script can import it without tsx; hermetic tests live in
// src/download-assets.test.ts because vitest only collects src/**).
//
// Contract (one correct path, fail fast):
// - dest present  -> sha256-verify in place. Mismatch throws E_ASSET_HASH with
//   both hashes; the staged file is LEFT for inspection (delete it + re-run to
//   re-download from the pinned URL).
// - dest missing  -> fetch the pinned url, write to `${dest}.tmp` (same dir, so
//   the rename into place is atomic), verify sha256. Mismatch deletes the temp
//   and throws E_ASSET_HASH with both hashes; dest is never created from bad
//   bytes. Missing url / non-2xx fetch throw E_ASSET_URL / E_ASSET_FETCH.
// Idempotent: after a green run the next run takes the verify branch only.
import fs from "node:fs";
import crypto from "node:crypto";

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * @param {{ dest: string, url?: string, sha256: string }} blob
 * @returns {Promise<"verified" | "downloaded">}
 */
export async function ensureAsset({ dest, url, sha256 }) {
  if (!sha256) throw new Error(`E_ASSET_PIN: no sha256 pinned for ${dest} in assets/manifest.json — refusing to fetch unpinned bytes`);
  if (fs.existsSync(dest)) {
    const got = sha256Hex(fs.readFileSync(dest));
    if (got !== sha256) {
      throw new Error(
        `E_ASSET_HASH: staged ${dest} does not match its manifest pin — expected sha256 ${sha256}, got ${got}. ` +
        `File left in place for inspection; delete it and re-run to re-download from the pinned URL.`
      );
    }
    return "verified";
  }
  if (!url) {
    throw new Error(
      `E_ASSET_URL: ${dest} is missing and assets/manifest.json pins no url for it — ` +
      `fill the url (see the manifest's source note) or stage the verified blob manually.`
    );
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`E_ASSET_FETCH: ${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, buf);
  const got = sha256Hex(buf);
  if (got !== sha256) {
    fs.rmSync(tmp);
    throw new Error(
      `E_ASSET_HASH: download ${url} does not match the manifest pin — expected sha256 ${sha256}, got ${got} ` +
      `(${buf.length} bytes). Temp deleted; ${dest} was not created.`
    );
  }
  fs.renameSync(tmp, dest);
  return "downloaded";
}
