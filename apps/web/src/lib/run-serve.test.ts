import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { runServeCommand } from "./run-serve.js";

/** Minimal fake: manual event emission + a scripted shell, plus a runtime that
 *  answers `getCapabilities` (browser by default) and an optional `exec` for the
 *  realOs/VM detached path. */
function fake(
  execImpl: (emit: (e: RuntimeEvent) => void) => Promise<{ code: number; stdout: string; stderr: string }>,
  opts: { realOs?: boolean; runtimeExec?: (emit: (e: RuntimeEvent) => void) => Promise<any> } = {},
) {
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const emit = (e: RuntimeEvent): void => listeners.forEach((l) => l(e));
  const runtime = {
    subscribe(l: (e: RuntimeEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getCapabilities: async () => ({ realOs: opts.realOs ?? false }) as any,
    exec: (line: string) => (opts.runtimeExec ?? (() => Promise.reject(new Error("no runtimeExec"))))(emit),
    kill: async () => {},
  };
  const shell = { cwd: "/", exec: () => execImpl(emit) };
  return { runtime, shell, listeners };
}

const opened = (port: number): RuntimeEvent => ({ type: "port.opened", port, url: `/__port__/${port}/` });

describe("runServeCommand", () => {
  it("resolves ok on port.opened even if the command never exits (a real server blocks)", async () => {
    const { runtime, shell } = fake((emit) => {
      emit(opened(8080));
      return new Promise(() => {}); // never exits
    });
    const r = await runServeCommand(runtime, shell, "python app.py");
    expect(r.ok).toBe(true);
    expect(r.openedPorts).toEqual([8080]);
  });

  it("captures a port delivered asynchronously AFTER a successful exit", async () => {
    const { runtime, shell } = fake((emit) => {
      setTimeout(() => emit(opened(9090)), 0); // async delivery, per the contract
      return Promise.resolve({ code: 0, stdout: "served\n", stderr: "" });
    });
    const r = await runServeCommand(runtime, shell, "erdou serve .");
    expect(r.ok).toBe(true);
    expect(r.openedPorts).toEqual([9090]);
    expect(r.stdout).toBe("served\n");
  });

  it("reports a failing command's code and stderr", async () => {
    const { runtime, shell } = fake(() => Promise.resolve({ code: 2, stdout: "", stderr: "boom" }));
    const r = await runServeCommand(runtime, shell, "false");
    expect(r).toMatchObject({ ok: false, code: 2, stderr: "boom", openedPorts: [] });
  });

  it("reports a rejecting exec as ok:false with the message", async () => {
    const { runtime, shell } = fake(() => Promise.reject(new Error("no such command")));
    const r = await runServeCommand(runtime, shell, "nope");
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("no such command");
  });

  it("unsubscribes once settled by exit", async () => {
    const { runtime, shell, listeners } = fake(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));
    await runServeCommand(runtime, shell, "echo hi");
    expect(listeners.size).toBe(0);
  });
});

const fakeHandle = (pid: number) => ({
  pid,
  stdout: { text: async () => "" },
  stderr: { text: async () => "boom-stderr" },
  stdin: { write() {}, end() {} },
  wait: () => new Promise<never>(() => {}), // never exits (a live server)
  kill: async () => {},
});

describe("runServeCommand (VM / realOs path)", () => {
  it("spawns detached and resolves when port.opened arrives (not by reading openPorts synchronously)", async () => {
    let execCalled = false;
    const { runtime, shell } = fake(() => Promise.reject(new Error("shell.exec must not be used on the VM path")), {
      realOs: true,
      runtimeExec: (emit) => {
        execCalled = true;
        setTimeout(() => emit({ type: "port.opened", port: 8000, url: "/__port__/8000/" }), 5);
        return Promise.resolve(fakeHandle(8000));
      },
    });
    const r = await runServeCommand(runtime as any, shell as any, "python3 -m http.server 8000 --bind 0.0.0.0");
    expect(execCalled).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.openedPorts).toEqual([8000]);
    expect(r.pid).toBe(8000);
  });

  it("a loopback-only bind resolves ok:false with the loopback port", async () => {
    const { runtime, shell } = fake(() => Promise.reject(new Error("unused")), {
      realOs: true,
      runtimeExec: (emit) => {
        setTimeout(() => emit({ type: "resource.warning", resource: "port:8001", detail: "loopback-only" }), 5);
        return Promise.resolve(fakeHandle(8001));
      },
    });
    const r = await runServeCommand(runtime as any, shell as any, "python3 -m http.server 8001 --bind 127.0.0.1");
    expect(r.ok).toBe(false);
    expect(r.loopbackPorts).toEqual([8001]);
    // carries a "bind 0.0.0.0" hint as stderr so the Preview panel shows it
    // instead of a misleading "exited with code undefined".
    expect(r.stderr).toContain("0.0.0.0");
  });

  it("a server that exits before opening a port fails with its stderr", async () => {
    const { runtime, shell } = fake(() => Promise.reject(new Error("unused")), {
      realOs: true,
      runtimeExec: () =>
        Promise.resolve({
          ...fakeHandle(42),
          wait: async () => ({ code: 1, signal: null }),
          stderr: { text: async () => "Address already in use" },
        }),
    });
    const r = await runServeCommand(runtime as any, shell as any, "python3 -m http.server 8000 --bind 0.0.0.0");
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("Address already in use");
  });
});
