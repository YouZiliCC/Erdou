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
