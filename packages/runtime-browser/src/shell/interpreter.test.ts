import { describe, it, expect } from "vitest";
import { makeShell } from "./harness.js";

describe("Shell interpreter", () => {
  it("runs a pipeline", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo hi | grep h");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("hi\n");
  });

  it("redirects stdout to a file with > and >>", async () => {
    const { shell } = makeShell();
    await shell.run("echo x > /f.txt");
    let r = shell.execute("cat /f.txt");
    await r.wait();
    expect(await r.stdout.text()).toBe("x\n");

    await shell.run("echo y >> /f.txt");
    r = shell.execute("cat /f.txt");
    await r.wait();
    expect(await r.stdout.text()).toBe("x\ny\n");
  });

  it("feeds a file into stdin with <", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/in.txt", "alpha\nbeta\n");
    const r = shell.execute("grep beta < /in.txt");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("beta\n");
  });

  it("honors && and || short-circuiting", async () => {
    const { shell } = makeShell();
    let r = shell.execute("false && echo no");
    expect(await r.wait()).toBe(1);
    expect(await r.stdout.text()).toBe("");

    r = shell.execute("false || echo yes");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("yes\n");
  });

  it("cd mutates the working directory across the pipeline", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/tmp");
    const r = shell.execute("cd /tmp && pwd");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("/tmp\n");
  });

  it("export sets an environment variable used by later expansion", async () => {
    const { shell } = makeShell();
    const r = shell.execute("export A=1 && echo $A");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("1\n");
  });

  it("writes backslash-escaped quotes through a redirect verbatim", async () => {
    const { shell, vfs } = makeShell();
    expect(await shell.run('echo "{\\"a\\": \\"b\\"}" > /j.json')).toBe(0);
    expect(vfs.readFileText("/j.json")).toBe('{"a": "b"}\n');
  });

  it("gives a > on a non-final pipeline stage the output, not the pipe", async () => {
    const { shell, vfs } = makeShell();
    const r = shell.execute("echo hi > /f.txt | cat");
    expect(await r.wait()).toBe(0);
    // POSIX: the redirect wins, so `cat` sees an empty stdin and prints nothing
    // — and crucially the file gets ALL of the output, not a share of it.
    expect(await r.stdout.text()).toBe("");
    expect(vfs.readFileText("/f.txt")).toBe("hi\n");
  });

  it("keeps every line when a redirected stage produces many chunks", async () => {
    const { shell, vfs, table } = makeShell();
    table.register("many", async (ctx) => {
      for (let n = 0; n < 20; n++) ctx.stdout.write(`line${n}\n`);
      return 0;
    });
    const r = shell.execute("many > /many.txt | cat");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
    const expected = Array.from({ length: 20 }, (_, n) => `line${n}\n`).join("");
    expect(vfs.readFileText("/many.txt")).toBe(expected);
  });

  it("expands $? to the previous command's exit status", async () => {
    const { shell } = makeShell();
    let r = shell.execute("echo $?");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("0\n"); // nothing has run yet

    r = shell.execute("false; echo $?");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("1\n");
  });

  it("carries $? across execute() calls, like a session", async () => {
    const { shell } = makeShell();
    expect(await shell.run("false")).toBe(1);
    const r = shell.execute("echo $?");
    await r.wait();
    expect(await r.stdout.text()).toBe("1\n");
  });

  it("leaves $? at the status of the & itself, not of the job's later exit", async () => {
    const { shell, table } = makeShell();
    expect(await shell.run("false &")).toBe(0);
    // The adopted composite is allocated before the job's own `false` process,
    // so it is the first "false" in the table; waiting on it means the job is
    // fully finished — a shared last-status cell would read 1 by now.
    const job = table.list().find((p) => p.cmd === "false");
    await table.wait(job!.pid);
    const r = shell.execute("echo $?");
    await r.wait();
    expect(await r.stdout.text()).toBe("0\n");
  });

  it("resets $? to 0 on a `&` launch — a prior failure must not linger", async () => {
    // bash: the exit status of an asynchronous list is zero. The fresh-shell
    // test above cannot see this — its status cell already reads 0.
    const { shell } = makeShell();
    expect(await shell.run("false")).toBe(1);
    expect(await shell.run("echo hi &")).toBe(0);
    const r = shell.execute("echo $?");
    await r.wait();
    expect(await r.stdout.text()).toBe("0\n");
  });

  // ---- fd duplication (2>&1 and friends) -----------------------------------

  /** A program that writes to BOTH streams, so a test can tell them apart. */
  const withNoisy = (): ReturnType<typeof makeShell> => {
    const h = makeShell();
    h.table.register("noisy", async (ctx) => {
      ctx.stdout.write("out\n");
      ctx.stderr.write("err\n");
      return 0;
    });
    return h;
  };

  it("2>&1 folds stderr into the shell's stdout on the last stage", async () => {
    const { shell } = withNoisy();
    const r = shell.execute("noisy 2>&1");
    expect(await r.wait()).toBe(0);
    expect((await r.stdout.text()).split("\n").sort().join("\n")).toBe("\nerr\nout");
    expect(await r.stderr.text()).toBe("");
  });

  it("2>&1 puts stderr into the PIPE, so `cmd 2>&1 | grep` can see it", async () => {
    const { shell } = withNoisy();
    const r = shell.execute("noisy 2>&1 | grep err");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("err\n");
  });

  it("keeps stderr off the pipe without 2>&1", async () => {
    const { shell } = withNoisy();
    const r = shell.execute("noisy | grep err");
    expect(await r.wait()).toBe(1); // grep found nothing
    expect(await r.stderr.text()).toBe("err\n");
  });

  it("`> f 2>&1` sends both streams to the file", async () => {
    const { shell, vfs } = withNoisy();
    expect(await shell.run("noisy > /log 2>&1")).toBe(0);
    expect(vfs.readFileText("/log").split("\n").sort().join("\n")).toBe("\nerr\nout");
  });

  it("`2>&1 > f` sends only stdout to the file — order decides, as in POSIX", async () => {
    const { shell, vfs } = withNoisy();
    const r = shell.execute("noisy 2>&1 > /log");
    expect(await r.wait()).toBe(0);
    // fd 2 was duplicated from fd 1 BEFORE fd 1 was pointed at the file, so it
    // still holds the shell's stdout.
    expect(vfs.readFileText("/log")).toBe("out\n");
    expect(await r.stdout.text()).toBe("err\n");
    expect(await r.stderr.text()).toBe("");
  });

  it("`&>` and `&>>` write both streams to one file", async () => {
    const { shell, vfs } = withNoisy();
    expect(await shell.run("noisy &> /log")).toBe(0);
    expect(vfs.readFileText("/log").split("\n").sort().join("\n")).toBe("\nerr\nout");
    expect(await shell.run("noisy &>> /log")).toBe(0);
    expect(vfs.readFileText("/log").split("\n").filter((l) => l !== "")).toHaveLength(4);
  });

  it("1>&2 sends stdout to the shell's stderr", async () => {
    const { shell } = withNoisy();
    const r = shell.execute("noisy 1>&2");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
    expect((await r.stderr.text()).split("\n").sort().join("\n")).toBe("\nerr\nout");
  });

  it("does not truncate the merged stream when one side finishes first", async () => {
    const { shell, table } = makeShell();
    table.register("lopsided", async (ctx) => {
      ctx.stderr.write("e0\n");
      for (let n = 0; n < 20; n++) ctx.stdout.write(`o${n}\n`);
      return 0;
    });
    // Both streams feed `cat`'s stdin; ending it when the FIRST source finished
    // would drop the other's output.
    const r = shell.execute("lopsided 2>&1 | cat");
    expect(await r.wait()).toBe(0);
    const lines = (await r.stdout.text()).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(21);
    expect(lines).toContain("e0");
    expect(lines).toContain("o19");
  });

  it("keeps the WRITE ORDER when two fds share a destination", async () => {
    // The whole point of `2>&1`: a 4-line stack trace on stderr must arrive as
    // four consecutive lines. Draining the two streams with one pump each
    // consumed them round-robin — `1 E1 2 E2 3 4 5` for a program that wrote
    // `1..5` then `E1 E2` — shredding exactly the output the idiom exists to
    // capture. Sharing ONE stream between the fds is what a real dup2 does.
    const { shell, vfs, table } = makeShell();
    table.register("ordered", async (ctx) => {
      for (let n = 1; n <= 5; n++) ctx.stdout.write(`${n}\n`);
      ctx.stderr.write("E1\n");
      ctx.stderr.write("E2\n");
      return 0;
    });
    expect(await shell.run("ordered &> /log")).toBe(0);
    expect(vfs.readFileText("/log")).toBe("1\n2\n3\n4\n5\nE1\nE2\n");

    const r = shell.execute("ordered 2>&1");
    await r.wait();
    expect(await r.stdout.text()).toBe("1\n2\n3\n4\n5\nE1\nE2\n");

    const piped = shell.execute("ordered 2>&1 | cat");
    await piped.wait();
    expect(await piped.stdout.text()).toBe("1\n2\n3\n4\n5\nE1\nE2\n");
  });

  it("waits for EVERY pipeline stage, not just the last — a dup must not change that", async () => {
    // Each stage used to be joined implicitly by its unconditional stderr
    // drain. `2>&1` puts stderr on the pipe instead, removing that drain — so
    // the pipeline settled while an upstream process was still running and its
    // later output went nowhere. POSIX: the shell waits for all of them.
    const { shell, table } = makeShell();
    table.register("hang", async (ctx) => {
      ctx.stdout.write("o\n");
      return new Promise<number>(() => {});
    });
    const r = shell.execute("hang 2>&1 | true");
    const outcome = await Promise.race([
      r.wait().then(() => "settled"),
      new Promise((res) => setTimeout(() => res("still waiting"), 60)),
    ]);
    expect(outcome).toBe("still waiting");
    r.kill();
    await r.wait();
  });

  it("opens every `<` in order and lets the LAST one win", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/a", "AAA\n");
    vfs.writeFile("/b", "BBB\n");
    const r = shell.execute("cat < /a < /b");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("BBB\n");

    // …and an earlier one that cannot be opened still fails the command,
    // rather than being skipped because a later one happened to work.
    const missing = shell.execute("cat < /nope < /b");
    expect(await missing.wait()).toBe(2);
    expect(await missing.stderr.text()).toMatch(/ENOENT/);
  });

  it("creates and truncates an output target that a later redirect overrides", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/a", "PREEXISTING\n");
    expect(await shell.run("echo hi > /a > /b")).toBe(0);
    // bash opens every target in order; only the last receives data, but the
    // overridden one is still opened — and opening with `>` truncates.
    expect(vfs.readFileText("/a")).toBe("");
    expect(vfs.readFileText("/b")).toBe("hi\n");
  });

  it("truncates the log even when the command never runs", async () => {
    // The silent-wrong this prevents: the agent re-runs a failing command,
    // cats the log, and reads the PREVIOUS run's output as if it were this
    // run's. bash opens redirects before it looks for the command.
    const { shell, vfs } = makeShell();
    vfs.writeFile("/log", "OLD RUN\n");
    expect(await shell.run("nosuchcmd > /log 2>&1")).toBe(2);
    expect(vfs.readFileText("/log")).toBe("");
  });

  it("refuses to run the command when a redirect target cannot be opened", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/d");
    const r = shell.execute("touch /d/marker > /nodir/f");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/ENOENT/);
    // The command must not have run: bash opens redirects BEFORE exec, so the
    // side effect never happens.
    expect(vfs.exists("/d/marker")).toBe(false);
  });

  it("refuses conflicting > and >> redirects to one file instead of clobbering", async () => {
    const { shell } = withNoisy();
    const r = shell.execute("noisy > /log 2>> /log");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/EINVAL.*conflicting/);
  });

  // ---- redirects on the in-process builtins (cd / export / jobs) -----------

  it("sends a builtin's output to its redirect target, not to the terminal", async () => {
    const { shell, vfs, table } = makeShell();
    expect(await shell.run("true &")).toBe(0);
    const job = table.list().find((p) => p.cmd === "true");
    await table.wait(job!.pid);
    const r = shell.execute("jobs > /jobs.log");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
    expect(vfs.readFileText("/jobs.log")).toContain("true");
  });

  it("sends cd's error to its redirect target and leaves the cwd alone", async () => {
    const { shell, vfs } = makeShell();
    const r = shell.execute("cd /nope 2> /e");
    expect(await r.wait()).toBe(1);
    expect(await r.stderr.text()).toBe("");
    expect(vfs.readFileText("/e")).toMatch(/ENOENT/);
    expect(shell.cwd).toBe("/");
  });

  it("creates a silent builtin's redirect target and still applies its effect", async () => {
    const { shell, vfs } = makeShell();
    expect(await shell.run("export X=1 > /f")).toBe(0);
    expect(vfs.readFileText("/f")).toBe("");
    const r = shell.execute("echo $X");
    await r.wait();
    expect(await r.stdout.text()).toBe("1\n");
  });

  it("does not run a builtin whose redirect target cannot be opened", async () => {
    // bash sets the redirect up BEFORE the builtin, so the side effect — the
    // cwd move, the assignment — never happens.
    const { shell, vfs } = makeShell();
    vfs.mkdir("/sub");
    const r = shell.execute("cd /sub > /nodir/f");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/ENOENT/);
    expect(shell.cwd).toBe("/");

    expect(await shell.run("export Y=9 > /nodir/f")).toBe(2);
    const y = shell.execute("echo $Y");
    await y.wait();
    expect(await y.stdout.text()).toBe("\n"); // never assigned
  });

  it("opens a builtin's `<` too, so a missing one fails the builtin", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/sub");
    const r = shell.execute("cd /sub < /nope");
    expect(await r.wait()).toBe(2);
    expect(shell.cwd).toBe("/");
  });

  it("resolves a builtin's relative target against the cwd BEFORE cd moves it", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/sub");
    expect(await shell.run("cd /sub > rel.log")).toBe(0);
    expect(shell.cwd).toBe("/sub");
    expect(vfs.exists("/rel.log")).toBe(true); // NOT /sub/rel.log
  });

  it("merges a builtin's streams for &>", async () => {
    const { shell, vfs } = makeShell();
    const r = shell.execute("cd /nope &> /log");
    expect(await r.wait()).toBe(1);
    expect(await r.stdout.text()).toBe("");
    expect(await r.stderr.text()).toBe("");
    expect(vfs.readFileText("/log")).toMatch(/ENOENT/);
  });

  it("refuses a builtin in a pipeline instead of silently running a no-op", async () => {
    // cd/export/jobs are ALSO registered in the program registry as no-ops (so
    // `which cd` answers). Only a single-command line reaches the in-process
    // handler, so a piped builtin used to spawn that no-op: `jobs | cat` exited
    // 0 with no output — indistinguishable from "there are no jobs" — and
    // `cd /nope | cat` reported success without attempting the cd.
    const { shell, vfs } = makeShell();
    vfs.mkdir("/sub");
    for (const line of ["jobs | cat", "cd /nope | cat", "echo x | cd /sub"]) {
      const r = shell.execute(line);
      expect(await r.wait()).toBe(2);
      expect(await r.stderr.text()).toMatch(/EINVAL.*shell builtin/);
    }
    expect(shell.cwd).toBe("/");
  });

  it("treats an unquoted # starting a word as a comment", async () => {
    const { shell } = makeShell();
    let r = shell.execute("echo hi # not arguments");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("hi\n");
    r = shell.execute("# a whole-line comment");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
  });

  // ---- command substitution -------------------------------------------------

  it("substitutes $(...) with the command's stdout, trailing newlines stripped", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo [$(echo hi)]");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("[hi]\n");
  });

  it("substitutes inside double quotes and nests", async () => {
    const { shell } = makeShell();
    let r = shell.execute('echo "value: $(echo deep)"');
    await r.wait();
    expect(await r.stdout.text()).toBe("value: deep\n");

    r = shell.execute("echo $(echo $(echo nested))");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("nested\n");
  });

  it("leaves $(...) alone inside single quotes", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo '$(echo hi)'");
    await r.wait();
    expect(await r.stdout.text()).toBe("$(echo hi)\n");
  });

  it("expands a substitution in a redirect target", async () => {
    const { shell, vfs } = makeShell();
    expect(await shell.run("echo written > $(echo /out.txt)")).toBe(0);
    expect(vfs.readFileText("/out.txt")).toBe("written\n");
  });

  it("runs the substitution in a SUBSHELL — cd and export do not leak out", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/sub");
    expect(await shell.run("echo $(cd /sub && pwd)")).toBe(0);
    expect(shell.cwd).toBe("/"); // the cd happened in the subshell only
    expect(await shell.run("echo $(export LEAK=1)")).toBe(0);
    const r = shell.execute("echo [$LEAK]");
    await r.wait();
    expect(await r.stdout.text()).toBe("[]\n");
  });

  it("gives the substitution the shell's env and cwd", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/sub");
    const r = shell.execute("export A=avalue && cd /sub && echo $(echo $A) $(pwd)");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("avalue /sub\n");
  });

  it("lets $? inside a $(...) see the caller's current status", async () => {
    // bash: a command-substitution subshell inherits $?, exactly as it inherits
    // the cwd and env.
    const { shell } = makeShell();
    const r = shell.execute("false; echo $(echo $?)");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("1\n");
  });

  it("passes the substitution's stderr through and does not adopt its exit code", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo [$(nosuchcmd)]");
    expect(await r.wait()).toBe(0); // echo succeeded; bash does the same
    expect(await r.stdout.text()).toBe("[]\n");
    expect(await r.stderr.text()).toMatch(/ENOENT/);
  });

  it("does NOT word-split a substitution, matching how $VAR already behaves here", async () => {
    const { shell, table } = makeShell();
    table.register("argc", async (ctx) => {
      ctx.stdout.write(`${ctx.argv.length - 1}\n`);
      return 0;
    });
    // One argument, not two — this shell never field-splits an expansion.
    let r = shell.execute("argc $(echo a b)");
    await r.wait();
    expect(await r.stdout.text()).toBe("1\n");
    // …exactly as it already treats an unquoted $VAR.
    r = shell.execute("export S=a b && argc $S");
    await r.wait();
    expect(await r.stdout.text()).toBe("1\n");
  });

  it("keeps a multi-line substitution intact apart from the trailing newlines", async () => {
    const { shell, table } = makeShell();
    table.register("two", async (ctx) => {
      ctx.stdout.write("l1\nl2\n\n");
      return 0;
    });
    const r = shell.execute("echo [$(two)]");
    await r.wait();
    expect(await r.stdout.text()).toBe("[l1\nl2]\n");
  });

  it("rejects an unterminated $( and still rejects backticks and $((", async () => {
    const { shell } = makeShell();
    let r = shell.execute("echo $(echo hi");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/unterminated \$\(/);
    r = shell.execute("echo `pwd`");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/command substitution is not supported: `\.\.\.`/);
    r = shell.execute("echo $((1+2))");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/arithmetic expansion is not supported/);
  });

  it("does not spawn the pipeline when kill() lands during a $(...) expansion", async () => {
    // kill() kills the records running at that instant and sets `canceled`; the
    // outer stages do not exist yet, so spawning them after the substitution
    // unwinds would leave processes the kill loop can never reach — and wait()
    // pending forever on them.
    const { shell, table } = makeShell();
    table.register("hang", () => new Promise<number>(() => {}));
    table.register("server", () => new Promise<number>(() => {}));
    const r = shell.execute("server $(hang)");
    await new Promise((res) => setTimeout(res, 10)); // let the substitution's hang spawn
    r.kill();
    const outcome = await Promise.race([
      r.wait().then((code) => `settled ${code}`),
      new Promise((res) => setTimeout(() => res("still waiting"), 60)),
    ]);
    expect(outcome).toBe("settled 143"); // 128 + SIGTERM, like the killed stages report
    expect(table.list().find((p) => p.cmd === "server")).toBeUndefined();
  });

  it("rejects a < on a later pipeline stage instead of silently ignoring it", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/in.txt", "beta\n");
    const r = shell.execute("echo alpha | grep beta < /in.txt");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/EINVAL.*stage 2/);
  });

  it("kills the already-spawned stages when a later stage fails to spawn", async () => {
    const { shell, table } = makeShell();
    table.register("hang", () => new Promise<number>(() => {}));
    const r = shell.execute("hang | nosuchcmd");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toMatch(/ENOENT.*nosuchcmd/);
    const hang = table.list().find((p) => p.cmd === "hang");
    expect(hang?.state).toBe("killed");
  });
});

