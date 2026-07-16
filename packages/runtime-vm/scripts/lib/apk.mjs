// Resolve python3's transitive deps from APKINDEX and extract the .apk payloads
// into a rootfs dir. Verified in Spike B (18 packages, python3 -> 42).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Parse APKINDEX.tar.gz into a list of {name, version, provides[], depends[], apk}. */
export async function parseApkIndex(indexBuf, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "APKINDEX.tar.gz"), indexBuf);
  execFileSync("tar", ["-xzf", "APKINDEX.tar.gz", "APKINDEX"], { cwd: tmpDir });
  const text = fs.readFileSync(path.join(tmpDir, "APKINDEX"), "utf8");
  const pkgs = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const f = {};
    for (const line of block.split("\n")) { const k = line[0]; f[k] = (f[k] ? f[k] + "\n" : "") + line.slice(2); }
    if (!f.P) continue;
    pkgs.push({
      name: f.P, version: f.V,
      provides: (f.p ? f.p.split(" ") : []).map((s) => s.split(/[=<>]/)[0]),
      depends: (f.D ? f.D.split(" ") : []).filter((d) => !d.startsWith("!")).map((s) => s.replace(/^!/, "").split(/[=<>]/)[0]),
      apk: `${f.P}-${f.V}.apk`,
    });
  }
  return pkgs;
}

/** Resolve `root` + transitive deps against the provides map (so:… and bare names). */
export function resolve(pkgs, roots) {
  const byProvide = new Map();
  for (const p of pkgs) { byProvide.set(p.name, p); for (const pr of p.provides) if (!byProvide.has(pr)) byProvide.set(pr, p); }
  const order = [], seen = new Set(), missing = [];
  const visit = (dep) => {
    const p = byProvide.get(dep) ?? byProvide.get(dep.replace(/^so:/, "").replace(/^cmd:/, ""));
    if (!p) { if (!/^\/|^so:libc/.test(dep)) missing.push(dep); return; }
    if (seen.has(p.name)) return;
    seen.add(p.name);
    for (const d of p.depends) visit(d);
    order.push(p);
  };
  for (const r of roots) visit(r);
  return { order, missing };
}

/** Download + extract each .apk payload into rootfsDir (skips control dotfiles). */
export async function installApks(order, repoUrl, rootfsDir, tmpDir) {
  fs.mkdirSync(rootfsDir, { recursive: true });
  for (const p of order) {
    const buf = await fetchBuf(`${repoUrl}/${p.apk}`);
    const apkPath = path.join(tmpDir, p.apk);
    fs.writeFileSync(apkPath, buf);
    // an apk is a gzip'd tar; extract the payload, skip .PKGINFO/.SIGN.* and xattr keyword warnings
    execFileSync("tar", ["-xzf", apkPath, "-C", rootfsDir, "--exclude=.*", "--warning=no-unknown-keyword"], { stdio: "ignore" });
  }
}

export function unpackMinirootfs(buf, rootfsDir, tmpDir) {
  fs.mkdirSync(rootfsDir, { recursive: true });
  const p = path.join(tmpDir, "minirootfs.tar.gz");
  fs.writeFileSync(p, buf);
  execFileSync("tar", ["-xzf", p, "-C", rootfsDir], { stdio: "ignore" });
}
