import { describe, it, expect } from "vitest";
import { Vfs, PipeStream } from "@erdou/runtime-browser";
import type { ExecContext, Executor } from "@erdou/runtime-contract";
import type { HttpClient } from "isomorphic-git";
import { createGitRunner } from "./git.js";
import { describeError, makeOnAuth, parseNetArgs, redactSecrets, redactUrl, splitUrlAuth, withRemoteContext } from "./net.js";

async function run(
  runner: Executor,
  argv: string[],
  fs: Vfs,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  const stdin = new PipeStream();
  stdin.end();
  const stdout = new PipeStream();
  const stderr = new PipeStream();
  const ctx: ExecContext = {
    pid: 1,
    argv,
    env: opts.env ?? {},
    cwd: opts.cwd ?? "/repo",
    stdin,
    stdout,
    stderr,
    fs,
    serve: () => {},
  };
  const code = await runner(ctx);
  stdout.end();
  stderr.end();
  return { code, out: await stdout.text(), err: await stderr.text() };
}

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

/**
 * Fake isomorphic-git HttpClient: records every request and answers with the
 * status you choose. A 401 answer makes isomorphic-git invoke onAuth and retry
 * once with an Authorization header — which is exactly how the token-plumbing
 * assertions below observe credentials without a live server.
 */
function fakeHttp(status: (req: Recorded, index: number) => { code: number; message: string }): {
  requests: Recorded[];
  client: HttpClient;
} {
  const requests: Recorded[] = [];
  const client = {
    async request(req: { url: string; method?: string; headers?: Record<string, string> }) {
      const rec: Recorded = { url: req.url, method: req.method, headers: { ...(req.headers ?? {}) } };
      requests.push(rec);
      const s = status(rec, requests.length - 1);
      return {
        url: req.url,
        method: req.method,
        statusCode: s.code,
        statusMessage: s.message,
        headers: {},
        body: [new TextEncoder().encode("fake-body")],
      };
    },
  } as unknown as HttpClient;
  return { requests, client };
}

const deny401 = () => ({ code: 401, message: "Unauthorized" });
const basic = (userpass: string): string => `Basic ${Buffer.from(userpass).toString("base64")}`;

function freshRepo(): Vfs {
  const fs = new Vfs({ clock: () => 1_700_000_000_000 });
  fs.mkdir("/repo", { recursive: true });
  return fs;
}

