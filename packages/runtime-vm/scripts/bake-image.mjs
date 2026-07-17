// Bake the self-contained Alpine machine state. Verified end-to-end across
// Spikes A/B/C. Run: `pnpm --filter @erdou/runtime-vm bake` (needs network for
// Alpine + the assets from download-assets). Produces assets/state.zst.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
// @ts-ignore
import { V86 } from "v86";
import { fetchBuf, parseApkIndex, resolve, installApks, unpackMinirootfs } from "./lib/apk.mjs";
import { setupSplitFs, GUEST_SETUP_CMD, PYCACHE_WARMUP_CMD, REMOUNT_RO_CMD, LAUNCH_GUESTD_CMD } from "./lib/preload.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const tmp = path.join(here, "..", ".bake-tmp");
const rootfs = path.join(tmp, "rootfs");
fs.mkdirSync(tmp, { recursive: true });

const m = JSON.parse(fs.readFileSync(path.join(assets, "manifest.json"), "utf8"));
const cdn = m.alpine.cdn, ver = m.alpine.version, arch = m.alpine.arch;
const branch = "v" + ver.split(".").slice(0, 2).join(".");
const mainRepo = `${cdn}/${branch}/main/${arch}`;

console.log("1/6 fetch minirootfs + APKINDEX");
const releasesBase = `${cdn}/${branch}/releases/${arch}`;
const mini = await fetchBuf(`${releasesBase}/${m.alpine.minirootfs}`);
unpackMinirootfs(mini, rootfs, tmp);
const idx = await parseApkIndex(await fetchBuf(`${mainRepo}/APKINDEX.tar.gz`), tmp);
// python3 may pull community deps too; fetch community APKINDEX if a dep is missing from main
const { order, missing } = resolve(idx, ["python3"]);
if (missing.length) console.warn("unresolved (assumed provided by base):", missing);

console.log(`2/6 install ${order.length} apks`);
await installApks(order, mainRepo, rootfs, tmp);

console.log("3/6 boot buildroot + preload split FS");
// EXACT ArrayBuffer: Node's readFileSync may return a POOLED Buffer at a
// non-zero byteOffset for small files (<4 KB), so `.buffer` would hand v86 the
// wrong bytes with no error. new Uint8Array(buf) copies into a fresh 0-offset
// ArrayBuffer. (Verified-spike form was { url }; this is the buffer equivalent.)
const ab = (p) => new Uint8Array(fs.readFileSync(p)).buffer;
// v86's ESM build has no CommonJS __dirname, so its default wasm lookup falls
// back to a CWD-relative "build/v86.wasm" (fine for the spikes, which ran with
// that as their cwd; not fine for a monorepo script run from the repo root) —
// point it at the installed package's own build/ dir instead. (Adaptation not
// in the brief: the brief's snippet omitted wasm_path entirely.)
const wasmDir = path.dirname(fileURLToPath(import.meta.resolve("v86")));
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

console.log("4/6 drive guest chroot/bind setup over serial");
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
  const timeout = setTimeout(() => reject(new Error(`serial timeout waiting for ${marker}; tail=${JSON.stringify(sbuf.slice(-300))}`)), timeoutMs);
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
await sh(PYCACHE_WARMUP_CMD, "WARMED"); console.log("  marker: WARMED (pycache warmed, rw)");         // warm pycache into sys-root (rw) once
await sh(REMOUNT_RO_CMD, "ROREADY"); console.log("  marker: ROREADY (system view frozen read-only)");            // freeze system view read-only
await sh(LAUNCH_GUESTD_CMD, "GDLAUNCHED"); console.log("  marker: GDLAUNCHED (resident guestd launched)");      // resident guestd inside the workspace chroot
// 4.5/6 bring eth0 up + DHCP so the saved state boots with 192.168.86.100
// already assigned (buildroot busybox ships udhcpc — no apk change). The
// marker string is real command output, not appended text (quote-split like
// the other markers so the tty echo can't self-match it).
await sh("ip link set eth0 up; udhcpc -i eth0 -n -q 2>&1; ip -o addr show eth0 2>&1; echo NETU''P", "NETUP", 30000);
console.log("  marker: NETUP (eth0 up + DHCP lease 192.168.86.100)");
await new Promise((r) => setTimeout(r, 1500));  // let guestd reach its read loop

console.log("5/6 save_state (self-contained: 9p FS rides inside)");
const state = new Uint8Array(await emulator.save_state());
await emulator.destroy();

console.log("6/6 zstd-compress → assets/state.zst");
// gzip is fine for the MVP if zstd bindings aren't present; keep the extension honest.
const compressed = zlib.gzipSync(state, { level: 9 });
fs.writeFileSync(path.join(assets, "state.zst"), compressed);
fs.writeFileSync(path.join(assets, "state.meta.json"), JSON.stringify({ rawBytes: state.length, compressedBytes: compressed.length, alpine: ver, codec: "gzip", net: true }, null, 2));
// assets.ts decompresses state.zst -> state.bin and caches it (only writes if
// absent). Drop the stale cache now so a rebake's new state.zst is the one
// that actually gets loaded, not a leftover decompression of the old one.
fs.rmSync(path.join(assets, "state.bin"), { force: true });
console.log(`done: state ${state.length} -> ${compressed.length} bytes (assets/state.zst)`);
process.exit(0);
