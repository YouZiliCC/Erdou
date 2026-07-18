import * as git from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import type { HttpClient } from "isomorphic-git";
import type { Executor, ExecContext, FileSystemApi } from "@erdou/runtime-contract";
import { createGitFs } from "./fs-adapter.js";
import { describeError, makeOnAuth, parseNetArgs, redactUrl, redactSecrets, splitUrlAuth, withRemoteContext } from "./net.js";

type GitFsArg = Parameters<typeof git.init>[0]["fs"];

export interface GitOptions {
  author?: { name: string; email: string };
  /**
   * HTTP client for the network commands (clone/fetch/pull/push). Defaults to
   * isomorphic-git's fetch-based `http/web` client, which works in both the
   * browser and Node ≥ 18 (global fetch). Injectable so tests can fake the
   * network.
   */
  http?: HttpClient;
}

function listFiles(fs: FileSystemApi, dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of fs.readdir(abs)) {
      if (e.name === ".git") continue;
      const childAbs = abs === "/" ? `/${e.name}` : `${abs}/${e.name}`;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === "directory") walk(childAbs, childRel);
      else out.push(childRel);
    }
  };
  walk(dir, "");
  return out;
}

function relTo(dir: string, p: string): string {
  if (!p.startsWith("/")) return p;
  return p.slice(dir === "/" ? 1 : dir.length + 1);
}

/**
 * A `git` executor backed by isomorphic-git operating on the Erdou filesystem.
 * Local commands (init, add, commit, log, status, branch, remote) run fully in
 * the browser. Network commands (clone, fetch, pull, push) go over smart-HTTP
 * through whatever `fetch` the host provides: in Node (≥ 18) they work as-is;
 * in a browser CORS applies — github.com serves no CORS headers on smart-HTTP,
 * so browser use needs a CORS proxy (`--cors-proxy <url>` or the
 * GIT_CORS_PROXY env var; the flag wins; there is deliberately NO default).
 * Auth is a token in the URL (`https://user:token@host/…`) or the GIT_TOKEN
 * env var; tokens are redacted from every echoed URL and error message.
 */
