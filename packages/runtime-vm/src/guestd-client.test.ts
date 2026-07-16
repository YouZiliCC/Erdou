import { describe, it, expect } from "vitest";
import { GuestdClient, type GuestChannel } from "./guestd-client.js";
import { encodeFrame, encodeJsonFrame, FrameReader, decodeJson, FrameType } from "./guestd-protocol.js";

/** A fake guest: replies READY to the client's PING kick (modelling the real
 *  post-restore handshake — NOT an unconditional timer), then delegates other
 *  request frames to the scripted behavior. */
function fakeGuest(handle: (type: string, id: number, body: Uint8Array, reply: (b: Uint8Array) => void) => void) {
  let onData: (b: Uint8Array) => void = () => {};
  const reader = new FrameReader();
  const channel: GuestChannel = {
    send(bytes) {
      for (const f of reader.push(bytes)) {
        if (f.type === FrameType.PING) { onData(encodeJsonFrame(FrameType.READY, 0, { pid: 63 })); continue; }
        handle(f.type, f.id, f.body, (b) => onData(b));
      }
    },
    subscribe(cb) { onData = cb; },
  };
  return channel;
}

const enc = new TextEncoder();

describe("GuestdClient", () => {
  it("resolves ready() with the guest pid", async () => {
    const client = new GuestdClient(fakeGuest(() => {}));
    expect(await client.ready()).toEqual({ pid: 63 });
  });

  it("execs a command, streams stdout, and resolves wait() with the exit code", async () => {
    const channel = fakeGuest((type, id, _body, reply) => {
      if (type === FrameType.EXEC) {
        reply(encodeJsonFrame(FrameType.STARTED, id, { pid: 100 }));
        reply(encodeFrame(FrameType.STDOUT, id, enc.encode("hi\n")));
        reply(encodeJsonFrame(FrameType.EXIT, id, { code: 0, signal: null }));
      }
    });
    const client = new GuestdClient(channel);
    await client.ready();
    const p = await client.exec("echo hi");
    expect(p.pid).toBe(100);
    expect(await p.stdout.text()).toBe("hi\n");
    expect(await p.wait()).toEqual({ code: 0, signal: null });
  });

  it("rejects spawn of an unknown command with ENOENT", async () => {
    const channel = fakeGuest((type, id, body, reply) => {
      if (type === FrameType.SPAWN) {
        const { cmd } = decodeJson(body) as { cmd: string };
        if (cmd === "nope") reply(encodeJsonFrame(FrameType.ERROR, id, { code: "ENOENT", message: "nope" }));
      }
    });
    const client = new GuestdClient(channel);
    await client.ready();
    await expect(client.spawn("nope", [])).rejects.toThrow(/ENOENT/);
  });

  it("ps() returns the guest process list", async () => {
    const channel = fakeGuest((type, id, _body, reply) => {
      if (type === FrameType.PS) {
        reply(encodeJsonFrame(FrameType.PROCS, id, { procs: [{ pid: 1, ppid: 0, cmd: "init", args: [], cwd: "/", state: "running", startTimeMs: 0, exitCode: null }] }));
      }
    });
    const client = new GuestdClient(channel);
    await client.ready();
    const procs = await client.ps();
    expect(procs[0]!.pid).toBe(1);
  });

  it("ready() rejects after the deadline if the guest never answers", async () => {
    // a channel that swallows PINGs and never emits READY
    const channel: GuestChannel = { send() {}, subscribe() {} };
    const client = new GuestdClient(channel);
    await expect(client.ready({ deadlineMs: 50 })).rejects.toThrow(/guest.*not.*respond|ready|timeout/i);
  });

  it("dispose() stops the ping interval and rejects pending processes", async () => {
    let pings = 0;
    const channel: GuestChannel = { send: () => { pings++; }, subscribe() {} };
    const client = new GuestdClient(channel);
    void client.ready({ deadlineMs: 10_000 }).catch(() => {}); // start pinging
    const before = pings;
    client.dispose();
    await new Promise((r) => setTimeout(r, 260)); // > one ping interval
    expect(pings).toBe(before); // no further pings after dispose
  });

  it("dispose() settles in-flight ps() promise", async () => {
    // fake channel that swallows PS requests (never replies)
    const channel: GuestChannel = { send() {}, subscribe() {} };
    const client = new GuestdClient(channel);
    await client.ready({ deadlineMs: 50 }).catch(() => {}); // skip ready; just init
    const psPromise = client.ps(); // start ps(), never reply
    client.dispose();
    // assert ps() settles within 100ms, not hanging forever
    const result = await Promise.race([
      psPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ps() hung after dispose()")), 100)),
    ]);
    expect(result).toEqual([]); // expect ps() to resolve to empty array
  });

  it("dispose() settles in-flight kill() promise", async () => {
    // fake channel that swallows KILL requests (never replies)
    const channel: GuestChannel = { send() {}, subscribe() {} };
    const client = new GuestdClient(channel);
    await client.ready({ deadlineMs: 50 }).catch(() => {}); // skip ready; just init
    const killPromise = client.kill(1); // start kill(), never reply
    client.dispose();
    // assert kill() settles within 100ms, not hanging forever
    const result = await Promise.race([
      killPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("kill() hung after dispose()")), 100)),
    ]);
    expect(result).toBeUndefined(); // kill() resolves with void
  });
});
