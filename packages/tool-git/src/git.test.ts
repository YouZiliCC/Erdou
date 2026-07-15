import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext, Executor } from "@erdou/runtime-contract";
import { createGitRunner } from "./git.js";

async function run(
  runner: Executor,
  argv: string[],
  fs: Vfs,
): Promise<{ code: number; out: string; err: string }> {
  const stdin = new PipeStream();
  stdin.end();
  const stdout = new PipeStream();
  const stderr = new PipeStream();
  const ctx: ExecContext = { pid: 1, argv, env: {}, cwd: "/repo", stdin, stdout, stderr, fs, serve: () => {} };
  const code = await runner(ctx);
  stdout.end();
  stderr.end();
  return { code, out: await stdout.text(), err: await stderr.text() };
}

describe("git tool (local, isomorphic-git over the Erdou VFS)", () => {
  it("init → add → commit → log", async () => {
    const fs = new Vfs({ clock: () => 1_700_000_000_000 });
    fs.mkdir("/repo", { recursive: true });
    fs.writeFile("/repo/README.md", "# Hello Erdou");
    const git = createGitRunner({ author: { name: "Test", email: "t@e.com" } });

    expect((await run(git, ["git", "init"], fs)).code).toBe(0);
    expect(fs.exists("/repo/.git")).toBe(true);

    expect((await run(git, ["git", "add", "."], fs)).code).toBe(0);

    const commit = await run(git, ["git", "commit", "-m", "first commit"], fs);
    expect(commit.code).toBe(0);
    expect(commit.out).toMatch(/main .+ first commit/);

    const log = await run(git, ["git", "log"], fs);
    expect(log.code).toBe(0);
    expect(log.out).toContain("first commit");
    expect(log.out).toContain("Test <t@e.com>");
  });

  it("status: clean after commit, shows a new file after a change", async () => {
    const fs = new Vfs({ clock: () => 1_700_000_000_000 });
    fs.mkdir("/repo", { recursive: true });
    fs.writeFile("/repo/a.txt", "one");
    const git = createGitRunner({ author: { name: "T", email: "t@e" } });
    await run(git, ["git", "init"], fs);
    await run(git, ["git", "add", "."], fs);
    await run(git, ["git", "commit", "-m", "c1"], fs);

    expect((await run(git, ["git", "status"], fs)).out).toMatch(/clean/);
    fs.writeFile("/repo/b.txt", "two");
    expect((await run(git, ["git", "status"], fs)).out).toContain("b.txt");
  });
});
