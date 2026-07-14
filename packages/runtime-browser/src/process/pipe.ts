import type { ProcessRecord } from "./process-table.js";

/**
 * Wire one process's stdout into the next's stdin, closing the downstream
 * stdin once the upstream finishes. The downstream must have been spawned with
 * `pipeStdin: true` so its stdin was left open for us.
 */
export function pipeProcesses(from: ProcessRecord, to: ProcessRecord): void {
  void (async () => {
    for await (const chunk of from.stdout.read()) {
      to.stdin.write(chunk);
    }
    to.stdin.end();
  })();
}
