import { describe, it, expect } from "vitest";
import { ProcessTable } from "./process-table.js";
import type { Program, ProgramRegistry } from "./program.js";
import { Vfs } from "../vfs/vfs.js";
import { EventBus } from "../core/event-bus.js";
import type { HttpHandler, RuntimeEvent } from "@erdou/runtime-contract";

function make(programs: Record<string, Program>) {
  const registry: ProgramRegistry = new Map(Object.entries(programs));
  const vfs = new Vfs({ clock: () => 0 });
  const bus = new EventBus();
  const events: RuntimeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  let t = 1000;
  const served = new Map<number, HttpHandler>();
  const table = new ProcessTable({
    vfs,
    bus,
    registry,
    clock: () => t++,
    serve: (port, handler) => served.set(port, handler),
  });
  return { table, events, served };
}

describe("ProcessTable", () => {
  it("runs a program, captures stdout and exit code", async () => {
    const { table } = make({
      echo: async (ctx) => {
        ctx.stdout.write(ctx.argv.slice(1).join(" "));
        return 0;
      },
    });
    const rec = table.spawn({ cmd: "echo", args: ["hi", "there"] });
    expect(rec.state).toBe("running");
    expect(await rec.wait()).toEqual({ code: 0, signal: null });
    expect(await rec.stdout.text()).toBe("hi there");
  });

  it("propagates non-zero exit codes", async () => {
    const { table } = make({ fail: async () => 2 });
    expect(await table.spawn({ cmd: "fail" }).wait()).toEqual({ code: 2, signal: null });
  });

  it("surfaces a thrown error on stderr and exits 1", async () => {
    const { table } = make({
      boom: async () => {
        throw new Error("kaboom");
      },
    });
    const rec = table.spawn({ cmd: "boom" });
    expect(await rec.wait()).toEqual({ code: 1, signal: null });
    expect(await rec.stderr.text()).toContain("kaboom");
  });

  it("throws ENOENT for an unknown command", () => {
    const { table } = make({});
    try {
      table.spawn({ cmd: "nope" });
      throw new Error("should throw");
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
      expect(err.path).toBe("nope");
    }
  });

  it("lists processes with ppid and reflects exitCode after exit", async () => {
    const { table } = make({ done: async () => 0 });
    const rec = table.spawn({ cmd: "done", ppid: 42 });
    const running = table.list().find((p) => p.pid === rec.pid);
    expect(running?.ppid).toBe(42);
    expect(running?.state).toBe("running");
    await rec.wait();
    expect(table.list().find((p) => p.pid === rec.pid)?.exitCode).toBe(0);
  });

  it("kills a running program with the right signal exit code", async () => {
    const { table } = make({ hang: () => new Promise<number>(() => {}) });
    const rec = table.spawn({ cmd: "hang" });
    table.kill(rec.pid, "SIGKILL");
    expect(await rec.wait()).toEqual({ code: 137, signal: "SIGKILL" });
    expect(rec.state).toBe("killed");
  });

  it("kill on an unknown pid throws ESRCH", () => {
    const { table } = make({});
    expect(() => table.kill(999)).toThrow(/ESRCH/);
  });

  it("emits process.started and process.exited", async () => {
    const { table, events } = make({ done: async () => 0 });
    const rec = table.spawn({ cmd: "done" });
    await rec.wait();
    expect(events).toContainEqual({ type: "process.started", pid: rec.pid, cmd: "done" });
    expect(events).toContainEqual({ type: "process.exited", pid: rec.pid, code: 0, signal: null });
  });

  it("adopt allocates a real pid, tracks state, and settles via exited()", async () => {
    const { table, events } = make({});
    const adopted = table.adopt({ cmd: "sh", args: ["-c", "echo hi"] });
    expect(adopted.record.pid).toBeGreaterThan(0);
    expect(table.list().find((p) => p.pid === adopted.record.pid)?.state).toBe("running");
    adopted.exited(0);
    expect((await table.wait(adopted.record.pid)).code).toBe(0);
    expect(events).toContainEqual({ type: "process.exited", pid: adopted.record.pid, code: 0, signal: null });
  });

  it("adopt: killing the pid fires onKill and settles as killed", async () => {
    const { table } = make({});
    const adopted = table.adopt({ cmd: "sh" });
    let killed: string | null = null;
    adopted.onKill((sig) => (killed = sig));
    table.kill(adopted.record.pid, "SIGTERM");
    expect(killed).toBe("SIGTERM");
    expect((await table.wait(adopted.record.pid)).signal).toBe("SIGTERM");
    adopted.exited(0); // late exit after kill is a no-op
    expect(table.list().find((p) => p.pid === adopted.record.pid)?.state).toBe("killed");
  });
});