describe("/dev/null", () => {
  // The VFS root boots empty — there is no /dev — so these used to fail the
  // WHOLE line with ENOENT at openTargets, before the command ever ran.
  it("2>/dev/null discards stderr and the command still runs", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo hi 2>/dev/null");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("hi\n");
    expect(await r.stderr.text()).toBe("");
  });

  it(">/dev/null discards stdout without creating a file", async () => {
    const { shell, vfs } = makeShell();
    const r = shell.execute("echo hi > /dev/null");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
    expect(vfs.exists("/dev/null")).toBe(false);
    expect(vfs.exists("/dev")).toBe(false);
  });

  it("a failing first command with 2>/dev/null does not stop the rest of the line", async () => {
    const { shell } = makeShell();
    const r = shell.execute("cat /nope 2>/dev/null; echo done");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("done\n");
    expect(await r.stderr.text()).toBe("");
  });

  it("</dev/null feeds an empty stdin", async () => {
    const { shell } = makeShell();
    const r = shell.execute("cat < /dev/null");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
  });

  it(">/dev/null 2>&1 silences both fds", async () => {
    const { shell, table } = makeShell();
    table.register("both", async (ctx) => {
      ctx.stdout.write("out\n");
      ctx.stderr.write("err\n");
      return 0;
    });
    const r = shell.execute("both > /dev/null 2>&1");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
    expect(await r.stderr.text()).toBe("");
  });

  it(">>/dev/null discards too (append mode is meaningless on a discard)", async () => {
    const { shell, vfs } = makeShell();
    const r = shell.execute("echo hi >> /dev/null");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
    expect(vfs.exists("/dev/null")).toBe(false);
  });

  it("redirects on the in-process builtins accept /dev/null as well", async () => {
    const { shell } = makeShell();
    const r = shell.execute("cd /nope 2>/dev/null");
    expect(await r.wait()).toBe(1);
    expect(await r.stderr.text()).toBe("");
  });

  it(">/dev/null on a non-final stage still takes the output off the pipe", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo hi > /dev/null | cat");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
  });
});
