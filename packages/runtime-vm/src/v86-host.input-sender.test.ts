import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { V86Host, assertVirtioConsoleQueue, type V86BootInputs } from "./v86-host.js";

function fakeFs9p(): Record<string, unknown> {
  const o: Record<string, unknown> = { inodes: [] };
  for (const m of ["GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile", "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file"]) o[m] = () => {};
  return o;
}

/** A fake v86: 16-slot RX ring, one slot consumed per bus.send (regardless of
 *  payload size — matching v86's virtio-console input handler), refill on demand.
 *  Like the real handler's has_request() guard, a send on an empty ring is
 *  SILENTLY DROPPED — so the burst test bites on any capacity-gate regression. */
function makeFakeHost() {
  const sent: { event: string; bytes: Uint8Array }[] = [];
  const ring = { avail: 16 };
  const queue = { avail_addr: 0x1000, count_requests: () => ring.avail };
  class FakeHost extends V86Host {
    protected makeEmulator(): any {
      return {
        add_listener: (ev: string, cb: () => void) => { if (ev === "emulator-ready") cb(); },
        fs9p: fakeFs9p(),
        run() {},
        bus: { send: (event: string, bytes: Uint8Array) => { if (ring.avail <= 0) return; sent.push({ event, bytes: bytes.slice() }); ring.avail -= 1; } },
        v86: { cpu: { devices: { virtio_console: { virtio: { queues: { 0: queue, 4: queue } } } } } },
        destroy: async () => {},
      };
    }
  }
  return { host: new FakeHost(), sent, ring };
}

const inputs: V86BootInputs = { bios: new ArrayBuffer(8), vgaBios: new ArrayBuffer(8), kernel: new ArrayBuffer(8), wasmUrl: "x", memoryMB: 512 };
const boot = (h: V86Host) => h.boot(inputs);

describe("V86Host input sender (FU2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers every byte of a per-keystroke burst larger than the RX ring, none silently dropped", async () => {
    const { host, sent, ring } = makeFakeHost();
    await boot(host);
    const term = host.terminal(1);
    // ~3x ring size, one send per char with no event-loop turns in between — the
    // exact shape that made v86 drop every byte past the 16th.
    for (const ch of "echo hello world, forty-six chars of burst!!\n") term.send(new TextEncoder().encode(ch));
    ring.avail = 16; // guest replenishes
    await vi.advanceTimersByTimeAsync(10);
    const all = Buffer.concat(sent.map((s) => s.bytes)).toString();
    expect(all).toBe("echo hello world, forty-six chars of burst!!\n");
  });

  it("never sends while the ring is empty; resumes via the retry timer", async () => {
    const { host, sent, ring } = makeFakeHost();
    await boot(host);
    ring.avail = 0;
    host.terminal(1).send(new TextEncoder().encode("x"));
    expect(sent.length).toBe(0); // held, not dropped into the void
    ring.avail = 16;
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.length).toBe(1);
  });

  it("splits a single oversized write into <=2048-byte chunks (guest RX buffers are PAGE_SIZE)", async () => {
    const { host, sent } = makeFakeHost();
    await boot(host);
    host.terminal(1).send(new Uint8Array(5000));
    expect(sent.map((s) => s.bytes.length)).toEqual([2048, 2048, 904]);
  });

  it("destroy() cancels pending retry timers (no send after teardown)", async () => {
    const { host, sent, ring } = makeFakeHost();
    await boot(host);
    ring.avail = 0;
    host.terminal(1).send(new Uint8Array([1]));
    await host.destroy();
    ring.avail = 16;
    await vi.advanceTimersByTimeAsync(50);
    expect(sent.length).toBe(0);
  });

  it("boot() after destroy() re-arms sending and discards the old boot's unflushed pending (VmRuntime reuse)", async () => {
    const { host, sent, ring } = makeFakeHost();
    await boot(host);
    ring.avail = 0;
    host.terminal(1).send(new Uint8Array([1])); // held for a guest that never comes back
    await host.destroy();
    await boot(host);
    ring.avail = 16;
    host.terminal(1).send(new TextEncoder().encode("y"));
    expect(sent.map((s) => Buffer.from(s.bytes).toString())).toEqual(["y"]);
  });

  it("send() after destroy() is a no-op — stale bytes cannot resurface in a later boot", async () => {
    const { host, sent, ring } = makeFakeHost();
    await boot(host);
    const term = host.terminal(1);
    await host.destroy();
    term.send(new Uint8Array([1])); // dead host — must not buffer
    await boot(host);
    ring.avail = 16;
    term.send(new TextEncoder().encode("z")); // stale sender ref kept across boots
    expect(sent.map((s) => Buffer.from(s.bytes).toString())).toEqual(["z"]);
  });
});

describe("assertVirtioConsoleQueue", () => {
  it("throws a clear error naming the missing v86 internal", () => {
    expect(() => assertVirtioConsoleQueue({}, 4)).toThrow(/virtio_console.*queues\[4\].*count_requests/);
  });
});
