# @erdou/runtime-browser

The reference browser-native Runtime kernel for Erdou. Implements `@erdou/runtime-contract` entirely in-memory, so it runs in a browser and in Node (fully testable without a browser).

Subsystems:
- **VFS** — a POSIX-ish in-memory filesystem (inodes, symlinks with loop detection, fd-less sync API) that throws typed errno errors.
- **Process** — a `ProcessTable` with pid/ppid/stdio/exit-codes, backed by an in-process JS executor; pipelines and child spawns.
- **Shell** — tokenizer + parser + interpreter: pipelines, `&&`/`||`/`;`, redirections, `$VAR` expansion, globbing; built-ins (`ls cat grep find head tail mkdir rm cp mv touch echo pwd env which ps kill true false`), plus `cd`/`export` as shell state.
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
