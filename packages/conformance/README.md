# @erdou/conformance

A runtime-agnostic conformance suite for the Erdou Runtime contract. Any Runtime adapter (`BrowserRuntime`, a future `WasmRuntime`, `RemoteRuntime`, …) that passes it satisfies the contract's observable behavior.

Covers: filesystem, process, shell, snapshot, port and capabilities. The suite modules import **only** `@erdou/runtime-contract`; you inject a concrete Runtime factory.

```ts
import { runConformance } from "@erdou/conformance";
import { BrowserRuntime } from "@erdou/runtime-browser";

runConformance("BrowserRuntime", () => new BrowserRuntime());
```

Assumes a POSIX-ish baseline of shell built-ins (`echo`, `grep`, `false`). Requires `vitest` (peer dependency).
