import { describe, it, expect } from "vitest";
import { createExecShell } from "./exec-shell.js";
import type { ProcessHandle } from "@erdou/runtime-contract";

/** A tiny shell simulator over `runtime.exec`. It receives the WRAPPED command
 *  line createExecShell builds, resolves the final cwd from the ordered `cd`
 *  targets in it (including the leading `cd '<cwd>'` the impl prepends), runs a
 *  `stdoutFor` hook for visible output, and appends the `<MARK><pwd>\n` line the
 *  impl looks for. MARK is EXTRACTED from the wrapped line's `printf`, so the
 *  test works regardless of the impl's random marker — no hard-coding. */
function fakeRuntime(stdoutFor: (wrapped: string) => { code?: number; stdout?: string; stderr?: string } = () => ({})) {
  const calls: string[] = [];
  return {
    calls,
    exec: async (wrapped: string): Promise<ProcessHandle> => {
      calls.push(wrapped);
      let cwd = "/";
      for (const m of wrapped.matchAll(/cd\s+(?:'([^']*)'|([^\s;]+))/g)) {
        const t = (m[1] ?? m[2])!;
        cwd = t.startsWith("/") ? t : cwd.replace(/\/$/, "") + "/" + t;
      }
      const mark = /printf '([^']+)%s/.exec(wrapped)?.[1] ?? "";
      const r = stdoutFor(wrapped);
      const stdout = (r.stdout ?? "") + mark + cwd + "\n";
      return {
        pid: 1,
        stdout: { read: async function* () {}, text: async () => stdout },
        stderr: { read: async function* () {}, text: async () => r.stderr ?? "" },
        stdin: { write() {}, end() {} },
        wait: async () => ({ code: r.code ?? 0, signal: null }),
        kill: async () => {},
      } as unknown as ProcessHandle;
    },
  };
}

describe("createExecShell", () => {
  it("runs a command, returns code/stdout/stderr, and strips the pwd sentinel", async () => {
    const rt = fakeRuntime(() => ({ code: 0, stdout: "hi\n", stderr: "" }));
    const shell = createExecShell(rt);
    const r = await shell.exec("echo hi");
    expect(r).toEqual({ code: 0, stdout: "hi\n", stderr: "" }); // MARK line split off stdout
  });

  it("tracks cwd across cd — no subshell (the prompt follows)", async () => {
    const rt = fakeRuntime();
    const shell = createExecShell(rt);
    await shell.exec("cd /tmp");
    expect(shell.cwd).toBe("/tmp");      // would stay "/" if <line> ran in a `( … )` subshell
    await shell.exec("cd sub");          // relative cd resolves against the tracked cwd
    expect(shell.cwd).toBe("/tmp/sub");
  });
});
