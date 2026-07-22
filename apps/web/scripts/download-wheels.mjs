// Ensure the pinned document-editing wheels exist in public/wheels/ (gitignored),
// byte-identical to the sha256 pins in wheels.json. The browser kernel's pip
// installs the document libs (python-pptx / python-docx / openpyxl / fpdf2 +
// their pure-Python dependency closure) from these same-origin wheels — offline,
// version-locked. Native deps (lxml/Pillow) are NOT bundled; Pyodide provides
// them. Mirrors runtime-vm's download-assets.mjs: present -> sha256-verify;
// missing -> fetch to a temp file, verify, atomic-rename; mismatch -> fail loud
// (public/wheels/ never holds unverified bytes). Idempotent + zero-dep (Node>=22).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "wheels.json"), "utf8"));
const dir = path.join(root, "public", "wheels");
fs.mkdirSync(dir, { recursive: true });

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function ensure({ file, url, sha256: want }) {
  if (!want) throw new Error(`E_WHEEL_PIN: no sha256 pinned for ${file} in wheels.json`);
  const dest = path.join(dir, file);
  if (fs.existsSync(dest)) {
    const got = sha256(fs.readFileSync(dest));
    if (got !== want) {
      throw new Error(
        `E_WHEEL_HASH: staged ${file} does not match its pin — expected ${want}, got ${got}. ` +
          `Delete public/wheels/${file} and re-run to re-download.`,
      );
    }
    return "verified";
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`E_WHEEL_FETCH: ${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) {
    throw new Error(`E_WHEEL_HASH: download ${url} does not match the pin — expected ${want}, got ${got} (${buf.length} bytes). Not written.`);
  }
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return "downloaded";
}

const entries = Object.values(manifest.wheels);
let downloaded = 0;
let verified = 0;
for (const e of entries) {
  const result = await ensure(e);
  if (result === "downloaded") {
    downloaded++;
    console.log(`  downloaded ${e.file}`);
  } else {
    verified++;
  }
}
console.log(`wheels: ${verified} verified, ${downloaded} downloaded, ${entries.length} total -> ${path.relative(root, dir)}/`);
