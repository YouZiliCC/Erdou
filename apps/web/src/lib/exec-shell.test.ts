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
      // Model shell cwd with SUBSHELL semantics: a `cd` inside a ( … ) subshell
      // runs in a child and does NOT change the parent cwd. Split on parens,
      // track depth, and honor `cd` only at depth 0 — so if the impl ever wrapped
      // the user line in a subshell, cwd would stop advancing and this test fails.
      let cwd = "/";
      let depth = 0;
      for (const seg of wrapped.split(/([()])/)) {
        if (seg === "(") { depth++; continue; }
        if (seg === ")") { depth = Math.max(0, depth - 1); continue; }
        if (depth !== 0) continue;
        for (const m of seg.matchAll(/cd\s+(?:'([^']*)'|([^\s;]+))/g)) {
          const t = (m[1] ?? m[2])!;
          cwd = t.startsWith("/") ? t : cwd.replace(/\/$/, "") + "/" + t;
        }
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
