import type { Runtime, RuntimeEvent } from "@erdou/runtime-contract";
import type { RpcShellSession } from "./kernel.js";

export interface RunServeResult {
  ok: boolean;
  /** Ports that opened during this run, in open order (captured from the
   *  event subscription itself — never by diffing a ports list afterwards). */
  openedPorts: number[];
  /** Present when the command exited. */
  code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Run a (possibly serving) command without assuming it exits OR that
 * `port.opened` lands in the same tick (the contract allows async delivery).
 *
 * Resolution rules:
 *  - The command exits → ok iff exit code 0, with code/stdout/stderr. On a
 *    clean exit with no port seen yet, one macrotask of grace lets an
 *    async-delivered `port.opened` land first.
 *  - A `port.opened` arrives while the command is still running → one
 *    macrotask of grace for a fast exit (the simulated kernel's serve returns
 *    immediately — its stdout should make the result); if the command still
 *    hasn't exited by then it is a real blocking server, and the run settles
 *    as ok with the port (we deliberately never wait for a server's exit —
 *    note: its event subscription then stays live until the process ends,
 *    which the browser kernel's registration-model serve always does; a VM
 *    kernel revisits this in Round 11).
 * Never rejects — failures come back as `ok: false`.
 */
export function runServeCommand(
  runtime: Pick<Runtime, "subscribe">,
  shell: RpcShellSession,
  commandLine: string,
): Promise<RunServeResult> {
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
          resolve({ ok: true, openedPorts });
        }
      }, 0);
    });
    shell.exec(commandLine).then(
      async (r) => {
        exited = true;
        if (r.code === 0 && openedPorts.length === 0) {
          // Let an async-delivered port.opened land before concluding "no port".
          await new Promise((tick) => setTimeout(tick, 0));
        }
        unsub();
        if (settled) return;
        settled = true;
        resolve({ ok: r.code === 0, openedPorts, code: r.code, stdout: r.stdout, stderr: r.stderr });
      },
      (err: unknown) => {
        exited = true;
        unsub();
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          openedPorts,
          code: -1,
          stderr: err instanceof Error ? err.message : String(err),
        });
      },
    );
  });
}
