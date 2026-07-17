// Bake self-contained Alpine machine states, one per Round-13 profile
// (base/node/sci). Verified end-to-end across Spikes A/B/C + S2 (multi-profile
// trial bakes: community repo, ~31-39s walls, memoryMB=512 holds for all
// three). Run: `pnpm --filter @erdou/runtime-vm bake --profile <p>` or `--all`
// (needs network for Alpine + the assets from download-assets). Produces
// assets/state-<profile>.zst + state-<profile>.meta.json.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
// @ts-ignore
import { V86 } from "v86";
import { fetchBuf, parseApkIndex, resolve, installApks, unpackMinirootfs } from "./lib/apk.mjs";
import { setupSplitFs, GUEST_SETUP_CMD, PYCACHE_WARMUP_CMD, REMOUNT_RO_CMD, LAUNCH_GUESTD_CMD } from "./lib/preload.mjs";

// Canonical per-profile data (package roots + the version string stamped into
// each meta). Single source shared with src/profiles.ts — this script is plain
// Node and cannot import the .ts, so it reads the JSON directly. Browser-side
// loaders fail-fast when a state's stamped version/profile doesn't match the
// per-profile expectation, so version bumps happen in profiles.data.json only.
const PROFILES = JSON.parse(fs.readFileSync(new URL("../src/profiles.data.json", import.meta.url), "utf8"));

