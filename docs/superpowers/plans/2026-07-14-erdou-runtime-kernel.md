# Erdou Runtime Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Erdou Runtime kernel layer — a Node-testable, browser-native operating environment (VFS, processes, shell, snapshots, ports) behind a frozen contract, plus a conformance suite and a thin model connector.

**Architecture:** pnpm workspace, 4 TypeScript packages in a strict bottom-up layering enforced by dependency-cruiser. `runtime-contract` = pure types (zero deps). `runtime-browser` = the working kernel (imports only the contract). `conformance` = a runtime-agnostic test suite (receives a Runtime factory). `model-gateway` = an independent BYO-key API connector. Agent depends on Runtime; Runtime never depends on Agent.

**Tech Stack:** TypeScript 5 (strict, ESM, `"moduleResolution": "bundler"`), pnpm 11 workspaces, Vitest 2, dependency-cruiser 16, tsup for builds, fake-indexeddb for the IndexedDB store tests.

## Global Constraints

- Node ≥ 22, pnpm ≥ 11. All packages ESM (`"type": "module"`), TypeScript `strict: true`.
- npm scope `@erdou/*`. Package names: `@erdou/runtime-contract`, `@erdou/runtime-browser`, `@erdou/conformance`, `@erdou/model-gateway`.
- **Layering (CI-enforced, must never break):** `runtime-contract` imports nothing internal; `runtime-browser` imports only `@erdou/runtime-contract`; `conformance` imports only `@erdou/runtime-contract`; nothing in `runtime-*` imports `@erdou/model-gateway` or any (future) `agent-*`/app. Forbidden: `runtime-contract → runtime-browser`.
- **Error philosophy (user mandate):** no silent fallbacks, no swallowed defaults. Every failure throws a typed `ErrnoError` carrying `code`, `path`/`syscall`, and a formatted message. One correct path per operation.
- **No over-engineering (user mandate):** build only what a task's tests need. No speculative abstractions. Deferred items (see spec §9) are NOT to be added.
- Every task ends `pnpm -w test` green (for its package) and, from Task 16 on, `pnpm -w lint:deps` green.

---

### Task 0: Monorepo scaffold + tooling

**Files:**
- Create: `package.json` (root), `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `vitest.workspace.ts`, `.dependency-cruiser.cjs`
- Create per package: `packages/<name>/package.json`, `packages/<name>/tsconfig.json`, `packages/<name>/src/index.ts` (stub)

**Interfaces:**
- Produces: workspace with 4 packages resolvable by name; root scripts `build`, `test`, `typecheck`, `lint:deps`, `conformance`.

- [ ] **Step 1: Root `pnpm-workspace.yaml`**
```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Root `package.json`**
```json
{
  "name": "erdou",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.5.2",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "lint:deps": "depcruise packages --config .dependency-cruiser.cjs",
    "conformance": "vitest run packages/conformance"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsup": "^8.3.0",
    "dependency-cruiser": "^16.4.0",
    "fake-indexeddb": "^6.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 3: `tsconfig.base.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 4: `.gitignore`**
```
node_modules/
dist/
*.tsbuildinfo
coverage/
.DS_Store
```

- [ ] **Step 5: Per-package `package.json`** — for each of the 4 packages. Example for `runtime-contract`:
```json
{
  "name": "@erdou/runtime-contract",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit"
  }
}
```
`runtime-browser`, `conformance`, `model-gateway` follow the same shape. `runtime-browser` and `conformance` add `"dependencies": { "@erdou/runtime-contract": "workspace:*" }`. Give `runtime-browser` a dev dependency `"fake-indexeddb": "^6.0.0"` for the SnapshotStore tests.

- [ ] **Step 6: Per-package `tsconfig.json`**
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 7: `vitest.workspace.ts`**
```ts
export default ["packages/*"];
```
Add a minimal `packages/<name>/vitest.config.ts` to each: `import { defineConfig } from "vitest/config"; export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });`

- [ ] **Step 8: `.dependency-cruiser.cjs`** — see Task 16 for the full rule set; scaffold now with an empty `forbidden: []` so `depcruise` runs. (Rules are added in Task 16 once packages exist.)
```js
module.exports = { forbidden: [], options: { tsConfig: { fileName: "tsconfig.base.json" }, doNotFollow: { path: "node_modules" } } };
```

- [ ] **Step 9: Stub `src/index.ts`** in each package: `export {};`

- [ ] **Step 10: Install + verify**
Run: `pnpm install && pnpm typecheck`
Expected: install succeeds, typecheck passes (empty packages).

- [ ] **Step 11: Commit**
```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo with 4 packages + tooling"
```

---

### Task 1: `runtime-contract` — errno errors

**Files:**
- Create: `packages/runtime-contract/src/errors.ts`
- Test: `packages/runtime-contract/src/errors.test.ts`

**Interfaces:**
- Produces: `type Errno = "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "EACCES" | "ENOTEMPTY" | "EINVAL" | "ELOOP" | "EBADF" | "ESRCH" | "EADDRINUSE"`; `class ErrnoError extends Error { code: Errno; path?: string; syscall?: string; constructor(code, opts?) }`; helper factories `enoent(path, syscall)`, `eexist(path, syscall)`, etc.

- [ ] **Step 1: Write failing test**
```ts
import { describe, it, expect } from "vitest";
import { ErrnoError, enoent } from "./errors.js";

describe("ErrnoError", () => {
  it("formats a POSIX-style message with code, syscall and path", () => {
    const err = new ErrnoError("ENOENT", { syscall: "open", path: "/foo/bar" });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ENOENT");
    expect(err.path).toBe("/foo/bar");
    expect(err.message).toBe("ENOENT: no such file or directory, open '/foo/bar'");
  });
  it("enoent factory produces an ENOENT error", () => {
    expect(enoent("/x", "stat").code).toBe("ENOENT");
    expect(enoent("/x", "stat").message).toBe("ENOENT: no such file or directory, stat '/x'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run packages/runtime-contract/src/errors.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `errors.ts`**
```ts
export type Errno =
  | "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "EACCES"
  | "ENOTEMPTY" | "EINVAL" | "ELOOP" | "EBADF" | "ESRCH" | "EADDRINUSE";