describe("net helpers (pure)", () => {
  it("redactUrl masks userinfo and leaves credential-free URLs alone", () => {
    expect(redactUrl("https://alice:tok3n@github.com/a/b.git")).toBe("https://***@github.com/a/b.git");
    expect(redactUrl("https://tok3n@github.com/a/b.git")).toBe("https://***@github.com/a/b.git");
    expect(redactUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
  });

  it("redactSecrets scrubs embedded credential URLs anywhere in a message", () => {
    expect(redactSecrets("HTTP Error at https://u:s3cret@host/x.git: denied")).toBe(
      "HTTP Error at https://***@host/x.git: denied",
    );
    expect(redactSecrets("plain message")).toBe("plain message");
  });

  it("splitUrlAuth extracts and strips credentials", () => {
    expect(splitUrlAuth("https://alice:tok@host/r.git")).toEqual({
      url: "https://host/r.git",
      username: "alice",
      password: "tok",
    });
    expect(splitUrlAuth("https://tok@host/r.git")).toEqual({
      url: "https://host/r.git",
      username: "tok",
      password: undefined,
    });
    expect(splitUrlAuth("https://host/r.git").username).toBeUndefined();
  });

  it("splitUrlAuth fails fast on non-http(s) inputs, redacting what it echoes", () => {
    expect(() => splitUrlAuth("git@github.com:a/b.git")).toThrow(/invalid URL/);
    expect(() => splitUrlAuth("ssh://git@host/a.git")).toThrow(/unsupported protocol 'ssh:'/);
    expect(() => splitUrlAuth("ssh://git:tok@host/a.git")).toThrow(/ssh:\/\/\*\*\*@host/);
  });

  it("parseNetArgs: --cors-proxy flag wins over GIT_CORS_PROXY env", () => {
    const env = { GIT_CORS_PROXY: "https://env-proxy" };
    expect(parseNetArgs([], env).corsProxy).toBe("https://env-proxy");
    expect(parseNetArgs(["--cors-proxy", "https://flag-proxy"], env).corsProxy).toBe("https://flag-proxy");
    expect(parseNetArgs([], {}).corsProxy).toBeUndefined();
  });

  it("parseNetArgs: positionals, --force gating, and loud unknown-flag failures", () => {
    expect(parseNetArgs(["origin", "main"], {}).positionals).toEqual(["origin", "main"]);
    expect(parseNetArgs(["--force"], {}, { allowForce: true }).force).toBe(true);
    expect(() => parseNetArgs(["--force"], {})).toThrow(/unknown flag '--force'/);
    expect(() => parseNetArgs(["--cors-proxy"], {})).toThrow(/--cors-proxy requires a value/);
    expect(() => parseNetArgs(["--depth", "1"], {})).toThrow(/unknown flag '--depth'/);
  });

  it("describeError surfaces the undici cause chain — the real transport reason, not just 'fetch failed'", () => {
    // Exact shape undici throws for a connect timeout: the diagnosable part
    // lives ONLY in `cause` (observed live: Node 22 fetch → TypeError).
    const timeout = new TypeError("fetch failed", {
      cause: new Error("Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)"),
    });
    expect(describeError(timeout)).toBe(
      "fetch failed — Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)",
    );
    // Nested chains flatten link by link.
    const dns = new TypeError("fetch failed", {
      cause: new Error("request failed", { cause: new Error("getaddrinfo ENOTFOUND no-such-host.invalid") }),
    });
    expect(describeError(dns)).toBe(
      "fetch failed — request failed — getaddrinfo ENOTFOUND no-such-host.invalid",
    );
    // Non-Errors still describe.
    expect(describeError("plain string failure")).toBe("plain string failure");
  });

  it("describeError redacts credentials anywhere in the chain and unwraps message-less AggregateErrors", () => {
    const leaky = new TypeError("fetch failed", {
      cause: new Error("connect failed to https://alice:s3cret@host/x.git"),
    });
    expect(describeError(leaky)).toBe("fetch failed — connect failed to https://***@host/x.git");
    expect(describeError(leaky)).not.toContain("s3cret");
    // Node's happy-eyeballs multi-address connect failure: an AggregateError
    // with an EMPTY message — the reasons live in .errors.
    const agg = new TypeError("fetch failed", {
      cause: new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:443"), new Error("connect ECONNREFUSED ::1:443")]),
    });
    expect(describeError(agg)).toBe(
      "fetch failed — connect ECONNREFUSED 127.0.0.1:443; connect ECONNREFUSED ::1:443",
    );
    // A cyclic cause chain terminates instead of hanging.
    const cyclic = new Error("a");
    cyclic.cause = cyclic;
    expect(describeError(cyclic)).toBe("a — a — a — a — a");
  });

  it("withRemoteContext appends the redacted cause chain + remote to failures", async () => {
    const op = () =>
      Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.com") }));
    await expect(withRemoteContext("https://bob:tok@example.com/r.git", op)).rejects.toThrow(
      "fetch failed — getaddrinfo ENOTFOUND example.com (remote: https://***@example.com/r.git)",
    );
  });

  it("makeOnAuth: URL credentials beat GIT_TOKEN; bare token becomes the username; none → undefined", async () => {
    const urlAuth = await makeOnAuth({ username: "u", password: "p" }, { GIT_TOKEN: "envtok" })!("", {});
    expect(urlAuth).toEqual({ username: "u", password: "p" });
    const envAuth = await makeOnAuth(undefined, { GIT_TOKEN: "envtok" })!("", {});
    expect(envAuth).toEqual({ username: "envtok" });
    expect(makeOnAuth(undefined, {})).toBeUndefined();
    expect(makeOnAuth({ username: undefined, password: undefined }, {})).toBeUndefined();
  });
});

describe("git network commands (fake http client)", () => {
  it("clone: --cors-proxy rewrites the request URL; URL token flows to Basic auth; nothing leaks", async () => {
    const { requests, client } = fakeHttp(deny401);
    const git = createGitRunner({ http: client });
    const fs = freshRepo();
    const res = await run(
      git,
      ["git", "clone", "https://alice:sekrit-token@example.com/proj.git", "--cors-proxy", "https://proxy.local"],
      fs,
    );
    expect(res.code).toBe(1);
    // corsProxy applied: scheme stripped, URL appended to the proxy base.
    expect(requests[0]!.url).toBe("https://proxy.local/example.com/proj.git/info/refs?service=git-upload-pack");
    // First request is unauthenticated (credentials were stripped from the URL);
    // the 401 triggers onAuth and the retry carries them as Basic auth.
    expect(requests[0]!.headers["Authorization"]).toBeUndefined();
    expect(requests[1]!.headers["Authorization"]).toBe(basic("alice:sekrit-token"));
    // The failure surfaces the isomorphic-git message + the redacted remote.
    expect(res.err).toContain("HTTP Error: 401");
    expect(res.err).toContain("(remote: https://example.com/proj.git)");
    expect(res.err).not.toContain("sekrit-token");
    expect(res.out).not.toContain("sekrit-token");
  });

  it("clone: GIT_CORS_PROXY env is used when no flag is given", async () => {
    const { requests, client } = fakeHttp(deny401);
    const git = createGitRunner({ http: client });
    await run(git, ["git", "clone", "https://example.com/proj.git"], freshRepo(), {
      env: { GIT_CORS_PROXY: "https://env-proxy" },
    });
    expect(requests[0]!.url).toBe("https://env-proxy/example.com/proj.git/info/refs?service=git-upload-pack");
  });

  it("clone: no proxy by default — the remote is contacted directly", async () => {
    const { requests, client } = fakeHttp(deny401);
    const git = createGitRunner({ http: client });
    await run(git, ["git", "clone", "https://example.com/proj.git"], freshRepo());
    expect(requests[0]!.url).toBe("https://example.com/proj.git/info/refs?service=git-upload-pack");
  });

  it("clone: GIT_TOKEN env becomes GitHub-style Basic auth (token as username)", async () => {
    const { requests, client } = fakeHttp(deny401);
    const git = createGitRunner({ http: client });
    const res = await run(git, ["git", "clone", "https://example.com/proj.git"], freshRepo(), {
      env: { GIT_TOKEN: "ghp_supersecret" },
    });
    expect(requests[1]!.headers["Authorization"]).toBe(basic("ghp_supersecret:"));
    expect(res.err).not.toContain("ghp_supersecret");
  });

  it("clone: credentials in the URL win over GIT_TOKEN", async () => {
    const { requests, client } = fakeHttp(deny401);
    const git = createGitRunner({ http: client });
    await run(git, ["git", "clone", "https://alice:urltok@example.com/proj.git"], freshRepo(), {
      env: { GIT_TOKEN: "envtok" },
    });
    expect(requests[1]!.headers["Authorization"]).toBe(basic("alice:urltok"));
  });

  it("clone: refuses a non-empty destination before touching the network", async () => {
    const { requests, client } = fakeHttp(deny401);
    const git = createGitRunner({ http: client });
    const fs = freshRepo();
    fs.mkdir("/repo/proj");
    fs.writeFile("/repo/proj/keep.txt", "x");
    const res = await run(git, ["git", "clone", "https://example.com/proj.git"], fs);
    expect(res.code).toBe(1);
    expect(res.err).toContain("already exists and is not an empty directory");
    expect(requests.length).toBe(0);
  });

  it("remote add + remote -v: stores the URL but never echoes the token", async () => {
    const git = createGitRunner({ http: fakeHttp(deny401).client, author: { name: "T", email: "t@e" } });
    const fs = freshRepo();
    await run(git, ["git", "init"], fs);
    const add = await run(git, ["git", "remote", "add", "origin", "https://bob:t0ps3cret@example.com/x.git"], fs);
    expect(add.code).toBe(0);
    const v = await run(git, ["git", "remote", "-v"], fs);
    expect(v.out).toContain("origin\thttps://***@example.com/x.git (fetch)");
    expect(v.out).toContain("(push)");
    expect(v.out).not.toContain("t0ps3cret");
    expect((await run(git, ["git", "remote"], fs)).out.trim()).toBe("origin");
  });

  it("remote add: rejects non-http(s) URLs up front", async () => {
    const git = createGitRunner({ http: fakeHttp(deny401).client });
    const fs = freshRepo();
    await run(git, ["git", "init"], fs);
    const res = await run(git, ["git", "remote", "add", "origin", "git@github.com:a/b.git"], fs);
    expect(res.code).toBe(1);
    expect(res.err).toContain("expected an absolute http(s) URL");
  });

  it("fetch: missing remote fails with a precise, actionable error", async () => {
    const git = createGitRunner({ http: fakeHttp(deny401).client });
    const fs = freshRepo();
    await run(git, ["git", "init"], fs);
    const res = await run(git, ["git", "fetch"], fs);
    expect(res.code).toBe(1);
    expect(res.err).toContain("no such remote 'origin'");
    expect(res.err).toContain("git remote add origin");
  });

  it("fetch: a server error surfaces the isomorphic-git message + the remote URL", async () => {
    const { client } = fakeHttp(() => ({ code: 500, message: "Internal Server Error" }));
    const git = createGitRunner({ http: client });
    const fs = freshRepo();
    await run(git, ["git", "init"], fs);
    await run(git, ["git", "remote", "add", "origin", "https://example.com/y.git"], fs);
    const res = await run(git, ["git", "fetch", "origin"], fs);
    expect(res.code).toBe(1);
    expect(res.err).toContain("HTTP Error: 500");
    expect(res.err).toContain("(remote: https://example.com/y.git)");
  });

  it("clone: a transport-level throw surfaces the undici cause, redacted, with the remote", async () => {
    // Undici reports EVERY transport failure (DNS/TLS/timeout) as a bare
    // TypeError 'fetch failed' — the diagnosis is in `cause`. The command must
    // print it, or the error is loud but undiagnosable.
    const client = {
      async request() {
        throw new TypeError("fetch failed", {
          cause: new Error("Connect Timeout Error (attempted address: example.com:443, timeout: 10000ms)"),
        });
      },
    } as unknown as HttpClient;
    const git = createGitRunner({ http: client });
    const res = await run(git, ["git", "clone", "https://alice:sekrit-token@example.com/proj.git"], freshRepo());
    expect(res.code).toBe(1);
    expect(res.err).toContain("fetch failed — Connect Timeout Error (attempted address: example.com:443");
    expect(res.err).toContain("(remote: https://example.com/proj.git)");
    expect(res.err).not.toContain("sekrit-token");
  });

  it("pull rejects --force; push accepts it (parse-level gating)", async () => {
    const git = createGitRunner({ http: fakeHttp(deny401).client });
    const fs = freshRepo();
    await run(git, ["git", "init"], fs);
    const pull = await run(git, ["git", "pull", "--force"], fs);
    expect(pull.code).toBe(1);
    expect(pull.err).toContain("unknown flag '--force'");
    // push --force parses, then fails on the (missing) remote — proving the
    // flag was consumed rather than rejected.
    const push = await run(git, ["git", "push", "--force"], fs);
    expect(push.code).toBe(1);
    expect(push.err).toContain("no such remote 'origin'");
  });

  it("help text documents the network commands and the CORS-proxy contract", async () => {
    const git = createGitRunner({ http: fakeHttp(deny401).client });
    const res = await run(git, ["git", "bogus"], freshRepo());
    expect(res.code).toBe(1);
    for (const needle of ["clone <url> [dir]", "fetch [remote]", "pull [remote] [branch]", "push [remote] [branch]", "--cors-proxy", "GIT_CORS_PROXY", "GIT_TOKEN", "browsers need one for github.com", "Node needs none"]) {
      expect(res.err).toContain(needle);
    }
  });
});
