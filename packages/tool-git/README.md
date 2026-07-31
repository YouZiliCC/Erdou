# @erdou/tool-git

A `git` command for Erdou, backed by **isomorphic-git** operating directly on the Erdou filesystem. Register it and the shell, terminal, and agent get version control:

```ts
import { createGitRunner } from "@erdou/tool-git";
runtime.registerProgram("git", createGitRunner());
// git init · git add . · git commit -m "msg" · git log · git status · git branch
// git remote · git clone · git fetch · git pull · git push
```

Local operations run **fully in the browser** (no server). Network operations (clone/fetch/pull/push) **are** wired, over isomorphic-git's smart-HTTP `http/web` client: they work as-is under Node ≥18, and from a browser they need a CORS proxy, supplied per-command with `--cors-proxy <url>` or via the `GIT_CORS_PROXY` env var (there is no default). Auth is a token in the URL userinfo or `GIT_TOKEN`; tokens are redacted from all output. Depends on `@erdou/runtime-contract` + isomorphic-git; verified with real init/add/commit/log/status over the VFS, plus a gated live suite (`ERDOU_NET_E2E=1`, `net.e2e.test.ts`) that clones/fetches/pulls against github.com.