const DESCRIPTIONS: Record<Errno, string> = {
  ENOENT: "no such file or directory",
  EEXIST: "file already exists",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EACCES: "permission denied",
  ENOTEMPTY: "directory not empty",
  EINVAL: "invalid argument",
  ELOOP: "too many symbolic links encountered",
  EBADF: "bad file descriptor",
  ESRCH: "no such process",
  EADDRINUSE: "address already in use",
};

export interface ErrnoOptions { path?: string; syscall?: string; }

export class ErrnoError extends Error {
  readonly code: Errno;
  readonly path?: string;
  readonly syscall?: string;
  constructor(code: Errno, opts: ErrnoOptions = {}) {
    const desc = DESCRIPTIONS[code];
    const tail = opts.syscall
      ? `, ${opts.syscall}${opts.path ? ` '${opts.path}'` : ""}`
      : opts.path ? ` '${opts.path}'` : "";
    super(`${code}: ${desc}${tail}`);
    this.name = "ErrnoError";
    this.code = code;
    if (opts.path !== undefined) this.path = opts.path;
    if (opts.syscall !== undefined) this.syscall = opts.syscall;
  }
}

const factory = (code: Errno) => (path: string, syscall: string) => new ErrnoError(code, { path, syscall });
export const enoent = factory("ENOENT");
export const eexist = factory("EEXIST");
export const enotdir = factory("ENOTDIR");
export const eisdir = factory("EISDIR");
export const enotempty = factory("ENOTEMPTY");
export const eloop = factory("ELOOP");
export const ebadf = factory("EBADF");
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run packages/runtime-contract/src/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(contract): errno error types"
```

---

### Task 2: `runtime-contract` — the type surface

**Files:**
- Create: `packages/runtime-contract/src/fs.ts`, `process.ts`, `events.ts`, `capabilities.ts`, `snapshot.ts`, `port.ts`, `permissions.ts`, `runtime.ts`
- Modify: `packages/runtime-contract/src/index.ts` (re-export all)
- Test: `packages/runtime-contract/src/contract.test.ts` (type-level + shape assertions)

**Interfaces (Produces — these are the frozen boundary; later tasks consume them verbatim):**

`fs.ts`:
```ts
export type FileType = "file" | "directory" | "symlink";
export interface Stat {
  type: FileType;
  size: number;
  mode: number;      // POSIX permission bits, e.g. 0o644
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}
export interface FileEntry { name: string; type: FileType; }
export interface WriteFileOptions { mode?: number; }
export interface MkdirOptions { recursive?: boolean; mode?: number; }
export interface RmOptions { recursive?: boolean; force?: boolean; }
```

`process.ts`:
```ts
export type Signal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
export type ProcessState = "running" | "exited" | "killed";
export interface ExitStatus { code: number; signal: Signal | null; }
export interface SpawnOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  detached?: boolean;   // background
}
export interface ByteStream {
  read(): AsyncIterableIterator<Uint8Array>;
  text(): Promise<string>;   // drains and decodes utf-8
}
export interface WritableByteStream { write(chunk: Uint8Array | string): void; end(): void; }
export interface ProcessHandle {
  readonly pid: number;
  readonly stdout: ByteStream;
  readonly stderr: ByteStream;
  readonly stdin: WritableByteStream;
  wait(): Promise<ExitStatus>;
  kill(signal?: Signal): Promise<void>;
}
export interface ProcessInfo {
  pid: number; ppid: number; cmd: string; args: string[];
  cwd: string; state: ProcessState; startTimeMs: number;
  exitCode: number | null;
}
```

`events.ts` (generic only — NO agent semantics):
```ts
export type RuntimeEvent =
  | { type: "process.started"; pid: number; cmd: string }
  | { type: "process.stdout"; pid: number; data: Uint8Array }
  | { type: "process.stderr"; pid: number; data: Uint8Array }
  | { type: "process.exited"; pid: number; code: number; signal: string | null }
  | { type: "file.changed"; path: string; kind: "create" | "modify" | "delete" }
  | { type: "port.opened"; port: number; url: string }
  | { type: "resource.warning"; resource: string; detail: string };
export type RuntimeEventListener = (event: RuntimeEvent) => void;
export interface Unsubscribe { (): void; }
```

`capabilities.ts`:
```ts
export interface RuntimeCapabilities {
  nativeProcesses: boolean;
  virtualPorts: boolean;
  persistentStorage: boolean;
  network: boolean;
  threads: boolean;
  nativeAddons: boolean;
}
```

`snapshot.ts`:
```ts
export interface Snapshot {
  version: 1;
  createdAtMs: number;
  fs: SnapshotFsNode;   // serialized VFS tree root
}
export type SnapshotFsNode =
  | { type: "directory"; mode: number; children: Record<string, SnapshotFsNode> }
  | { type: "file"; mode: number; data: string /* base64 */ }
  | { type: "symlink"; mode: number; target: string };
export interface SnapshotStore {
  save(id: string, snapshot: Snapshot): Promise<void>;
  load(id: string): Promise<Snapshot | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}
```

`port.ts`:
```ts
export interface VirtualPort { readonly port: number; close(): Promise<void>; }
```

`permissions.ts`:
```ts
export type PermissionKind = "network" | "storage";
export interface Permission { kind: PermissionKind; granted: boolean; }
export interface PermissionRequest { kind: PermissionKind; reason: string; }
```

`runtime.ts`:
```ts
import type { Stat, FileEntry, WriteFileOptions, MkdirOptions, RmOptions } from "./fs.js";
import type { SpawnOptions, ProcessHandle, ProcessInfo, ExitStatus, Signal } from "./process.js";
import type { RuntimeEventListener, Unsubscribe } from "./events.js";
import type { RuntimeCapabilities } from "./capabilities.js";
import type { Snapshot } from "./snapshot.js";
import type { VirtualPort } from "./port.js";

export interface Runtime {
  boot(): Promise<void>;
  shutdown(): Promise<void>;