export function createGitRunner(opts: GitOptions = {}): Executor {
  const http = opts.http ?? webHttp;
  return async (ctx: ExecContext) => {
    const fs = createGitFs(ctx.fs) as unknown as GitFsArg;
    const dir = ctx.cwd;
    const args = ctx.argv.slice(1);
    const sub = args[0];
    const author = opts.author ?? {
      name: ctx.env["GIT_AUTHOR_NAME"] ?? "Erdou",
      email: ctx.env["GIT_AUTHOR_EMAIL"] ?? "agent@erdou.local",
    };
    const out = (s: string): void => ctx.stdout.write(s.endsWith("\n") ? s : s + "\n");
    const err = (s: string): void => ctx.stderr.write(s.endsWith("\n") ? s : s + "\n");
    const branch = async (): Promise<string> => (await git.currentBranch({ fs, dir })) ?? "main";
    /** Config-recorded URL of a named remote — the display/auth anchor for fetch/pull/push. */
    const remoteUrl = async (name: string): Promise<string> => {
      const remotes = await git.listRemotes({ fs, dir });
      const rec = remotes.find((r) => r.remote === name);
      if (!rec) throw new Error(`no such remote '${name}' — add one with: git remote add ${name} <url>`);
      return rec.url;
    };

    try {
      switch (sub) {
        case "init": {
          await git.init({ fs, dir, defaultBranch: "main" });
          out(`Initialized empty Git repository in ${dir === "/" ? "" : dir}/.git/`);
          return 0;
        }
        case "add": {
          const target = args[1] ?? ".";
          const files =
            target === "." || target === "-A" ? listFiles(ctx.fs, dir) : [relTo(dir, target)];
          for (const filepath of files) await git.add({ fs, dir, filepath });
          out(`added ${files.length} file(s)`);
          return 0;
        }
        case "commit": {
          const mi = args.indexOf("-m");
          const message = mi >= 0 ? args[mi + 1] ?? "" : "";
          if (!message) {
            err("git commit: missing -m <message>");
            return 1;
          }
          const oid = await git.commit({ fs, dir, message, author });
          out(`[${await branch()} ${oid.slice(0, 7)}] ${message}`);
          return 0;
        }
        case "log": {
          const commits = await git.log({ fs, dir });
          for (const c of commits) {
            out(
              `commit ${c.oid}\nAuthor: ${c.commit.author.name} <${c.commit.author.email}>\n\n    ${c.commit.message.trim()}\n`,
            );
          }
          return 0;
        }
        case "status": {
          const matrix = await git.statusMatrix({ fs, dir });
          const changed = matrix.filter(([, head, work, stage]) => !(head === 1 && work === 1 && stage === 1));
          if (changed.length === 0) {
            out("nothing to commit, working tree clean");
            return 0;
          }
          for (const [file, head, work] of changed) {
            const label = head === 0 ? "new file" : work === 0 ? "deleted" : "modified";
            out(`  ${label}: ${file}`);
          }
          return 0;
        }
        case "branch": {
          const branches = await git.listBranches({ fs, dir });
          const cur = await branch();
          for (const b of branches) out(`${b === cur ? "* " : "  "}${b}`);
          return 0;
        }
        case "remote": {
          const op = args[1];
          if (op === "add") {
            const name = args[2];
            const url = args[3];
            if (!name || !url) {
              err("git remote add: usage: git remote add <name> <url>");
              return 1;
            }
            splitUrlAuth(url); // validate up front: only absolute http(s) URLs can ever be fetched
            await git.addRemote({ fs, dir, remote: name, url });
            return 0; // real git is silent on success
          }
          if (op === undefined || op === "-v") {
            for (const r of await git.listRemotes({ fs, dir })) {
              if (op === "-v") {
                out(`${r.remote}\t${redactUrl(r.url)} (fetch)`);
                out(`${r.remote}\t${redactUrl(r.url)} (push)`);
              } else {
                out(r.remote);
              }
            }
            return 0;
          }
          err(`git remote: unsupported operation '${op}'. Supported: add <name> <url>, -v.`);
          return 1;
        }
        case "clone": {
          const { positionals, corsProxy } = parseNetArgs(args.slice(1), ctx.env);
          const rawUrl = positionals[0];
          if (!rawUrl || positionals.length > 2) {
            err("git clone: usage: git clone <url> [dir] [--cors-proxy <url>]");
            return 1;
          }
          // Strip credentials BEFORE isomorphic-git sees the URL: the clean URL
          // is what clone persists as remote.origin.url, so no token ever lands
          // in .git/config. Credentials flow through onAuth instead.
          const { url, username, password } = splitUrlAuth(rawUrl);
          const base =
            positionals[1] ??
            (new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "").replace(/\.git$/, "");
          if (!base) {
            err(`git clone: cannot derive a directory name from '${redactUrl(rawUrl)}' — pass [dir] explicitly`);
            return 1;
          }
          const target = base.startsWith("/") ? base : dir === "/" ? `/${base}` : `${dir}/${base}`;
          if (ctx.fs.exists(target) && ctx.fs.readdir(target).length > 0) {
            err(`git clone: destination path '${target}' already exists and is not an empty directory`);
            return 1;
          }
          out(`Cloning into '${target}'...`);
          await withRemoteContext(url, () =>
            git.clone({ fs, http, dir: target, url, corsProxy, onAuth: makeOnAuth({ username, password }, ctx.env) }),
          );
          return 0;
        }
        case "fetch": {
          const { positionals, corsProxy } = parseNetArgs(args.slice(1), ctx.env);
          if (positionals.length > 1) {
            err("git fetch: usage: git fetch [remote] [--cors-proxy <url>]");
            return 1;
          }
          const remote = positionals[0] ?? "origin";
          const url = await remoteUrl(remote);
          const res = await withRemoteContext(url, () =>
            git.fetch({ fs, http, dir, remote, corsProxy, onAuth: makeOnAuth(undefined, ctx.env) }),
          );
          out(`From ${redactUrl(url)}`);
          if (res.fetchHead) out(` * ${res.fetchHeadDescription ?? "FETCH_HEAD"} -> ${res.fetchHead.slice(0, 7)}`);
          return 0;
        }
        case "pull": {
          const { positionals, corsProxy } = parseNetArgs(args.slice(1), ctx.env);
          if (positionals.length > 2) {
            err("git pull: usage: git pull [remote] [branch] [--cors-proxy <url>]");
            return 1;
          }
          const remote = positionals[0] ?? "origin";
          const remoteRef = positionals[1]; // default: the configured remote-tracking branch
          const url = await remoteUrl(remote);
          const before = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
          // fastForwardOnly: a non-fast-forward pull ERRORS (isomorphic-git's
          // FastForwardError) instead of minting a silent merge commit.
          await withRemoteContext(url, () =>
            git.pull({
              fs,
              http,
              dir,
              remote,
              remoteRef,
              fastForwardOnly: true,
              corsProxy,
              onAuth: makeOnAuth(undefined, ctx.env),
              author,
            }),
          );
          const after = await git.resolveRef({ fs, dir, ref: "HEAD" });
          out(before === after ? "Already up to date." : `Fast-forwarded ${await branch()} to ${after.slice(0, 7)}`);
          return 0;
        }
        case "push": {
          const { positionals, corsProxy, force } = parseNetArgs(args.slice(1), ctx.env, { allowForce: true });
          if (positionals.length > 2) {
            err("git push: usage: git push [remote] [branch] [--force] [--cors-proxy <url>]");
            return 1;
          }
          const remote = positionals[0] ?? "origin";
          const ref = positionals[1] ?? (await branch());
          const url = await remoteUrl(remote);
          const res = await withRemoteContext(url, () =>
            git.push({ fs, http, dir, remote, ref, force, corsProxy, onAuth: makeOnAuth(undefined, ctx.env) }),
          );
          const failed = Object.entries(res.refs).filter(([, s]) => !s.ok);
          if (!res.ok || res.error || failed.length > 0) {
            const details = [res.error, ...failed.map(([r, s]) => `${r}: ${s.error}`)].filter(Boolean).join("; ");
            err(`git push: ${redactSecrets(details || "push rejected")} (remote: ${redactUrl(url)})`);
            return 1;
          }
          out(`To ${redactUrl(url)}`);
          out(`   ${ref} -> ${ref}${force ? " (forced)" : ""}`);
          return 0;
        }
        default:
          err(
            [
              `git: unsupported subcommand '${sub ?? ""}'.`,
              "Local:   init | add <path>|. | commit -m <msg> | log | status | branch",
              "Remotes: remote add <name> <url> | remote -v",
              "Network: clone <url> [dir] | fetch [remote] | pull [remote] [branch] (fast-forward only) | push [remote] [branch] [--force]",
              "Network flags: --cors-proxy <url>, or the GIT_CORS_PROXY env var (the flag wins). There is no default proxy:",
              "  browsers need one for github.com (its smart-HTTP endpoints send no CORS headers); Node needs none.",
              "Auth: a token in the URL (https://user:token@host/...) or the GIT_TOKEN env var; tokens are never echoed.",
            ].join("\n"),
          );
          return 1;
      }
    } catch (e) {
      // describeError is the last line of defense: it surfaces the full cause
      // chain (undici hides the real transport failure in `cause`) and redacts
      // it — no token that entered via a URL may ever leave via an error.
      err(`git: ${describeError(e)}`);
      return 1;
    }
  };
}
