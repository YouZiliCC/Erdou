# @erdou/agent-tools

The Coding Agent's toolset, defined over the **Runtime contract** so it works against any Runtime implementation. Tools: `read_file`, `write_file`, `list_dir`, `make_dir`, `remove_path`, `run_shell`.

Each tool has a name, description, JSON-Schema `parameters`, and an `execute(ctx, args)` that returns `{ ok, output }`. Failures are **returned, not thrown** — the agent must observe and react to them.

```ts
import { createTools } from "@erdou/agent-tools";
const tools = createTools();
const result = await tools[0].execute({ runtime }, { path: "/README.md" });
```

Depends only on `@erdou/runtime-contract`.