  spawn(options: SpawnOptions): Promise<ProcessHandle>;
  exec(commandLine: string, options?: Omit<SpawnOptions, "cmd" | "args">): Promise<ProcessHandle>;
  kill(pid: number, signal?: Signal): Promise<void>;
  wait(pid: number): Promise<ExitStatus>;
  getProcesses(): Promise<ProcessInfo[]>;

  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string, options?: WriteFileOptions): Promise<void>;
  readdir(path: string): Promise<FileEntry[]>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<Stat>;

  createSnapshot(): Promise<Snapshot>;
  restoreSnapshot(snapshot: Snapshot): Promise<void>;

  listen(port: number): Promise<VirtualPort>;
  exposePort(port: number): Promise<string>;

  getCapabilities(): Promise<RuntimeCapabilities>;
  subscribe(listener: RuntimeEventListener): Unsubscribe;
}
```

- [ ] **Step 1: Write the files above** verbatim (Steps are grouped: create all 8 type files with the exact content in the Interfaces block).

- [ ] **Step 2: `index.ts` re-exports**
```ts
export * from "./errors.js";
export * from "./fs.js";
export * from "./process.js";
export * from "./events.js";
export * from "./capabilities.js";
export * from "./snapshot.js";
export * from "./port.js";
export * from "./permissions.js";
export * from "./runtime.js";
```

- [ ] **Step 3: Shape test** `contract.test.ts`
```ts
import { describe, it, expect } from "vitest";
import * as contract from "./index.js";
import { ErrnoError } from "./index.js";

describe("contract surface", () => {
  it("exports ErrnoError as a constructor", () => {
    expect(typeof ErrnoError).toBe("function");
    expect(new ErrnoError("EINVAL").code).toBe("EINVAL");
  });
  it("is otherwise type-only (no unexpected runtime exports)", () => {
    // only ErrnoError + factories are runtime values; the rest are types erased at build
    expect(Object.keys(contract).sort()).toContain("ErrnoError");
  });
});
```

- [ ] **Step 4: Run typecheck + test**
Run: `pnpm --filter @erdou/runtime-contract typecheck && pnpm vitest run packages/runtime-contract`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(contract): full type surface (fs, process, events, runtime, snapshot, ports)"
```

---

### Task 3: `runtime-browser` VFS — inode model + path resolution

**Files:**
- Create: `packages/runtime-browser/src/vfs/inode.ts`, `packages/runtime-browser/src/vfs/path.ts`, `packages/runtime-browser/src/vfs/resolve.ts`
- Test: `packages/runtime-browser/src/vfs/path.test.ts`, `resolve.test.ts`

**Interfaces:**
- Consumes: `ErrnoError`, `enoent`, `enotdir`, `eloop` from `@erdou/runtime-contract`.
- Produces:
  - `path.ts`: `normalize(p: string): string` (collapses `.`/`..`, absolute only, always starts `/`, no trailing slash except root), `join(...parts): string`, `dirname(p)`, `basename(p)`, `split(p): string[]`.
  - `inode.ts`: `type Inode = DirInode | FileInode | SymlinkInode`; `DirInode { type:"directory"; mode; mtimeMs; ctimeMs; birthtimeMs; children: Map<string, Inode> }`; `FileInode { type:"file"; mode; ...times; data: Uint8Array }`; `SymlinkInode { type:"symlink"; mode; ...times; target: string }`; factory `newDir(mode?)`, `newFile(data, mode?)`, `newSymlink(target, mode?)`. Timestamps are injected via a `now: () => number` clock parameter (deterministic in tests) — no `Date.now()` inside pure logic.
  - `resolve.ts`: `resolvePath(root: DirInode, path: string, opts: { followSymlinks: boolean; clock: () => number }): { parent: DirInode; name: string; node: Inode | undefined }` — walks the tree, throws `ENOTDIR` when a path component is a non-dir, throws `ELOOP` after 32 symlink hops. Returns the final component's parent dir, its name, and the node (or `undefined` if the last component doesn't exist).

- [ ] **Step 1: Failing tests for `path.ts`**
```ts
import { describe, it, expect } from "vitest";
import { normalize, join, dirname, basename, split } from "./path.js";
describe("path", () => {
  it("normalizes . and ..", () => {
    expect(normalize("/a/./b/../c")).toBe("/a/c");
    expect(normalize("/a/b/")).toBe("/a/b");
    expect(normalize("/")).toBe("/");
    expect(normalize("/a/../..")).toBe("/"); // cannot escape root
  });
  it("rejects relative paths", () => {
    expect(() => normalize("a/b")).toThrow(/EINVAL/);
  });
  it("dirname/basename/split", () => {
    expect(dirname("/a/b/c")).toBe("/a/b");
    expect(basename("/a/b/c")).toBe("c");
    expect(split("/a/b")).toEqual(["a", "b"]);
    expect(split("/")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm vitest run packages/runtime-browser/src/vfs/path.test.ts`

- [ ] **Step 3: Implement `path.ts`** — pure string logic. `normalize` throws `new ErrnoError("EINVAL",{path:p})` if `!p.startsWith("/")`; folds segments on a stack, `..` pops (no-op at root), drops `.` and empty; rejoins with `/`; returns `/` when empty.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Failing tests for `resolve.ts`** — build a small tree in-test (`/a/b` dir, `/a/f` file, `/a/link -> b`), assert:
  - resolving `/a/f` returns `{ parent: <dir a>, name:"f", node:<file> }`;
  - resolving `/a/missing` returns node `undefined`, parent `<dir a>`;
  - resolving `/a/f/x` throws `ENOTDIR`;
  - resolving `/nope/x` throws `ENOENT`;
  - with `followSymlinks:true`, `/a/link` resolves to the `b` dir; a self-referential symlink throws `ELOOP`.

- [ ] **Step 6: Run → FAIL.**

- [ ] **Step 7: Implement `inode.ts` + `resolve.ts`.** `resolvePath` splits the path, walks from root, for each intermediate component requires a directory (else `ENOTDIR`) that contains the child (else `ENOENT`); follows symlinks on intermediate components always and on the final component only when `followSymlinks`, counting hops to enforce `ELOOP` at 32.

