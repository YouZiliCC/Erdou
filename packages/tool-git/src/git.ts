import * as git from "isomorphic-git";
import type { Executor, ExecContext, FileSystemApi } from "@erdou/runtime-contract";
import { createGitFs } from "./fs-adapter.js";

type GitFsArg = Parameters<typeof git.init>[0]["fs"];

export interface GitOptions {
  author?: { name: string; email: string };
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
 * Local commands (init, add, commit, log, status, branch) run fully in the
 * browser; network commands (clone/push) would additionally need a git CORS
 * proxy and are not wired here.
 */
export function createGitRunner(opts: GitOptions = {}): Executor {
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
        default:
          err(
            `git: unsupported subcommand '${sub ?? ""}'. Supported: init, add, commit, log, status, branch.`,
          );
          return 1;
      }
    } catch (e) {
      err(`git: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  };
}
