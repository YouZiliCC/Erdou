# Erdou Runtime Kernel — Round 1 Design

> Status: approved-for-planning · Date: 2026-07-14
> Source vision: `proposal_v1.md` · Architecture rules: `notice.md`

## 1. Goal of this round

Build the **Runtime kernel layer** of Erdou to production quality, depth-first. Not the agent, not the UI. The kernel is the browser-native operating environment that upper layers (agent-tools → agent-core → app) will later depend on.

The kernel must be **Node-runnable** so it is fully testable with Vitest without a browser. Browser-only surfaces (IndexedDB) are exercised in Node via `fake-indexeddb`.

### Acceptance for the round
- `pnpm test` green: unit tests + the conformance suite.
- `pnpm lint:deps` proves no layering violation.
- `pnpm typecheck` + `pnpm build` green for every package.
- In a test, `BrowserRuntime` can:
  - create/read/write/delete files and directories with correct errno errors;
  - run a shell pipeline (`echo hi | grep h`), `ls`, `cat`, redirection (`echo x > f`);
  - spawn/wait processes with real exit codes and captured stdout/stderr;
  - `createSnapshot()` → mutate → `restoreSnapshot()` returns to the exact prior state;
  - persist a snapshot to a `SnapshotStore` and reload it (refresh-recovery);
  - `listen(port)` / `exposePort(port)` and emit `port.opened`.

## 2. Guiding principles (from user)

1. **No over-engineering.** Only build what this round needs. No speculative abstractions or "for later" seams.
2. **Minimize fallbacks.** One correct path per operation; no silent default-returns.
3. **Fail fast with detailed errors.** Throw typed errno errors carrying path/args/context (e.g. `ENOENT: no such file or directory, open '/foo'`). Callers see the real failure, not a masked default.

These directly shape the kernel: the VFS and process layers throw precise errors instead of swallowing them, and we do not add capability-negotiation or multi-backend fallbacks the round does not use.

## 3. Architecture & layering

pnpm workspace + TypeScript (strict, ESM). Package layout:

```
erdou/
├── package.json                 # workspace root + scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .dependency-cruiser.cjs      # enforces the layering rules from notice.md
├── packages/
│   ├── runtime-contract/        # @erdou/runtime-contract  — pure types/interfaces, ZERO runtime deps
│   ├── runtime-browser/         # @erdou/runtime-browser   — the working kernel
│   ├── conformance/             # @erdou/conformance       — runtime-agnostic contract test suite
│   └── model-gateway/           # @erdou/model-gateway     — thin BYO-key API connector (secondary)
└── docs/
```

**Enforced dependency direction** (dependency-cruiser, fails CI on violation):
- `runtime-contract` → depends on nothing.
- `runtime-browser` → may import only `runtime-contract`.
- `conformance` → may import only `runtime-contract` (it receives a Runtime factory; it never imports a concrete impl).
- `model-gateway` → depends on nothing from runtime; nothing in `runtime-*` may import it.
- Forbidden (all fail the build): `runtime-* → agent-*`, `runtime-contract → runtime-browser`, `runtime-contract → app`, any runtime layer importing a model SDK / UI / agent types.

No `agent-*` or app package exists this round; the rules are pre-seeded so the invariant holds the moment those layers are added.

## 4. `@erdou/runtime-contract` — the Contract

Pure `.ts` type declarations + a few small const enums / error classes. The frozen boundary every Runtime implements. Contents:

- **Runtime**: `boot()`, `shutdown()`, `spawn(opts)`, `exec(cmdline, opts)`, `kill(pid, signal?)`, `wait(pid)`, `readFile`, `writeFile`, `readdir`, `mkdir`, `rm`, `rename`, `stat`, `createSnapshot()`, `restoreSnapshot(s)`, `listen(port)`, `exposePort(port)`, `getProcesses()`, `getCapabilities()`, `subscribe(listener)` for events.
- **Process types**: `SpawnOptions` (cmd, args, cwd, env, stdin), `ProcessHandle` (pid, stdout/stderr/stdin streams, `wait()`, `kill()`), `ProcessInfo`, `ExitStatus` (code, signal), `Signal`.
- **Filesystem types**: `FileEntry`, `Stat` (kind, size, mode, mtime, …), `FileType`, `WriteOptions`.
- **Events**: generic `RuntimeEvent` union — `process.started | process.stdout | process.stderr | process.exited | file.changed | port.opened | resource.warning`. **No agent semantics.**
- **Capabilities**: `RuntimeCapabilities` (nativeProcesses, virtualPorts, persistentStorage, network, threads, nativeAddons …).
- **Snapshots/ports**: `Snapshot`, `VirtualPort`.
- **Permissions**: `Permission`, `PermissionRequest`.
- **Errors**: `ErrnoError` class + `Errno` codes (`ENOENT, EEXIST, ENOTDIR, EISDIR, EACCES, ENOTEMPTY, EINVAL, ESRCH …`), with `code`, `path`, `syscall` fields and a formatted message.

