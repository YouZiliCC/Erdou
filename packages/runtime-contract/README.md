# @erdou/runtime-contract

The frozen boundary of the Erdou runtime. Pure TypeScript types and interfaces that every Runtime implementation must satisfy — **zero runtime dependencies** (only the `ErrnoError` class and errno helpers ship as values).

Defines: `Runtime`, process types (`SpawnOptions`, `ProcessHandle`, `ExitStatus`), filesystem types (`Stat`, `FileEntry`), the generic `RuntimeEvent` union (no agent semantics), `RuntimeCapabilities`, `Snapshot`/`SnapshotStore`, `VirtualPort`, permissions, and POSIX-style `ErrnoError`.

Agents and tools depend on this package, never on a concrete Runtime (dependency inversion). Nothing in this package may import any other `@erdou/*` package.

```ts
import type { Runtime } from "@erdou/runtime-contract";
```
