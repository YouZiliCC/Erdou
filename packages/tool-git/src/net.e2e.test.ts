import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext, Executor } from "@erdou/runtime-contract";
import { createGitRunner } from "./git.js";

// ERDOU_NET_E2E — live clone/fetch/pull against github.com through the default
// isomorphic-git `http/web` client (Node ≥ 18 global fetch; no CORS proxy is
// needed outside a browser). Gated so the default `pnpm test` reports these as
// VISIBLE skips, never as failures — same idiom as runtime-vm/src/net.e2e.
// Proxy-only egress (http_proxy/https_proxy set): Node's fetch ignores those
// env vars by default — run with NODE_USE_ENV_PROXY=1 (Node ≥ 22) or the clone
// fails with "fetch failed — Connect Timeout Error (… github.com:443 …)".
const NET = process.env.ERDOU_NET_E2E === "1";

// octocat/Hello-World: GitHub's canonical tiny public repo (one README file).
const REPO_URL = "https://github.com/octocat/Hello-World";

async function run(
  runner: Executor,
  argv: string[],
  fs: Vfs,
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const stdin = new PipeStream();
  stdin.end();
  const stdout = new PipeStream();
  const stderr = new PipeStream();
  const ctx: ExecContext = { pid: 1, argv, env: {}, cwd, stdin, stdout, stderr, fs, serve: () => {} };
  const code = await runner(ctx);
  stdout.end();
  stderr.end();
  return { code, out: await stdout.text(), err: await stderr.text() };
}

describe.skipIf(!NET)("net.e2e — live git network ops over isomorphic-git/http/web", () => {
  it("clone octocat/Hello-World (no proxy) → files arrive; fetch + ff-only pull are clean no-ops", async () => {
    const fs = new Vfs({ clock: () => 1_700_000_000_000 });
    fs.mkdir("/work", { recursive: true });
    const git = createGitRunner({ author: { name: "T", email: "t@e" } });

    const clone = await run(git, ["git", "clone", REPO_URL, "hw"], fs, "/work");
    expect(clone.code, `clone failed:\n${clone.err}`).toBe(0);
    expect(clone.out).toContain("Cloning into '/work/hw'");
    expect(fs.exists("/work/hw/.git")).toBe(true);
    expect(fs.exists("/work/hw/README")).toBe(true);
    expect(new TextDecoder().decode(fs.readFile("/work/hw/README"))).toContain("Hello World!");

    const log = await run(git, ["git", "log"], fs, "/work/hw");
    expect(log.code, `log failed:\n${log.err}`).toBe(0);
    expect(log.out).toContain("commit ");

    // The clean URL (no credentials were involved) is what got persisted.
    const remotes = await run(git, ["git", "remote", "-v"], fs, "/work/hw");
    expect(remotes.out).toContain(`origin\t${REPO_URL} (fetch)`);

    const fetch = await run(git, ["git", "fetch"], fs, "/work/hw");
    expect(fetch.code, `fetch failed:\n${fetch.err}`).toBe(0);
    expect(fetch.out).toContain(`From ${REPO_URL}`);

    // Freshly cloned → the fast-forward-only pull must be an explicit no-op.
    const pull = await run(git, ["git", "pull", "origin", "master"], fs, "/work/hw");
    expect(pull.code, `pull failed:\n${pull.err}`).toBe(0);
    expect(pull.out).toContain("Already up to date.");
  }, 180_000);
});
