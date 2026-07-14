# @erdou/runtime-wasi

A `wasi` executor for Erdou: runs `wasm32-wasi` programs in the browser, backed by the Erdou filesystem and stdio. This is the **general mechanism for compiled languages** — any binary from **Rust / C / C++ / Zig / TinyGo** compiled to `wasm32-wasi` runs here.

```ts
import { createWasiRunner } from "@erdou/runtime-wasi";
runtime.registerProgram("wasi", createWasiRunner());
// then:  wasi /bin/ripgrep.wasm --version
```

Implements a practical subset of `wasi_snapshot_preview1`: args, environ, stdio (`fd_read`/`fd_write`), files (`path_open`, `fd_seek`, `fd_close` flushing back to the VFS), `path_filestat_get`, `path_create_directory`/`unlink`, `clock_time_get`, `random_get`. Unimplemented calls return `ENOSYS` rather than failing instantiation. Directory iteration (`fd_readdir`) is a stub for now.

Depends only on `@erdou/runtime-contract` (CI-enforced). Verified end-to-end against real hand-built wasm modules.
