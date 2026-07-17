import { describe, it, expect } from "vitest";
import { parseListeningPorts } from "./proc-net-parse.js";

// Real /proc/net/tcp shape: sl local_address rem_address st … (st 0A = LISTEN).
const FIXTURE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000 100 0 0 10 0", // 0.0.0.0:8000 LISTEN
  "   1: 0100007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000 100 0 0 10 0", // 127.0.0.1:9000 LISTEN
  "   2: 0100007F:0050 0100007F:C001 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000 100 0 0 10 0", // 127.0.0.1:80 ESTABLISHED (not LISTEN)
].join("\n");

describe("parseListeningPorts", () => {
  it("extracts reachable and loopback LISTEN ports and skips non-LISTEN rows", () => {
    const ports = parseListeningPorts(FIXTURE);
    expect(ports).toEqual([
      { port: 8000, loopback: false },
      { port: 9000, loopback: true },
    ]);
  });

  it("treats the eth0 IP (192.168.86.100 = 6456A8C0) as reachable", () => {
    const line = "   0: 6456A8C0:1F90 00000000:0000 0A 0 0 0 0 0 0 0 0 999 1 0 100 0 0 10 0";
    expect(parseListeningPorts(line)).toEqual([{ port: 8080, loopback: false }]);
  });

  it("a port listening on both 0.0.0.0 and 127.0.0.1 is reachable (reachable wins)", () => {
    const both = [
      "   0: 0100007F:1F40 00000000:0000 0A 0 0 0 0 0 0 0 0 1 1 0 100 0 0 10 0",
      "   1: 00000000:1F40 00000000:0000 0A 0 0 0 0 0 0 0 0 2 1 0 100 0 0 10 0",
    ].join("\n");
    expect(parseListeningPorts(both)).toEqual([{ port: 8000, loopback: false }]);
  });

  it("treats the tcp6 :: (all-zero V6_ANY) LISTEN address as reachable", () => {
    // /proc/net/tcp6 row: 32 hex chars for the v6 local_address, same column layout as tcp4.
    const line =
      "   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 0 0 1 1 0 100 0 0 10 0";
    expect(parseListeningPorts(line)).toEqual([{ port: 8000, loopback: false }]);
  });

  it("treats the tcp6 ::1 LISTEN address as loopback", () => {
    // ::1 encodes as 3 all-zero 32-bit words followed by 01000000 (little-endian last word).
    const line =
      "   0: 00000000000000000000000001000000:2329 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 0 0 1 1 0 100 0 0 10 0";
    expect(parseListeningPorts(line)).toEqual([{ port: 9001, loopback: true }]);
  });

  it("honors a custom opts.eth0Hex override (not just the hard-coded default)", () => {
    // 192.168.1.50 little-endian hex, distinct from DEFAULT_ETH0_HEX (192.168.86.100 = 6456A8C0).
    const customEth0Hex = "3201A8C0";
    const line = "   0: 3201A8C0:1B58 00000000:0000 0A 0 0 0 0 0 0 0 0 1 1 0 100 0 0 10 0";
    expect(parseListeningPorts(line, { eth0Hex: customEth0Hex })).toEqual([{ port: 7000, loopback: false }]);
    // Without the override, that same IP is just some other host — not reachable.
    expect(parseListeningPorts(line)).toEqual([{ port: 7000, loopback: true }]);
  });
});