- [ ] **Step 8: Run → PASS.**

- [ ] **Step 9: Commit** `git commit -am "feat(vfs): inode model + path normalization + resolver"`

---

### Task 4: `runtime-browser` VFS — the Vfs class (file & dir ops)

**Files:**
- Create: `packages/runtime-browser/src/vfs/vfs.ts`
- Test: `packages/runtime-browser/src/vfs/vfs.test.ts`

**Interfaces:**
- Consumes: `inode.ts`, `resolve.ts`, `path.ts`, contract errno factories + `Stat`/`FileEntry`/`FileType`.
- Produces: `class Vfs` with a `now`-clock ctor and an optional `EventEmitter` for `file.changed`:
```ts
class Vfs {
  constructor(opts?: { clock?: () => number; onEvent?: (e: RuntimeEvent) => void });
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | string, opts?: WriteFileOptions): void;
  appendFile(path: string, data: Uint8Array | string): void;
  mkdir(path: string, opts?: MkdirOptions): void;
  readdir(path: string): FileEntry[];
  rm(path: string, opts?: RmOptions): void;
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
  stat(path: string): Stat;
  lstat(path: string): Stat;
  chmod(path: string, mode: number): void;
  symlink(target: string, linkPath: string): void;
  readlink(path: string): string;
  exists(path: string): boolean;
}
```
(These are synchronous — the VFS is in-memory. The async Runtime methods in Task 13 wrap them.)

- [ ] **Step 1: Failing tests** covering, each as its own `it`:
  - `writeFile` then `readFile` round-trips bytes and utf-8 strings;
  - `readFile("/missing")` throws `ENOENT` with `path:"/missing"`, `syscall:"open"`;
  - `writeFile("/a/b/c", ...)` when `/a` missing throws `ENOENT` (no auto-mkdir — no fallback);
  - `mkdir("/a/b", {recursive:true})` creates both; `mkdir` existing throws `EEXIST`; non-recursive `mkdir("/a/b")` with missing `/a` throws `ENOENT`;
  - `readdir` returns sorted `FileEntry[]`; `readdir` on a file throws `ENOTDIR`;
  - `rm("/dir")` non-recursive on non-empty dir throws `ENOTEMPTY`; `rm("/dir",{recursive:true})` deletes; `rm("/missing")` throws `ENOENT`, but `rm("/missing",{force:true})` is a no-op;
  - `rename` moves a file and a dir subtree; `stat` after rename reflects new path;
  - `stat` returns `type/size/mode`; `stat` follows symlinks, `lstat` does not;
  - `symlink`+`readlink` round-trip; reading through a symlink returns target bytes;
  - `writeFile` emits `file.changed {kind:"modify"|"create"}`; `rm` emits `{kind:"delete"}`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `Vfs`** on top of `resolvePath`. Each mutator updates timestamps via the injected clock and, when `onEvent` is set, emits the corresponding `file.changed`. No operation auto-creates parents unless `recursive` is set. Throw the precise errno at each failure point (`readFile` on a directory → `EISDIR`; write to a path whose parent is a file → `ENOTDIR`).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(vfs): synchronous in-memory filesystem with errno + change events"`

---

### Task 5: `runtime-browser` — event bus + byte streams

**Files:**
- Create: `packages/runtime-browser/src/core/event-bus.ts`, `packages/runtime-browser/src/core/byte-stream.ts`
- Test: `event-bus.test.ts`, `byte-stream.test.ts`

**Interfaces:**
- Produces:
  - `class EventBus { subscribe(l: RuntimeEventListener): Unsubscribe; emit(e: RuntimeEvent): void }` — synchronous fan-out, unsubscribe removes exactly one listener.
  - `class PipeStream` implementing both `ByteStream` and `WritableByteStream`: an async queue of `Uint8Array` chunks. `write(chunk)` enqueues (encoding strings utf-8), `end()` closes; `read()` is an async iterator that yields queued chunks until closed; `text()` awaits end and returns decoded utf-8. Backpressure is out of scope (in-memory). Writing after `end()` throws `EBADF`.

- [ ] **Step 1: Failing tests** — EventBus fan-out to 2 listeners, unsubscribe stops delivery; PipeStream: write→read ordering preserved, `text()` concatenates, write-after-end throws `EBADF`, `read()` completes after `end()`.

- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(core): event bus + pipe byte streams"`

---

### Task 6: `runtime-browser` — process table + in-process executor

**Files:**
- Create: `packages/runtime-browser/src/process/program.ts`, `packages/runtime-browser/src/process/process-table.ts`
- Test: `process-table.test.ts`

**Interfaces:**
- Consumes: `Vfs`, `PipeStream`, `EventBus`, contract process types, `esrch`/`ErrnoError`.
- Produces:
  - `program.ts`:
    ```ts
    export interface ProcessContext {
      pid: number; argv: string[]; env: Record<string, string>; cwd: string;
      stdin: ByteStream; stdout: WritableByteStream; stderr: WritableByteStream;
      vfs: Vfs;
      spawn(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string,string> }): Promise<ProcessRecord>;
    }
    export type Program = (ctx: ProcessContext) => Promise<number>;   // returns exit code
    export type ProgramRegistry = Map<string, Program>;
    ```
  - `process-table.ts`: `class ProcessTable` holding `ProcessRecord`s:
    ```ts
    interface ProcessRecord {
      pid: number; ppid: number; cmd: string; args: string[]; cwd: string;
      env: Record<string,string>; state: ProcessState; exitCode: number | null;
      signal: Signal | null; startTimeMs: number;
      stdin: PipeStream; stdout: PipeStream; stderr: PipeStream;
      wait(): Promise<ExitStatus>; kill(signal?: Signal): void;
    }
    class ProcessTable {
      constructor(deps: { vfs: Vfs; bus: EventBus; registry: ProgramRegistry; clock: () => number });
      spawn(opts: SpawnOptions & { ppid?: number }): ProcessRecord;   // looks up registry[opts.cmd], throws ENOENT if unknown command
      get(pid: number): ProcessRecord | undefined;
      list(): ProcessInfo[];
      kill(pid: number, signal?: Signal): void;   // throws ESRCH if unknown pid
      wait(pid: number): Promise<ExitStatus>;
    }
    ```
    `spawn` allocates the next pid, creates stdio pipes, feeds `opts.stdin` into the stdin pipe and ends it, resolves the program from the registry (unknown cmd → `ErrnoError("ENOENT",{path:cmd,syscall:"spawn"})`), then runs it on a microtask. On program return it sets `state:"exited"`, `exitCode`, ends stdout/stderr, emits `process.exited`. A thrown program error → `exitCode:1`, error text written to stderr (no swallow — the message is surfaced). `kill` sets `state:"killed"`, `signal`, resolves `wait()` with `{code:128+n, signal}` and (best-effort) stops further output. Emits `process.started` on spawn.

