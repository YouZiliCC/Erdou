import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { runServeCommand } from "./run-serve.js";

/** Minimal fake: manual event emission + a scripted shell. */
function fake(execImpl: (emit: (e: RuntimeEvent) => void) => Promise<{ code: number; stdout: string; stderr: string }>) {
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const emit = (e: RuntimeEvent): void => listeners.forEach((l) => l(e));
  const runtime = {
    subscribe(l: (e: RuntimeEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
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
