// Resolve profile roots' transitive deps from APKINDEX (main + community) and
// extract the .apk payloads into a rootfs dir. Verified in Spike B (18
// packages, python3 -> 42) and Spike S2 (multi-profile closures incl.
// community-only npm/py3-numpy/py3-pandas).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Parse APKINDEX text into a list of {name, version, repo, size, provides[], depends[], apk}.
 * Pure (hermetically tested in src/bake-apk.test.ts). Version constraints use
 * =/</>/~ — all must be stripped: a missed separator (S2 C2: `python3~3.14`)
 * leaves the dep unresolvable and silently DROPS it from the closure.
 */
export function parseApkIndexText(text, repo) {
  const pkgs = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const f = {};
    for (const line of block.split("\n")) { const k = line[0]; f[k] = (f[k] ? f[k] + "\n" : "") + line.slice(2); }
    if (!f.P) continue;
    pkgs.push({
      name: f.P, version: f.V, repo, size: parseInt(f.S ?? "0", 10),
      provides: (f.p ? f.p.split(" ") : []).map((s) => s.split(/[=<>~]/)[0]),
      depends: (f.D ? f.D.split(" ") : []).filter((d) => !d.startsWith("!")).map((s) => s.split(/[=<>~]/)[0]),
      apk: `${f.P}-${f.V}.apk`,
    });
  }
  return pkgs;
}

/** Untar APKINDEX.tar.gz into tmpDir (unique per repo!) and parse it, stamping `repo` on each package. */
export async function parseApkIndex(indexBuf, tmpDir, repo) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "APKINDEX.tar.gz"), indexBuf);
  execFileSync("tar", ["-xzf", "APKINDEX.tar.gz", "APKINDEX"], { cwd: tmpDir });
  return parseApkIndexText(fs.readFileSync(path.join(tmpDir, "APKINDEX"), "utf8"), repo);
}

/**
 * Resolve `roots` + transitive deps against the provides map (so:… and bare
 * names). Names are registered before provides (a real package beats another
 * package's alias), first occurrence wins — so a main-then-community merged
 * list gets apk's repo-order precedence.
 */
export function resolve(pkgs, roots) {
  const byProvide = new Map();
  for (const p of pkgs) if (!byProvide.has(p.name)) byProvide.set(p.name, p);
  for (const p of pkgs) for (const pr of p.provides) if (!byProvide.has(pr)) byProvide.set(pr, p);
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

/**
 * Download + extract each .apk payload into rootfsDir (skips control dotfiles).
 * `repoUrlFor(pkg)` maps a package to its repo's base URL — main and community
 * host different packages, so the URL is per-package.
 */
export async function installApks(order, repoUrlFor, rootfsDir, tmpDir) {
  fs.mkdirSync(rootfsDir, { recursive: true });
  for (const p of order) {
    const buf = await fetchBuf(`${repoUrlFor(p)}/${p.apk}`);
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
