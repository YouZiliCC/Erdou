# @erdou/runtime-browser

The reference browser-native Runtime kernel for Erdou. Implements `@erdou/runtime-contract` entirely in-memory, so it runs in a browser and in Node (fully testable without a browser).

Subsystems:
- **VFS** — a POSIX-ish in-memory filesystem (inodes, symlinks with loop detection, fd-less sync API) that throws typed errno errors.
- **Process** — a `ProcessTable` with pid/ppid/stdio/exit-codes, backed by an in-process JS executor; pipelines and child spawns.
- **Shell** — tokenizer + parser + interpreter: pipelines, `&&`/`||`/`;`, trailing-`&` background jobs, redirections (`>` `>>` `<` plus fd duplication `2>&1` / `1>&2` / `&>` / `&>>`, resolved left to right; `/dev/null` as a redirect target is a discard sink — the vfs itself has no device nodes), `$VAR` expansion, `$(...)` command substitution (subshell; result never field-split), globbing; built-ins (`ls cat grep sed awk find head tail mkdir rm cp mv touch echo pwd env which ps kill true false erdou`), plus `cd`/`export`/`jobs` as shell state.
- **Snapshot** — serialize/restore the whole filesystem; memory + IndexedDB stores.
- **Port / Net** — virtual port registry and a permission-gated fetch.

```ts
import { BrowserRuntime } from "@erdou/runtime-browser";
const rt = new BrowserRuntime();
await rt.boot();
const p = await rt.exec("echo hi | grep h");
console.log(await p.stdout.text()); // "hi\n"
```

Depends only on `@erdou/runtime-contract`.
