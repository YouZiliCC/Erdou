import type { Runtime, RuntimeEvent } from "@erdou/runtime-contract";
import type { RpcShellSession } from "./kernel.js";

export interface RunServeResult {
  ok: boolean;
  /** Ports that opened during this run, in open order (captured from the event
   *  subscription, never by diffing a ports list afterwards). */
  openedPorts: number[];
  /** Ports the server bound loopback-only (127.0.0.1) — reachable via the guest
   *  loopback, NOT previewable. Non-empty ⇒ show a "bind 0.0.0.0" hint. */
  loopbackPorts: number[];
  /** The detached server's pid (real-OS path only), so the caller can stop it
   *  before re-serving — a real guest socket stays bound until the process dies. */
  pid?: number;
  /** Present when the command exited. */
  code?: number;
  stdout?: string;
  stderr?: string;
}

type ServeRuntime = Pick<Runtime, "subscribe" | "getCapabilities" | "exec">;

/** python `-m http.server` cold-start (~16s) + bind + the guestd watcher poll. */
const VM_SERVE_TIMEOUT_MS = 45_000;

/**
 * Run a (possibly serving) command. Capability-gated:
 *  - realOs (VM): a real server BLOCKS, so start it DETACHED via `runtime.exec`
 *    (which resolves on process START, never awaiting exit) and settle on the
 *    FIRST of `port.opened` (ok), a loopback-bind `resource.warning` (ok:false
 *    + hint), a process exit before any port (ok:false + stderr), or a timeout.
 *  - otherwise (browser): the simulated kernel's serve returns after
 *    registering, so run it through the shell and settle on exit/port.
 * Never rejects — failures come back as `ok: false`.
 */
export function runServeCommand(
  runtime: ServeRuntime,
  shell: RpcShellSession,
  commandLine: string,
): Promise<RunServeResult> {
  return runtime.getCapabilities().then((caps) =>
    caps.realOs ? runServeDetached(runtime, commandLine) : runServeRegistering(runtime, shell, commandLine),
  );
}

function runServeDetached(runtime: ServeRuntime, commandLine: string): Promise<RunServeResult> {
  return new Promise((resolve) => {
    const openedPorts: number[] = [];
    const loopbackPorts: number[] = [];
    let settled = false;
    let pid: number | undefined;
    const settle = (r: RunServeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(r);
    };
    const unsub = runtime.subscribe((e: RuntimeEvent) => {
      if (e.type === "port.opened") {
        openedPorts.push(e.port);
        settle({ ok: true, openedPorts: [...openedPorts], loopbackPorts: [...loopbackPorts], pid });
      } else if (e.type === "resource.warning" && e.resource.startsWith("port:")) {
        // A loopback-only bind: VmRuntime emits the existing `resource.warning`
        // event (Task 5) rather than a new contract member; recover the port
        // number from `resource` ("port:<n>").
        const port = Number(e.resource.slice("port:".length));
        loopbackPorts.push(port);
        settle({ ok: false, openedPorts: [...openedPorts], loopbackPorts: [...loopbackPorts], pid });
      }
    });
    const timer = setTimeout(
      () =>
        settle({
          ok: false,
          openedPorts: [...openedPorts],
          loopbackPorts: [...loopbackPorts],
          pid,
          stderr: `no port opened within ${VM_SERVE_TIMEOUT_MS / 1000}s (does the server bind 0.0.0.0?)`,
        }),
      VM_SERVE_TIMEOUT_MS,
    );
    // Start detached: resolves on process START; we NEVER await its exit.
    runtime.exec(commandLine).then(
      (handle) => {
        pid = handle.pid;
        // If it exits BEFORE opening a port (e.g. a crash / EADDRINUSE), surface it.
        void handle.wait().then(async (status) => {
          if (settled) return;
          const stderr = await handle.stderr.text();
          settle({ ok: false, openedPorts: [...openedPorts], loopbackPorts: [...loopbackPorts], pid, code: status.code, stderr });
        });
      },
      (err: unknown) =>
        settle({ ok: false, openedPorts: [], loopbackPorts: [], code: -1, stderr: err instanceof Error ? err.message : String(err) }),
    );
  });
}

function runServeRegistering(runtime: ServeRuntime, shell: RpcShellSession, commandLine: string): Promise<RunServeResult> {
  return new Promise((resolve) => {
    const openedPorts: number[] = [];
    let settled = false;
    let exited = false;
    const unsub = runtime.subscribe((e: RuntimeEvent) => {
      if (e.type !== "port.opened") return;
      openedPorts.push(e.port);
      if (settled || exited) return;
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: true, openedPorts, loopbackPorts: [] });
        }
      }, 0);
    });
    shell.exec(commandLine).then(
      async (r) => {
        exited = true;
        if (r.code === 0 && openedPorts.length === 0) {
          await new Promise((tick) => setTimeout(tick, 0));
        }
        unsub();
        if (settled) return;
        settled = true;
        resolve({ ok: r.code === 0, openedPorts, loopbackPorts: [], code: r.code, stdout: r.stdout, stderr: r.stderr });
      },
      (err: unknown) => {
        exited = true;
        unsub();
        if (settled) return;
        settled = true;
        resolve({ ok: false, openedPorts, loopbackPorts: [], code: -1, stderr: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}
