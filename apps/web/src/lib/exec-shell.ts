import type { Runtime } from "@erdou/runtime-contract";
import type { RpcShellSession } from "./kernel.js";

// A rare marker prefixing the trailing pwd line so we can split it off the
// command's real stdout. Randomized once per module so it cannot collide with
// user output. (Plan-review I3: NO subshell — a `( <line> )` wrapper runs any
// `cd` in a child that exits immediately, so cwd would never advance.)
const MARK = "__EX_" + Math.random().toString(36).slice(2) + "__";

/** A persistent request/response shell over a runtime whose native shell is a
 *  real guest (the VM). Each command runs as `cd <cwd>; <line>; __rc=$?;
 *  printf MARK"$(pwd)"; exit $__rc` — NO subshell, so a `cd` inside <line>
 *  updates the cwd that the trailing `pwd` reports and that we thread into the
 *  next call (a fresh `exec` otherwise starts at /). */
export function createExecShell(runtime: Pick<Runtime, "exec">): RpcShellSession {
  let cwd = "/";
  return {
    get cwd() { return cwd; },
    async exec(line: string) {
      const wrapped = `cd ${shq(cwd)} 2>/dev/null; ${line}; __rc=$?; printf '${MARK}%s\\n' "$(pwd)"; exit $__rc`;
      const proc = await runtime.exec(wrapped);
      const [status, rawOut, stderr] = await Promise.all([proc.wait(), proc.stdout.text(), proc.stderr.text()]);
      // strip the trailing MARK sentinel line, update cwd
      let stdout = rawOut;
      const idx = rawOut.lastIndexOf(MARK);
      if (idx !== -1) {
        const after = rawOut.slice(idx + MARK.length);
        const nl = after.indexOf("\n");
        cwd = (nl === -1 ? after : after.slice(0, nl)).trim() || cwd;
        stdout = rawOut.slice(0, idx);
      }
      return { code: status.code, stdout, stderr };
    },
  };
}

const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
