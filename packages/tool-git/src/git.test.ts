import { describe, it, expect } from "vitest";
import * as igit from "isomorphic-git";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext, Executor } from "@erdou/runtime-contract";
import { createGitRunner } from "./git.js";
import { createGitFs } from "./fs-adapter.js";

/** The paths recorded in HEAD's tree — the only proof a deletion was actually
 *  committed rather than merely dropped from the index. */
async function filesAtHead(vfs: Vfs): Promise<string[]> {
  const fs = createGitFs(vfs) as unknown as Parameters<typeof igit.listFiles>[0]["fs"];
  return igit.listFiles({ fs, dir: "/repo", ref: "HEAD" });
}

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

  it("git add -A stages a deletion, so the commit records it and the tree goes clean", async () => {
    const fs = new Vfs({ clock: () => 1_700_000_000_000 });
    fs.mkdir("/repo", { recursive: true });
    fs.writeFile("/repo/a.txt", "one");
    fs.writeFile("/repo/b.txt", "two");
    const git = createGitRunner({ author: { name: "T", email: "t@e" } });
    await run(git, ["git", "init"], fs);
    await run(git, ["git", "add", "."], fs);
    await run(git, ["git", "commit", "-m", "c1"], fs);

    fs.rm("/repo/a.txt");
    const add = await run(git, ["git", "add", "-A"], fs);
    expect(add.code).toBe(0);
    // Honest accounting: nothing was added, one path was staged for removal.
    expect(add.out).toBe("added 0 file(s), removed 1 file(s)\n");

    expect((await run(git, ["git", "commit", "-m", "delete a"], fs)).code).toBe(0);

    const status = await run(git, ["git", "status"], fs);
    expect(status.out).toMatch(/clean/);
    expect(status.out).not.toContain("a.txt");
  });

  it("git add . stages a deletion too, and leaves surviving files committed", async () => {
    const fs = new Vfs({ clock: () => 1_700_000_000_000 });
    fs.mkdir("/repo/src", { recursive: true });
    fs.writeFile("/repo/src/keep.txt", "keep");
    fs.writeFile("/repo/src/drop.txt", "drop");
    const git = createGitRunner({ author: { name: "T", email: "t@e" } });
    await run(git, ["git", "init"], fs);
    await run(git, ["git", "add", "."], fs);
    await run(git, ["git", "commit", "-m", "c1"], fs);

    fs.rm("/repo/src/drop.txt");
    fs.writeFile("/repo/src/keep.txt", "keep, modified");
    const add = await run(git, ["git", "add", "."], fs);
    expect(add.out).toBe("added 1 file(s), removed 1 file(s)\n");
    await run(git, ["git", "commit", "-m", "c2"], fs);

    expect((await run(git, ["git", "status"], fs)).out).toMatch(/clean/);
    // The removal is in the tree, not merely out of the index: a fresh checkout
    // of HEAD would have keep.txt and no drop.txt.
    expect(await filesAtHead(fs)).toEqual(["src/keep.txt"]);
  });
});
