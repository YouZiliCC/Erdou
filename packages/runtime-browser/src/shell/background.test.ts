import { describe, it, expect } from "vitest";
import { makeShell } from "./harness.js";
import { BrowserRuntime } from "../browser-runtime.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Run one line to completion and return its captured streams. */
async function runLine(
  shell: ReturnType<typeof makeShell>["shell"],
  line: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = shell.execute(line);
  const [code, stdout, stderr] = await Promise.all([r.wait(), r.stdout.text(), r.stderr.text()]);
  return { code, stdout, stderr };
}

/** Extract the pid from a "[pid] command" announce line. */
function announcedPid(stdout: string): number {
  const m = stdout.match(/^\[(\d+)\] /);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

describe("background execution (trailing &)", () => {
  it("returns immediately, announces '[pid] cmd', and the job is visible in the process table", async () => {
    const { shell, table } = makeShell();
    table.register("hang", () => new Promise<number>(() => {}));
    const r = await runLine(shell, "hang &");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\[\d+\] hang\n$/);
    const pid = announcedPid(r.stdout);
    const job = table.list().find((p) => p.pid === pid);
    expect(job?.state).toBe("running");
    expect(job?.cmd).toBe("hang");
    // The stage process is tracked too, under its own pid.
    const stage = table.list().find((p) => p.cmd === "hang" && p.pid !== pid);
    expect(stage?.state).toBe("running");
  });

  it("kill <job pid> kills the whole job including its running stages", async () => {
    const { shell, table } = makeShell();
    table.register("hang", () => new Promise<number>(() => {}));
    const pid = announcedPid((await runLine(shell, "hang &")).stdout);
    table.kill(pid, "SIGTERM");
    expect((await table.wait(pid)).signal).toBe("SIGTERM");
    const stage = table.list().find((p) => p.cmd === "hang" && p.pid !== pid);
    expect(stage?.state).toBe("killed");
    expect(table.list().filter((p) => p.state === "running")).toEqual([]);
  });

  it("jobs lifecycle: running -> done reported once with buffered output -> gone", async () => {
    const { shell, table } = makeShell();
    let finish!: (code: number) => void;
    table.register("slow", (ctx) => {
      ctx.stdout.write("slow-out\n");
      return new Promise<number>((res) => {
        finish = res;
      });
    });
    const pid = announcedPid((await runLine(shell, "slow &")).stdout);

    let j = await runLine(shell, "jobs");
    expect(j.code).toBe(0);
    expect(j.stdout).toBe(`[${pid}] running  slow\n`);

    await flush();
    finish(0);
    await table.wait(pid);

    j = await runLine(shell, "jobs");
    expect(j.stdout).toBe(`[${pid}] done (0)  slow\nslow-out\n`);

    j = await runLine(shell, "jobs");
    expect(j.stdout).toBe(""); // reported once, then dropped
  });

  it("buffered output never interleaves with foreground commands", async () => {
    const { shell, table } = makeShell();
    const launch = await runLine(shell, "echo bg-noise &");
    expect(launch.stdout).toMatch(/^\[\d+\] echo bg-noise\n$/); // announce only, no job output
    const pid = announcedPid(launch.stdout);
    const fg = await runLine(shell, "echo fg");
    expect(fg.stdout).toBe("fg\n");
    await table.wait(pid);
    const j = await runLine(shell, "jobs");
    expect(j.stdout).toBe(`[${pid}] done (0)  echo bg-noise\nbg-noise\n`);
  });

  it("buffers a failing job's stderr and surfaces it via jobs with the exit code", async () => {
    const { shell, table } = makeShell();
    const launch = await runLine(shell, "cat /nope.txt &");
    expect(launch.stderr).toBe(""); // error is buffered on the job, not the prompt
    const pid = announcedPid(launch.stdout);
    expect((await table.wait(pid)).code).toBe(1);
    const j = await runLine(shell, "jobs");
    expect(j.stdout).toBe(`[${pid}] done (1)  cat /nope.txt\n`);
    expect(j.stderr).toMatch(/ENOENT/);
  });

  it("a trailing & backgrounds a whole pipeline", async () => {
    const { shell, table } = makeShell();
    const pid = announcedPid((await runLine(shell, "echo hi | grep h &")).stdout);
    expect((await table.wait(pid)).code).toBe(0);
    const j = await runLine(shell, "jobs");
    expect(j.stdout).toBe(`[${pid}] done (0)  echo hi | grep h\nhi\n`);
  });

  it("a trailing & backgrounds a whole &&-list", async () => {
    const { shell, table } = makeShell();
    const pid = announcedPid((await runLine(shell, "echo a && echo b &")).stdout);
    expect((await table.wait(pid)).code).toBe(0);
    const j = await runLine(shell, "jobs");
    expect(j.stdout).toBe(`[${pid}] done (0)  echo a && echo b\na\nb\n`);
  });

  it("a killed job reports done (143) once, with no phantom output", async () => {
    const { shell, table } = makeShell();
    table.register("hang", () => new Promise<number>(() => {}));
    const pid = announcedPid((await runLine(shell, "hang &")).stdout);
    table.kill(pid, "SIGTERM");
    await table.wait(pid);
    let j = await runLine(shell, "jobs");
    expect(j.stdout).toBe(`[${pid}] done (143)  hang\n`);
    j = await runLine(shell, "jobs");
    expect(j.stdout).toBe("");
  });

  it("jobs rejects arguments loudly", async () => {
    const { shell } = makeShell();
    const j = await runLine(shell, "jobs -l");
    expect(j.code).toBe(2);
    expect(j.stderr).toMatch(/jobs: takes no arguments/);
  });

  it("a non-trailing & ('cmd1 & cmd2') is rejected, nothing runs", async () => {
    const { shell } = makeShell();
    const r = await runLine(shell, "echo a & echo b");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/EINVAL/);
    expect(r.stderr).toMatch(/'cmd1 & cmd2' is not/);
  });

  it("session-level: ps sees the job, the kill builtin works on it, jobs reports the kill", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.registerProgram("hang", () => new Promise<number>(() => {}));
    const sh = rt.openShell();
    const launch = await sh.exec("hang &");
    expect(launch.code).toBe(0);
    const pid = announcedPid(launch.stdout);
    const ps = await sh.exec("ps");
    expect(ps.stdout).toContain(`${pid} 0 running hang`);
    const k = await sh.exec(`kill ${pid}`);
    expect(k.code).toBe(0);
    await rt.wait(pid);
    expect((await sh.exec("jobs")).stdout).toBe(`[${pid}] done (143)  hang\n`);
    expect((await sh.exec("jobs")).stdout).toBe("");
  });
});
