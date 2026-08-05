import { describe, it, expect } from "vitest";
import type { ByteStream, ExitStatus } from "@erdou/runtime-contract";
import { VmRuntime } from "./vm-runtime.js";
import type { GuestProcess } from "./guestd-client.js";

// HERMETIC VmRuntime unit tests (no emulator, no image): private fields are
// replaced the same way vm-dispatch.test.ts fakes its host. The gated
// conformance suite proves the same surface against a real guest.

const emptyStream = (): ByteStream => ({
  read: () => (async function* (): AsyncGenerator<Uint8Array> {})(),
  text: async () => "",
});

function fakeGuestProcess(pid: number): GuestProcess {
  return {
    pid,
    stdout: emptyStream(),
    stderr: emptyStream(),
    wait: () => new Promise<ExitStatus>(() => {}), // never exits — irrelevant here
    kill: async () => {},
  };
}

function hermetic(): { rt: VmRuntime; spawns: unknown[][] } {
  const rt = new VmRuntime(async () => {
    throw new Error("hermetic test: must not boot");
  });
  const spawns: unknown[][] = [];
  (rt as unknown as { guestd: unknown }).guestd = {
    spawn: async (...a: unknown[]) => { spawns.push(a); return fakeGuestProcess(42); },
  };
  return { rt, spawns };
}

describe("VmRuntime.spawn — stdin is refused, not silently dropped", () => {
  it("rejects a non-empty SpawnOptions.stdin loudly before reaching guestd", async () => {
    const { rt, spawns } = hermetic();
    // guestd launches every process with stdin=/dev/null; the browser kernel
    // delivers these bytes. Dropping them silently made `wc -c` print 0.
    await expect(rt.spawn({ cmd: "wc", args: ["-c"], stdin: "hello" })).rejects.toThrow(/stdin.*not supported/);
    await expect(rt.spawn({ cmd: "wc", args: ["-c"], stdin: new Uint8Array([1, 2]) })).rejects.toThrow(/ENOTSUP/);
    expect(spawns).toEqual([]); // never reached the guest
  });

  it("spawn without stdin (or with empty stdin, which /dev/null already honors) still works", async () => {
    const { rt, spawns } = hermetic();
    expect((await rt.spawn({ cmd: "echo", args: ["x"] })).pid).toBe(42);
    expect((await rt.spawn({ cmd: "true", stdin: "" })).pid).toBe(42);
    expect(spawns).toHaveLength(2);
  });

  it("the handle's stdin.write throws too — a post-spawn write must not vanish", async () => {
    const { rt } = hermetic();
    const h = await rt.spawn({ cmd: "cat" });
    expect(() => h.stdin.write("late bytes")).toThrow(/stdin/);
    // end() of a never-connected stdin is the browser kernel's no-stdin state
    // too — closing nothing is not a loss.
    expect(() => h.stdin.end()).not.toThrow();
  });
});

describe("VmRuntime.shutdown — PTY slots do not leak into the next boot", () => {
  it("clears ptyPorts so a re-boot can open PTYs that died with the old emulator", async () => {
    const rt = new VmRuntime(async () => {
      throw new Error("hermetic test: must not boot");
    });
    (rt as unknown as { booted: boolean }).booted = true;
    (rt as unknown as { host: unknown }).host = {
      destroy: async () => {},
      terminal: () => { throw new Error("terminal reached (port allocation succeeded)"); },
    };
    // Three sessions live at shutdown whose consumers never dispose() — their
    // guest bridge processes die with the emulator either way.
    const ptyPorts = (rt as unknown as { ptyPorts: Set<number> }).ptyPorts;
    ptyPorts.add(1); ptyPorts.add(2); ptyPorts.add(3);
    await rt.shutdown();
    // Pre-fix this rejected with "all 3 PTY ports are in use" on a freshly
    // booted VM whose hvc ports are all actually free.
    await expect(rt.openPty()).rejects.toThrow(/terminal reached/);
  });
});