const args = process.argv.slice(2);
const known = Object.keys(PROFILES);
let selected;
if (args.length === 1 && args[0] === "--all") selected = known;
else if (args.length === 2 && args[0] === "--profile" && known.includes(args[1])) selected = [args[1]];
else {
  console.error(`usage: bake-image.mjs --profile <${known.join("|")}> | --all`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const tmp = path.join(here, "..", ".bake-tmp");
fs.mkdirSync(tmp, { recursive: true });

const m = JSON.parse(fs.readFileSync(path.join(assets, "manifest.json"), "utf8"));
const cdn = m.alpine.cdn, ver = m.alpine.version, arch = m.alpine.arch;
const branch = "v" + ver.split(".").slice(0, 2).join(".");
const repoUrl = (repo) => `${cdn}/${branch}/${repo}/${arch}`;

console.log(`1/6 fetch minirootfs + APKINDEX (main+community) — profiles: ${selected.join(", ")}`);
const mini = await fetchBuf(`${cdn}/${branch}/releases/${arch}/${m.alpine.minirootfs}`);
// main parsed first: resolve() gives the first name registration precedence,
// matching apk's /etc/apk/repositories order. npm / py3-numpy / py3-pandas
// (+ their openblas/py3-tzdata deps) are community-only (S2 C1).
const index = [
  ...(await parseApkIndex(await fetchBuf(`${repoUrl("main")}/APKINDEX.tar.gz`), path.join(tmp, "idx-main"), "main")),
  ...(await parseApkIndex(await fetchBuf(`${repoUrl("community")}/APKINDEX.tar.gz`), path.join(tmp, "idx-community"), "community")),
];

// EXACT ArrayBuffer: Node's readFileSync may return a POOLED Buffer at a
// non-zero byteOffset for small files (<4 KB), so `.buffer` would hand v86 the
// wrong bytes with no error. new Uint8Array(buf) copies into a fresh 0-offset
// ArrayBuffer. (Verified-spike form was { url }; this is the buffer equivalent.)
const ab = (p) => new Uint8Array(fs.readFileSync(p)).buffer;
// v86's ESM build has no CommonJS __dirname, so its default wasm lookup falls
// back to a CWD-relative "build/v86.wasm" (fine for the spikes, which ran with
// that as their cwd; not fine for a monorepo script run from the repo root) —
// point it at the installed package's own build/ dir instead.
const wasmDir = path.dirname(fileURLToPath(import.meta.resolve("v86")));

async function bakeProfile(profile) {
  const { version, packages } = PROFILES[profile];
  const rootfs = path.join(tmp, `rootfs-${profile}`);
  fs.rmSync(rootfs, { recursive: true, force: true }); // no leftovers from other profiles/runs
  unpackMinirootfs(mini, rootfs, tmp);
  const { order, missing } = resolve(index, packages);
  if (missing.length) console.warn("unresolved (assumed provided by base):", missing);

  console.log(`[${profile}] 2/6 install ${order.length} apks (dl=${(order.reduce((a, p) => a + p.size, 0) / 1048576).toFixed(1)} MiB)`);
  await installApks(order, (p) => repoUrl(p.repo), rootfs, tmp);

  console.log(`[${profile}] 3/6 boot buildroot + preload split FS`);
  const emulator = new V86({
    wasm_path: path.join(wasmDir, "v86.wasm"),
    bios: { buffer: ab(path.join(assets, "seabios.bin")) },
    vga_bios: { buffer: ab(path.join(assets, "vgabios.bin")) },
    bzimage: { buffer: ab(path.join(assets, "kernel.bin")) },
    memory_size: m.memoryMB * 1024 * 1024,
    filesystem: {},
    virtio_console: true,
    net_device: { relay_url: "fetch", type: "virtio" }, // Round 12: virtio NIC baked into the saved device set
    autostart: false,
    disable_keyboard: true,
    cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
  });
  await new Promise((r) => emulator.add_listener("emulator-ready", r));
  await setupSplitFs(emulator.fs9p, rootfs, path.join(here, "..", "src", "guest", "guestd.py"), path.join(here, "..", "src", "guest", "ptybridge.py"));
  emulator.run();

  console.log(`[${profile}] 4/6 drive guest chroot/bind setup over serial`);
  let sbuf = "";
  // ONE persistent listener + a window-scoped waiter list (verified spike C
  // pattern, q4-guestd.mjs's mkWait/waiters). Adaptation: the brief's version
  // called `emulator.add_listener("serial0-output-byte", ...)` freshly inside
  // EVERY serialWait() call, stacking a new listener per wait with no removal —
  // after N waits, N listeners each append the same incoming byte to `sbuf`,
  // so the buffer (and therefore every marker search) sees bytes duplicated N
  // times. Confirmed empirically: the first bake run timed out waiting for
  // SETUPDONE with a visibly byte-doubled tail ("pprroocc" for "proc", etc.)
  // once a second serialWait() had been called. Fixed by registering the byte
  // listener once and resolving/timing-out via a shared waiter list instead.
  const waiters = [];
  emulator.add_listener("serial0-output-byte", (b) => {
    sbuf += String.fromCharCode(b);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (sbuf.indexOf(waiters[i].marker, waiters[i].start) !== -1) {
        clearTimeout(waiters[i].timeout);
        waiters.splice(i, 1)[0].resolve();
      }
    }
  });
  const serialWait = (marker, timeoutMs = 120000) => new Promise((resolve, reject) => {
    const start = sbuf.length;
    const timeout = setTimeout(() => reject(new Error(`bake[${profile}]: serial timeout waiting for ${marker}; tail=${JSON.stringify(sbuf.slice(-300))}`)), timeoutMs);
    waiters.push({ marker, start, timeout, resolve });
  });
  await serialWait("~% ");                       // buildroot prompt (9p auto-mounted at /mnt via fstab)
  const sh = (cmd, marker, t) => { emulator.serial0_send(cmd + "\n"); return serialWait(marker, t); };
  // NOTE: GUEST_SETUP_CMD/PYCACHE_WARMUP_CMD/REMOUNT_RO_CMD/LAUNCH_GUESTD_CMD each
  // already end with their own quote-split "echo MARKER" (e.g. "SETUPD''ONE") —
  // the marker text below is the REAL command-output string to search for, not
  // literal text we're appending to the command (see preload.mjs's comment: an
  // unsplit marker embedded in the sent command would self-match on the guest
  // tty's echo of the typed line, before the command actually runs).
  await sh(GUEST_SETUP_CMD, "SETUPDONE"); console.log("  marker: SETUPDONE (bind mounts + proc/dev/tmp)");
  // Baked guest config (S1 §2 / S3 §3): the image has no /etc or /root at all.
  // resolv.conf points musl at the fetch-NAT's DNS (without it every lookup
  // hits 127.0.0.1); pip.conf pins the http index + trusted hosts + PEP-668
  // override (pypi 403s plain http, the egress shim upgrades it); .npmrc (npm
  // profiles only) pins the http registry (npmjs 301s http→https itself).
  // All land inside the chroot root (= the 9p workspace) → present every boot.
  const wantNpmrc = packages.includes("npm");
  await sh(
    "mkdir -p /mnt/workspace/etc /mnt/workspace/root; " +
    "printf 'nameserver 192.168.86.1\\n' > /mnt/workspace/etc/resolv.conf; " +
    "printf '[global]\\nindex-url = http://pypi.org/simple/\\ntrusted-host = pypi.org\\n    files.pythonhosted.org\\nbreak-system-packages = true\\n' > /mnt/workspace/etc/pip.conf; " +
    (wantNpmrc ? "printf 'registry=http://registry.npmjs.org/\\n' > /mnt/workspace/root/.npmrc; " : "") +
    "echo CFGD''ONE",
    "CFGDONE");
  console.log(`  marker: CFGDONE (resolv.conf + pip.conf${wantNpmrc ? " + .npmrc" : ""} baked)`);
  await sh(PYCACHE_WARMUP_CMD, "WARMED"); console.log("  marker: WARMED (pycache warmed, rw)");         // warm pycache into sys-root (rw) once
  await sh(REMOUNT_RO_CMD, "ROREADY"); console.log("  marker: ROREADY (system view frozen read-only)");            // freeze system view read-only
  await sh(LAUNCH_GUESTD_CMD, "GDLAUNCHED"); console.log("  marker: GDLAUNCHED (resident guestd launched)");      // resident guestd inside the workspace chroot
  // 4.5/6 networking, baked into the saved state so restores need ZERO per-boot
  // setup: eth0 up + DHCP (192.168.86.100 via v86's fetch NAT) AND loopback up
  // (a lo left down bakes an image where 127.0.0.1 servers die EADDRNOTAVAIL).
  // Guest-side grep emits quote-split success/failure markers (same convention
  // as BINDFAIL/ROFAIL) and the host ASSERTS them: a silent DHCP or lo failure
  // fails the bake loudly instead of shipping a broken-networking image.
  const netStart = sbuf.length;
  await sh(
    "ip link set eth0 up; udhcpc -i eth0 -n -q 2>&1; " +
    "ip -o addr show eth0 | grep -q 192.168.86.100 && echo ETH_O''K || echo ETH_F''AIL; " +
    "ip addr add 127.0.0.1/8 dev lo 2>&1; ip link set lo up 2>&1; " +
    "ip -o link show lo | grep -q ,UP && echo LO_O''K || echo LO_F''AIL; " +
    "echo NETD''ONE",
    "NETDONE", 30000);
  const netOut = sbuf.slice(netStart);
  if (!netOut.includes("ETH_OK")) throw new Error(`bake[${profile}]: eth0 did not get the NAT address 192.168.86.100 (silent DHCP failure) — refusing to save a broken-networking state; serial tail=${JSON.stringify(netOut.slice(-400))}`);
  if (!netOut.includes("LO_OK")) throw new Error(`bake[${profile}]: loopback (lo) did not come up — refusing to save; serial tail=${JSON.stringify(netOut.slice(-400))}`);
  console.log("  marker: NETDONE (asserted: eth0=192.168.86.100 via DHCP, lo up)");

  // 4.75/6 pre-save_state smokes: config markers (cheap greps that catch bake
  // typos before the expensive save) + per-profile interpreter smokes. Markers
  // follow the quote-split convention above; the host asserts <NAME>_OK.
  // First runs are slow under x86 emulation: pip --version ~25-27s, the sci
  // numpy+pandas import ~54s (per-process C-extension load, S2 C3).
  const smoke = async (name, cmd, timeoutMs = 180000) => {
    const start = sbuf.length;
    await sh(`${cmd} && echo ${name}_O''K || echo ${name}_F''AIL; echo ${name}_D''ONE`, `${name}_DONE`, timeoutMs);
    if (!sbuf.slice(start).includes(`${name}_OK`)) throw new Error(`bake[${profile}]: smoke ${name} failed (${cmd}) — refusing to save; serial tail=${JSON.stringify(sbuf.slice(-400))}`);
    console.log(`  marker: ${name}_OK`);
  };
  await smoke("RESOLV", "grep -q 192.168.86.1 /mnt/workspace/etc/resolv.conf", 30000);
  await smoke("PIPCONF", "grep -q break-system-packages /mnt/workspace/etc/pip.conf", 30000);
  if (wantNpmrc) await smoke("NPMRC", "grep -q registry.npmjs.org /mnt/workspace/root/.npmrc", 30000);
  // the shipped guestd must set HOME=/root in its exec env (pip user-site/npm need it)
  await smoke("HOMESET", 'grep -q "HOME.*root" /mnt/workspace/usr/lib/erdou/guestd.py', 30000);
  if (packages.includes("py3-pip")) await smoke("PIP", "chroot /mnt/workspace /usr/bin/pip --version");
  if (packages.includes("nodejs")) await smoke("NODE", "chroot /mnt/workspace /usr/bin/node --version");
  if (packages.includes("npm")) await smoke("NPM", "chroot /mnt/workspace /usr/bin/npm --version");
  if (packages.includes("py3-pandas")) await smoke("SCI", "chroot /mnt/workspace /usr/bin/python3 -c 'import numpy, pandas'", 300000);
  await new Promise((r) => setTimeout(r, 1500));  // let guestd reach its read loop

  console.log(`[${profile}] 5/6 save_state (self-contained: 9p FS rides inside)`);
  const state = new Uint8Array(await emulator.save_state());
  await emulator.destroy();

  console.log(`[${profile}] 6/6 zstd-compress → assets/state-${profile}.zst`);
  // gzip is fine for the MVP if zstd bindings aren't present; keep the extension honest.
  const compressed = zlib.gzipSync(state, { level: 9 });
  fs.writeFileSync(path.join(assets, `state-${profile}.zst`), compressed);
  fs.writeFileSync(path.join(assets, `state-${profile}.meta.json`), JSON.stringify({ version, profile, rawBytes: state.length, compressedBytes: compressed.length, alpine: ver, codec: "gzip", net: true, packages, closure: order.length }, null, 2));
  // assets.ts decompresses state-<profile>.zst -> state-<profile>.bin and
  // caches it (only writes if absent). Drop the stale cache now so a rebake's
  // new state.zst is the one that actually gets loaded.
  fs.rmSync(path.join(assets, `state-${profile}.bin`), { force: true });
  console.log(`[${profile}] done: ${version} — state ${state.length} -> ${compressed.length} bytes (assets/state-${profile}.zst)`);
}

for (const profile of selected) await bakeProfile(profile);
process.exit(0);
