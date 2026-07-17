/**
 * Pure `/proc/net/tcp(6)` LISTEN-socket parser. This is the TS reference of the
 * exact algorithm `guestd.py`'s port watcher runs (Python can't import TS) — the
 * two MUST stay in sync (precedent: preview-bridge.ts ↔ preview-sw.js). Unit-
 * testing it here pins the fiddly little-endian hex logic without a VM boot.
 *
 * Columns are whitespace-separated: `sl local_address rem_address st …`.
 * local_address is `HEXIP:HEXPORT` (little-endian hex); st `0A` = LISTEN.
 * Reachable (previewable) IPs: 0.0.0.0 (00000000), :: (all-zero v6), or the
 * eth0 IP (192.168.86.100 = 6456A8C0). Everything else (127.0.0.1 = 0100007F,
 * ::1, a specific non-eth0 IP) is loopback-only / not previewable.
 */
export interface ListeningPort {
  port: number;
  loopback: boolean;
}

const V4_ANY = "00000000";
const V6_ANY = "00000000000000000000000000000000";
const DEFAULT_ETH0_HEX = "6456A8C0"; // 192.168.86.100 little-endian

export function parseListeningPorts(procText: string, opts: { eth0Hex?: string } = {}): ListeningPort[] {
  const eth0 = (opts.eth0Hex ?? DEFAULT_ETH0_HEX).toUpperCase();
  const byPort = new Map<number, boolean>(); // port -> loopback (false wins)
  for (const line of procText.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== "0A") continue; // not a LISTEN row
    const local = cols[1] ?? "";
    const colon = local.indexOf(":");
    if (colon === -1) continue;
    const ip = local.slice(0, colon).toUpperCase();
    const port = parseInt(local.slice(colon + 1), 16);
    if (!Number.isFinite(port) || port <= 0) continue;
    const reachable = ip === V4_ANY || ip === V6_ANY || ip === eth0;
    const loopback = !reachable;
    const prev = byPort.get(port);
    byPort.set(port, prev === undefined ? loopback : prev && loopback);
  }
  return [...byPort.entries()]
    .map(([port, loopback]) => ({ port, loopback }))
    .sort((a, b) => a.port - b.port);
}
