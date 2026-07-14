# @erdou/tool-git

A `git` command for Erdou, backed by **isomorphic-git** operating directly on the Erdou filesystem. Register it and the shell, terminal, and agent get version control:

```ts
import { createGitRunner } from "@erdou/tool-git";
runtime.registerProgram("git", createGitRunner());
// git init · git add . · git commit -m "msg" · git log · git status · git branch
```

Local operations run **fully in the browser** (no server). Network operations (clone/push/pull) would additionally need a git CORS proxy and are not wired here. Depends on `@erdou/runtime-contract` + isomorphic-git; verified with real init/add/commit/log/status over the VFS.
