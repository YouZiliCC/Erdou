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
});
