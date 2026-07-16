// Populate ONE fs9p export with /sys-root (Alpine) + /workspace (empty + skeleton).
// create_file() is useless (mode 0666, no dirs/symlinks) — drive fs9p directly.
import fs from "node:fs";
import path from "node:path";

export const SKELETON_DIRS = ["bin", "lib", "usr", "proc", "dev", "tmp"];

async function walk(fs9p, localDir, parentId, stats) {
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const full = path.join(localDir, entry.name);
    if (entry.isDirectory()) {
      const st = fs.lstatSync(full);
      const id = fs9p.CreateDirectory(entry.name, parentId);
      fs9p.inodes[id].mode = (st.mode & 0o7777) | 0o040000; stats.dirs++;
      await walk(fs9p, full, id, stats);
    } else if (entry.isSymbolicLink()) {
      fs9p.CreateSymlink(entry.name, parentId, fs.readlinkSync(full)); stats.symlinks++;
    } else if (entry.isFile()) {
      const data = fs.readFileSync(full); const st = fs.lstatSync(full);
      const id = await fs9p.CreateBinaryFile(entry.name, parentId, new Uint8Array(data));
      fs9p.inodes[id].mode = (st.mode & 0o7777) | 0o100000; stats.files++; stats.bytes += data.length;
    }
  }
}

/** Build sys-root (from rootfsDir) + workspace + skeleton; copy guestd.py into sys-root. */
export async function setupSplitFs(fs9p, rootfsDir, guestdSrcPath) {
  const stats = { dirs: 0, files: 0, symlinks: 0, bytes: 0 };
  const sysId = fs9p.CreateDirectory("sys-root", 0); fs9p.inodes[sysId].mode = 0o040755;
  await walk(fs9p, rootfsDir, sysId, stats);
  // guestd at sys-root/usr/lib/erdou/guestd.py (visible via the /usr bind, no workspace pollution)
  const usrId = fs9p.Search(sysId, "usr");
  const libId = fs9p.Search(usrId, "lib");
  const erdouId = fs9p.CreateDirectory("erdou", libId); fs9p.inodes[erdouId].mode = 0o040755;
  const gd = fs.readFileSync(guestdSrcPath);
  const gid = await fs9p.CreateBinaryFile("guestd.py", erdouId, new Uint8Array(gd));
  fs9p.inodes[gid].mode = 0o100755;
  const wsId = fs9p.CreateDirectory("workspace", 0); fs9p.inodes[wsId].mode = 0o040755;
  for (const d of SKELETON_DIRS) { const id = fs9p.CreateDirectory(d, wsId); fs9p.inodes[id].mode = 0o040755; }
  return stats;
}

// The exact verified guest-side setup (busybox ash; completion/failure markers
// quote-split (e.g. "SETUPD''ONE") because the guest tty ECHOES the typed
// command line back over serial before the shell executes it — an unsplit
// marker would self-match on that echo the instant the command is sent, long
// before the real work (mounts / chroot / python3 import) finishes. Verified
// gotcha from Spike B/C (REPORT.md Q3 gotcha #3, and Spike C's SETUP_O''K /
// RO_O''K / GD_LAUN''CHED). All four completion markers below are split; the
// per-iteration BINDFAIL/ROFAIL markers were already split in the source spike.
export const GUEST_SETUP_CMD =
  "for d in bin lib usr; do mount -o bind /mnt/sys-root/$d /mnt/workspace/$d || echo BINDF''AIL_$d; done; " +
  "mount -t proc proc /mnt/workspace/proc; mount -o bind /dev /mnt/workspace/dev; mount -t tmpfs tmpfs /mnt/workspace/tmp; " +
  "echo SETUPD''ONE";
export const PYCACHE_WARMUP_CMD =
  "chroot /mnt/workspace /usr/bin/python3 -c 'import subprocess, tty, termios, json, struct, threading, signal, shutil' 2>/dev/null; echo WAR''MED";
export const REMOUNT_RO_CMD =
  "for d in bin lib usr; do mount -o remount,ro,bind /mnt/workspace/$d || echo ROF''AIL_$d; done; echo ROREAD''Y";
export const LAUNCH_GUESTD_CMD =
  "chroot /mnt/workspace /usr/bin/python3 /usr/lib/erdou/guestd.py </dev/null >/tmp/gd.log 2>&1 & echo GDLAUN''CHED";