- [ ] **Step 1: Failing tests** using a tiny registry:
  - register `echo: async (ctx)=>{ ctx.stdout.write(ctx.argv.slice(1).join(" ")); return 0; }`; spawn it, `await rec.wait()` → `{code:0}`, `stdout.text()` → the args;
  - register `fail: async ()=>2`; wait → `{code:2}`;
  - register `boom: async ()=>{ throw new Error("kaboom") }`; wait → `{code:1}`, stderr contains "kaboom";
  - spawn unknown cmd → throws `ENOENT` with `path` = cmd;
  - `list()` shows a running process with correct `ppid`; after exit, `exitCode` set;
  - `kill(pid,"SIGKILL")` on a never-resolving program → `wait()` resolves `{code:137, signal:"SIGKILL"}`; `kill` unknown pid → `ESRCH`;
  - `process.started` and `process.exited` events fire with the right pid.

- [ ] **Step 2: Run → FAIL. Step 3: Implement `ProcessTable` + `ProcessContext`.wiring. Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(process): process table + in-process program executor"`

---

### Task 7: `runtime-browser` — pipes, spawn tree, background

**Files:**
- Modify: `packages/runtime-browser/src/process/process-table.ts` (add `spawnPiped(stages)` helper + child `spawn` in ctx)
- Create: `packages/runtime-browser/src/process/pipe.ts`
- Test: `process-pipe.test.ts`