## 5. `@erdou/runtime-browser` — the kernel (bulk of effort)

Environment-agnostic core. Modules:

### 5.1 `vfs/` — virtual filesystem
POSIX-ish in-memory tree: inodes (file/dir/symlink), mode bits, size, mtime/ctime/birthtime, an fd table for open/read/write/close. Path resolution normalizes `.`/`..`, resolves symlinks with loop detection (`ELOOP`). Operations: `readFile/writeFile/appendFile`, `open/read/write/close`, `mkdir` (+recursive), `rmdir`, `readdir`, `unlink`, `rm` (+recursive), `rename`, `copy`, `stat/lstat`, `chmod`, `symlink/readlink`, `truncate`, `exists`, `watch` (emits `file.changed`). Every failure throws a typed `ErrnoError` with the offending path.

### 5.2 `process/` — process system
`ProcessTable`: pid allocation, ppid, cwd, env, stdio (in-memory byte streams), state (`running|exited|killed`), exitCode, signal, startTime, simple resource counters. A **program** is `(ctx: ProcessContext) => Promise<number>` where `ctx` exposes argv, env, cwd, stdin/stdout/stderr, the vfs, and `spawn` for children. One executor: the in-process JS executor that runs registered programs. Supports `spawn`, `exec`, `kill(signal)`, `wait`, pipes between processes, process groups, background. Emits `process.*` events.

### 5.3 `shell/` — shell + built-ins
Tokenizer + parser producing an AST: pipelines `|`, `&&`/`||`/`;`, redirections `> >> < 2>`, single/double quotes, `$VAR`/`${VAR}` expansion, glob `*`/`?`. An interpreter executes the AST by spawning programs through the process table and wiring pipes/redirections. Built-ins registered as programs: `cd pwd ls cat echo mkdir rm cp mv find grep head tail touch which env export ps kill true false`. (`sed`/`awk` explicitly deferred — proposal marks them "逐步支持".)

### 5.4 `snapshot/` — snapshots & persistence
`createSnapshot()` serializes the full VFS tree (structure + file bytes + metadata) into a `Snapshot` (structured-clone/JSON-safe). `restoreSnapshot()` rebuilds it exactly. `SnapshotStore` interface `{ save(id, snapshot), load(id), list(), delete(id) }` with `MemorySnapshotStore` (default/tests) and `IndexedDbSnapshotStore` (browser; tested in Node via `fake-indexeddb`). This is the single persistence path (covers project-persistence + refresh-recovery). No live block-level storage backend abstraction.

### 5.5 `port/` — virtual ports
`PortRegistry`: `listen(port)` returns a `VirtualPort` and marks it bound (throws `EADDRINUSE` if taken); `exposePort(port)` returns a preview URL string; emits `port.opened`. (Service-Worker wiring for real browser preview is a later round; the registry + contract are here now.)

### 5.6 `net/` — networking
Minimal permission-gated `fetch` capability (`NetworkManager.fetch(request)` checks a permission then delegates to global fetch). Small on purpose.

### 5.7 `BrowserRuntime`
Implements the `Runtime` contract by composing vfs + process + shell + snapshot + port + net + an event bus, and returns the browser-native `getCapabilities()`.

## 6. `@erdou/conformance` — conformance suite

Exports `runConformance(makeRuntime: () => Runtime | Promise<Runtime>)` (a set of Vitest specs, or a framework-agnostic runner) exercising the categories from proposal §十二: filesystem behavior, process behavior, shell behavior, snapshot behavior, port behavior, capability shape. Any future adapter (`WasmRuntime`, `RemoteRuntime`) proves compliance by passing it. Run against `BrowserRuntime` in this repo's CI.

## 7. `@erdou/model-gateway` — secondary

Thin connector, no agent logic. `ModelGateway.chat(config, messages, { stream })` where `config = { provider: 'openai-compatible' | 'anthropic', baseUrl, apiKey, model }`. Supports non-streaming and streaming (SSE) for both provider shapes. Config is always passed in — never hard-coded, never read from a bundled secret. Depends on nothing from the runtime layer.

## 8. Testing & tooling

- **Vitest** across packages; heavy unit coverage on vfs path resolution, fs ops + errno correctness, shell parser + each built-in, process/pipes/exit-codes, snapshot round-trip, SnapshotStore.
- **Conformance** suite as the top-level guarantee, run against `BrowserRuntime`.
- **dependency-cruiser** gate (`pnpm lint:deps`) encoding §3's rules.
- Root scripts: `build`, `test`, `typecheck`, `lint:deps`, `conformance`.
- Per-package `README.md`; root `README.md` states the architecture invariant. Optional GitHub Actions CI.

## 9. Explicitly out of scope this round (YAGNI)

Agent-core, agent-tools, Web UI, WebAssembly/WASI runtime, virtual machine, OPFS backend, Web Worker executor, real Service-Worker preview, package manager, `sed`/`awk`, capability-negotiation fallbacks. These are named in `proposal_v1.md` for later rounds; pre-seeded layering keeps them addable without breaking the contract.