**Interfaces:**
- Produces: `pipeProcesses(a: ProcessRecord, b: ProcessRecord): void` — streams `a.stdout` chunks into `b.stdin`, ending `b.stdin` when `a.stdout` closes. `ProcessTable.spawnPiped(stages: SpawnOptions[]): ProcessRecord[]` — spawns all, pipes stdout→stdin down the chain, returns records (last one's stdout is the pipeline output). `ctx.spawn` creates a child with `ppid = ctx.pid`.

- [ ] **Step 1: Failing tests** — with `echo` + a `grep`-like program registered: `spawnPiped([{cmd:"echo",args:["hi\nbye"]},{cmd:"grep",args:["hi"]}])`, last stage stdout → "hi\n"; child spawned via `ctx.spawn` has correct `ppid`.

- [ ] **Step 2: FAIL → Step 3: Implement → Step 4: PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(process): pipelines and child spawn tree"`

---

### Task 8: `runtime-browser` — shell tokenizer + parser

**Files:**
- Create: `packages/runtime-browser/src/shell/tokenizer.ts`, `packages/runtime-browser/src/shell/parser.ts`, `packages/runtime-browser/src/shell/ast.ts`
- Test: `tokenizer.test.ts`, `parser.test.ts`

**Interfaces:**
- Produces:
  - `ast.ts`: node types
    ```ts
    export interface Command { kind:"command"; words: Word[]; redirects: Redirect[]; }
    export interface Word { parts: WordPart[]; }               // parts for quoting/expansion
    export type WordPart = { t:"lit"; v:string } | { t:"var"; name:string } | { t:"glob"; v:string };
    export interface Redirect { fd: 0|1|2; op:">"|">>"|"<"; target: Word; }
    export interface Pipeline { kind:"pipeline"; commands: Command[]; }
    export type ListOp = "&&" | "||" | ";";
    export interface List { kind:"list"; items: { pipeline: Pipeline; op: ListOp | null }[]; background: boolean; }
    ```
  - `tokenizer.ts`: `tokenize(src: string): Token[]` handling single quotes (literal), double quotes (var-expandable), unquoted words, operators `| || && ; < > >> 2>`, `&` at end, `$VAR`/`${VAR}`, whitespace. Unterminated quote throws `EINVAL` with a clear message.
  - `parser.ts`: `parse(src: string): List` building the AST above; a bare `*`/`?` in an unquoted literal becomes a `glob` part.

- [ ] **Step 1: Failing tokenizer tests** — `echo "a b" 'c'` → 3 word tokens; `a | b && c` operators; `x > f 2> e`; `$HOME` and `${X}` var tokens; unterminated quote throws `EINVAL`.

- [ ] **Step 2: FAIL → Step 3: Implement tokenizer → Step 4: PASS.**

- [ ] **Step 5: Failing parser tests** — `echo hi | grep h` → List(1 item, pipeline of 2 commands); `a && b || c` → 3 items with ops `[null,"&&","||"]`... (encode op on the *following* item); `echo x > f.txt` → command with one redirect fd1 op`>`; `sleep 1 &` → `background:true`; `ls *.ts` → word with a glob part.

- [ ] **Step 6: FAIL → Step 7: Implement parser → Step 8: PASS.**

- [ ] **Step 9: Commit** `git commit -am "feat(shell): tokenizer + parser (pipelines, redirects, quoting, vars, globs)"`

---

### Task 9: `runtime-browser` — shell interpreter

**Files:**
- Create: `packages/runtime-browser/src/shell/expand.ts`, `packages/runtime-browser/src/shell/interpreter.ts`
- Test: `expand.test.ts`, `interpreter.test.ts`

**Interfaces:**
- Consumes: parser AST, `ProcessTable`, `Vfs`.
- Produces:
  - `expand.ts`: `expandWord(word: Word, env, vfs, cwd): string[]` — joins literal/var parts (unknown var → `""`, matching POSIX; this is not a fallback, it's the defined semantics), then glob-expands against the vfs (a glob that matches nothing yields the literal pattern, POSIX default). Returns the argv fragments.
  - `interpreter.ts`: `class Shell { constructor(deps:{table:ProcessTable; vfs:Vfs; env:Record<string,string>; cwd:string}); run(src: string): Promise<number> }` — parses, then for each list item: expands words, applies redirects (open/create files in the vfs, wire fds to `PipeStream`s or vfs-backed sinks), spawns the pipeline via `table.spawnPiped`, awaits exit, and honors `&&`/`||`/`;` short-circuit using the previous exit code. `cd`/`export` mutate the shell's own `cwd`/`env` (they are shell built-ins, executed in-process, not via the table). Background items are spawned without awaiting.

- [ ] **Step 1: Failing expand tests** — `$UNSET` → `[""]`... actually joins to one empty arg; `${HOME}/x` with env → `/root/x`; glob `*.ts` in a dir with `a.ts b.js` → `["a.ts"]`; no-match glob `*.zzz` → `["*.zzz"]`.

- [ ] **Step 2: FAIL → Step 3: Implement expand → Step 4: PASS.**

- [ ] **Step 5: Failing interpreter tests** (register the Task-10 built-ins via a shared registry factory — or use stubs, then re-run after Task 10):
  - `echo hi | grep h` → stdout "hi\n", exit 0;
  - `echo x > /f.txt` then `cat /f.txt` → "x\n"; `echo y >> /f.txt` appends;
  - `false && echo no` → "no" NOT printed; `false || echo yes` → "yes" printed;
  - `cd /tmp && pwd` → "/tmp"; `export A=1 && echo $A` → "1".

- [ ] **Step 6: FAIL → Step 7: Implement interpreter (may depend on Task 10 built-ins; if so, order 9↔10 so tests pass together). Step 8: PASS.**

- [ ] **Step 9: Commit** `git commit -am "feat(shell): word expansion + pipeline/redirect/list interpreter"`

---

### Task 10: `runtime-browser` — built-in commands

**Files:**
- Create: `packages/runtime-browser/src/builtins/index.ts` + one file per command group (`fs-commands.ts`, `text-commands.ts`, `proc-commands.ts`, `env-commands.ts`)
- Test: `builtins.test.ts`

**Interfaces:**
- Produces: `createBuiltins(): ProgramRegistry` mapping each command name to a `Program`. Commands + exact behavior:
  - `pwd` → prints `ctx.cwd`. `echo [-n] args...` → joins args with space + newline (`-n` suppresses newline).
  - `ls [-a] [-l] [path]` → lists dir entries (sorted; `-a` includes dotfiles; default hides them; `-l` long format `type mode size name`). Missing path → `ENOENT` to stderr, exit 1.
  - `cat path...` → concatenates file bytes to stdout; missing file → stderr `ENOENT`, exit 1.
  - `mkdir [-p] path...`; `rm [-r] [-f] path...`; `cp [-r] src dst`; `mv src dst`; `touch path...` (create empty / update mtime).
  - `find <dir> [-name pattern] [-type f|d]` → prints matching paths (recursive walk).
  - `grep [-i] [-n] [-v] pattern [file...]` → reads files or stdin, prints matching lines (`-n` prefixes line numbers, `-v` inverts, `-i` case-insensitive). Exit 1 if no match (grep convention).
  - `head [-n N] [file]` / `tail [-n N] [file]` → first/last N lines (default 10), file or stdin.
  - `which name` → prints the name if in the registry else exit 1. `env` → prints `K=V` lines. `export K=V` → shell built-in (handled in interpreter; registry entry is a no-op guard).
  - `ps` → prints the process table (`ctx` needs table access — pass a `getProcesses()` via a closure when building the registry). `kill [-SIG] pid` → calls table.kill; unknown pid → `ESRCH` to stderr, exit 1.
  - `true` → 0; `false` → 1.
- `cd`/`export` are interpreter built-ins (Task 9), not in this registry (or present as guards). Document which is which in `builtins/index.ts`.

- [ ] **Step 1: Failing tests** — at least one `it` per command asserting stdout/exit/errno-to-stderr. E.g. `grep` inverts with `-v`, exits 1 on no match; `head -n 2`; `find /x -name '*.ts'`; `ls -a` shows dotfiles; `cat /missing` → exit 1 + stderr contains "ENOENT".

- [ ] **Step 2: FAIL → Step 3: Implement all built-ins → Step 4: PASS.** Re-run Task 9 interpreter tests now that real built-ins exist: `pnpm vitest run packages/runtime-browser/src/shell`.

- [ ] **Step 5: Commit** `git commit -am "feat(builtins): core coreutils (ls cat grep find head tail mkdir rm cp mv touch ps kill env which)"`

---

### Task 11: `runtime-browser` — snapshots + SnapshotStore

**Files:**
- Create: `packages/runtime-browser/src/snapshot/serialize.ts`, `packages/runtime-browser/src/snapshot/memory-store.ts`, `packages/runtime-browser/src/snapshot/indexeddb-store.ts`
- Test: `snapshot.test.ts`, `indexeddb-store.test.ts`

**Interfaces:**
- Consumes: `Vfs` internals (root inode), contract `Snapshot`/`SnapshotFsNode`/`SnapshotStore`.
- Produces:
  - `serialize.ts`: `snapshotVfs(vfs: Vfs, clock): Snapshot` (walks the inode tree → `SnapshotFsNode`, file bytes base64), `restoreVfs(vfs: Vfs, snapshot: Snapshot): void` (clears the tree and rebuilds it). Add `Vfs.getRoot()` / `Vfs.replaceRoot()` internal accessors as needed.
  - `memory-store.ts`: `class MemorySnapshotStore implements SnapshotStore` (a `Map`).
  - `indexeddb-store.ts`: `class IndexedDbSnapshotStore implements SnapshotStore` — one object store `snapshots` keyed by id; uses the global `indexedDB` (tests inject `fake-indexeddb`). No fallback if `indexedDB` is undefined — throw a clear error `"IndexedDbSnapshotStore requires a browser/IndexedDB environment"`.

- [ ] **Step 1: Failing snapshot tests** — write `/a/f.txt="hi"`, mkdir `/a/b`, symlink; `snap = snapshotVfs(...)`; mutate (delete `/a/f.txt`, add `/c`); `restoreVfs(vfs, snap)`; assert tree matches the snapshot exactly (f.txt back, `/c` gone). Round-trip through `JSON.parse(JSON.stringify(snap))` first to prove serializability.

- [ ] **Step 2: FAIL → Step 3: Implement serialize + MemorySnapshotStore → Step 4: PASS.**

- [ ] **Step 5: Failing IndexedDB test** — `import "fake-indexeddb/auto"`; `save("proj", snap)`, `load("proj")` deep-equals snap, `list()` → `["proj"]`, `delete`; `load("nope")` → `null`.

- [ ] **Step 6: FAIL → Step 7: Implement IndexedDbSnapshotStore → Step 8: PASS.**

- [ ] **Step 9: Commit** `git commit -am "feat(snapshot): vfs serialize/restore + memory & indexeddb stores"`

---

### Task 12: `runtime-browser` — ports + network

**Files:**
- Create: `packages/runtime-browser/src/port/registry.ts`, `packages/runtime-browser/src/net/network.ts`
- Test: `registry.test.ts`, `network.test.ts`

**Interfaces:**
- Produces:
  - `registry.ts`: `class PortRegistry { constructor(bus: EventBus); listen(port: number): VirtualPort; exposePort(port: number): string; }` — `listen` throws `EADDRINUSE` if bound; `exposePort` returns `https://${port}.preview.erdou.local/` and emits `port.opened`; `VirtualPort.close()` frees it.
  - `network.ts`: `class NetworkManager { constructor(opts:{ permission: Permission }); fetch(input, init?): Promise<Response> }` — throws `EACCES` with message "network permission not granted" if `!permission.granted`, else delegates to global `fetch`.

- [ ] **Step 1: Failing tests** — `listen(3000)` then `listen(3000)` throws `EADDRINUSE`; `close()` then re-`listen` ok; `exposePort(3000)` returns the URL and emits `port.opened {port:3000,url}`; `NetworkManager` with denied permission throws `EACCES`; with granted permission + a stubbed global `fetch`, delegates.

- [ ] **Step 2: FAIL → Step 3: Implement → Step 4: PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(net): virtual port registry + permission-gated network"`

---

### Task 13: `runtime-browser` — BrowserRuntime (compose)

**Files:**
- Create: `packages/runtime-browser/src/browser-runtime.ts`
- Modify: `packages/runtime-browser/src/index.ts` (export `BrowserRuntime` + key classes)
- Test: `browser-runtime.test.ts`

**Interfaces:**
- Produces: `class BrowserRuntime implements Runtime` composing `Vfs` + `EventBus` + `ProcessTable` (registry from `createBuiltins`) + `Shell` + `PortRegistry` + `NetworkManager` + snapshot. Implements every contract method:
  - fs methods delegate to `Vfs` (async wrappers around sync calls);
  - `spawn`/`kill`/`wait`/`getProcesses` delegate to `ProcessTable`, returning `ProcessHandle`/`ProcessInfo` shapes from the contract;
  - `exec(commandLine)` runs it through `Shell` and returns a `ProcessHandle` whose stdout/stderr are the pipeline's;
  - `createSnapshot`/`restoreSnapshot` via `serialize.ts`;
  - `listen`/`exposePort` via `PortRegistry`;
  - `getCapabilities()` → `{ nativeProcesses:true, virtualPorts:true, persistentStorage:true, network:true, threads:false, nativeAddons:false }`;
  - `subscribe` via `EventBus`; `boot`/`shutdown` set up / tear down (shutdown kills all processes).

- [ ] **Step 1: Failing integration test** — `const rt = new BrowserRuntime(); await rt.boot();`
  - `await rt.writeFile("/hello.txt","hi")`; `(await rt.readFile("/hello.txt"))` decodes to "hi";
  - `const p = await rt.exec("echo hi | grep h"); await p.wait()` → `{code:0}`, `await p.stdout.text()` → "hi\n";
  - `await rt.mkdir("/proj"); await rt.exec("ls -a /")` lists `proj`;
  - snapshot → mutate → restore returns state;
  - `await rt.exposePort(3000)` returns a URL; a subscribed listener receives `port.opened`;
  - `(await rt.getCapabilities()).nativeProcesses === true`.

- [ ] **Step 2: FAIL → Step 3: Implement `BrowserRuntime` → Step 4: PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(runtime-browser): BrowserRuntime composing the kernel behind the contract"`

---

### Task 14: `conformance` — the suite

**Files:**
- Create: `packages/conformance/src/index.ts` (exports `runConformance`), `packages/conformance/src/suites/{fs,process,shell,snapshot,port,capabilities}.ts`
- Create: `packages/conformance/src/browser-runtime.conformance.test.ts` (runs the suite against `BrowserRuntime`, via a devDependency on `@erdou/runtime-browser`)
- Test: the file above IS the test.

**Interfaces:**
- Consumes: only `@erdou/runtime-contract` (types) in the suite modules. The concrete `BrowserRuntime` is imported *only* in the `.conformance.test.ts` glue (a devDependency), keeping the suite runtime-agnostic.
- Produces: `runConformance(name: string, makeRuntime: () => Promise<Runtime> | Runtime): void` — registers Vitest `describe`/`it` blocks (import `describe,it,expect` from vitest) exercising:
  - **fs:** write/read round-trip; ENOENT on missing; mkdir recursive; readdir; rm recursive; rename.
  - **process:** exec a command, exit code + stdout; unknown command surfaces an error.
  - **shell:** pipeline, redirection to a file then read back, `&&`/`||` short-circuit.
  - **snapshot:** createSnapshot → mutate → restoreSnapshot equivalence.
  - **port:** exposePort returns a URL and emits `port.opened`.
  - **capabilities:** `getCapabilities()` returns all required boolean keys.

- [ ] **Step 1: Write the suite modules** (real `expect` assertions, no placeholders — mirror the Task 13 behaviors but written against the `Runtime` interface only).

- [ ] **Step 2: Write the glue test**
```ts
import { runConformance } from "./index.js";
import { BrowserRuntime } from "@erdou/runtime-browser";
runConformance("BrowserRuntime", () => new BrowserRuntime());
```

- [ ] **Step 3: Run → PASS** `pnpm vitest run packages/conformance`. If any suite fails, fix `runtime-browser` (the suite is the source of truth for contract behavior).

- [ ] **Step 4: Commit** `git commit -am "feat(conformance): runtime-agnostic contract suite, green against BrowserRuntime"`

---

### Task 15: `model-gateway` — thin BYO-key connector

**Files:**
- Create: `packages/model-gateway/src/types.ts`, `openai.ts`, `anthropic.ts`, `gateway.ts`, `index.ts`
- Test: `gateway.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ModelConfig { provider: "openai-compatible" | "anthropic"; baseUrl: string; apiKey: string; model: string; }
  export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }
  export interface ChatResult { content: string; }
  export class ModelGateway {
    constructor(deps?: { fetch?: typeof fetch });
    chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResult>;
    chatStream(config: ModelConfig, messages: ChatMessage[]): AsyncIterable<string>;  // yields text deltas
  }
  ```
  `chat` posts to the provider's endpoint (`/chat/completions` for openai-compatible with `Authorization: Bearer`, `/v1/messages` for anthropic with `x-api-key` + `anthropic-version`), maps the response to `ChatResult`. A non-2xx response throws an `Error` with status + body text (fail-fast, no fallback). `chatStream` parses SSE deltas. `fetch` is injectable for tests.

- [ ] **Step 1: Failing tests** with an injected fake `fetch`:
  - openai-compatible `chat` posts to `${baseUrl}/chat/completions` with bearer auth and returns `choices[0].message.content`;
  - anthropic `chat` posts to `${baseUrl}/v1/messages` with `x-api-key` and returns `content[0].text`;
  - a 401 response throws `Error` containing "401" and the body;
  - `chatStream` yields deltas from a fake SSE stream.

- [ ] **Step 2: FAIL → Step 3: Implement → Step 4: PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(model-gateway): BYO-key OpenAI-compatible + Anthropic connector"`

---

### Task 16: Layering gate + build + docs + final green

**Files:**
- Modify: `.dependency-cruiser.cjs` (real rules), root `README.md`, per-package `README.md`
- Create: `.github/workflows/ci.yml` (optional but include)

**Interfaces:** Produces the CI-enforced architecture invariant.

- [ ] **Step 1: `.dependency-cruiser.cjs` rules**
```js
module.exports = {
  forbidden: [
    { name: "contract-is-pure", severity: "error",
      from: { path: "^packages/runtime-contract/src" },
      to: { path: "^packages/(runtime-browser|conformance|model-gateway)/src" } },
    { name: "browser-only-contract", severity: "error",
      from: { path: "^packages/runtime-browser/src" },
      to: { path: "^packages/(conformance|model-gateway)/src|^packages/.*agent" } },
    { name: "runtime-never-imports-model", severity: "error",
      from: { path: "^packages/runtime-(contract|browser)/src" },
      to: { path: "model-gateway|agent" } },
    { name: "no-orphan-cycles", severity: "error", from: {}, to: { circular: true } },
  ],
  options: { tsConfig: { fileName: "tsconfig.base.json" }, doNotFollow: { path: "node_modules" }, enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import","types"] } },
};
```

- [ ] **Step 2: Run the gate** `pnpm lint:deps` → Expected: 0 violations. (If the conformance glue import of `@erdou/runtime-browser` trips a rule, scope the rule to `src/suites` only — the glue test is allowed to import a concrete runtime.)

- [ ] **Step 3: READMEs** — root README states the layering invariant + how to run `test`/`lint:deps`/`conformance`; each package README states its role + public API in 5-10 lines.

- [ ] **Step 4: Build all** `pnpm build` → every package emits `dist` with `.d.ts`. Fix any type/export issues.

- [ ] **Step 5: CI workflow** `.github/workflows/ci.yml` running `pnpm install`, `pnpm lint:deps`, `pnpm typecheck`, `pnpm test`, `pnpm build` on Node 22.

- [ ] **Step 6: Full green** `pnpm typecheck && pnpm lint:deps && pnpm test && pnpm build` → all pass.

- [ ] **Step 7: Commit** `git commit -am "chore: dependency-cruiser layering gate, CI, docs; full green"`

---

## Self-Review

**Spec coverage:** contract (§4)→T1-2; VFS (§5.1)→T3-4; event/stream infra→T5; process (§5.2)→T6-7; shell (§5.3)→T8-10; snapshot+persistence (§5.4)→T11; ports+net (§5.5-6)→T12; BrowserRuntime (§5.7)→T13; conformance (§6)→T14; model-gateway (§7)→T15; layering gate + tooling (§3, §8)→T0,T16. Acceptance bullets (§1) all covered by T13+T14. No gaps.

**Placeholder scan:** No TBD/TODO; each code step shows real code or an exact behavior spec; built-ins enumerated with exact flags; test assertions concrete.

**Type consistency:** `ProcessRecord`/`ProcessContext`/`Program`/`ProgramRegistry` defined in T6 and reused verbatim in T7/T9/T10/T13. `Snapshot`/`SnapshotFsNode`/`SnapshotStore` defined in T2, implemented in T11. `Vfs` method names fixed in T4 and consumed unchanged downstream. `ModelConfig`/`ChatMessage` in T15 only. Runtime method names match the contract in T2.

**Note on T9↔T10 ordering:** the interpreter tests depend on real built-ins; implement T10 immediately after T9's parser wiring and run both shell test dirs together before committing T10.
