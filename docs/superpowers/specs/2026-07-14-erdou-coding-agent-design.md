# Erdou Coding Agent — Round 2 Design

> Status: approved-for-build · Date: 2026-07-14 · Source: `proposal_v1.md` §五, `notice.md`

## Goal

Build the **Coding Agent** — the first core application on top of the Runtime kernel. Given a task and a BYO-key model, the agent reads/writes files and runs shell commands in a `Runtime` to accomplish the task, in a closed loop (plan → act → observe → repeat → finish). Node-testable with a mock model; validated end-to-end against a real OpenAI-compatible endpoint (云雾).

## Layering (extends Round 1, still CI-enforced)

```
runtime-contract  ← agent-tools  ← agent-core → (model-gateway, runtime-contract)
```
- `@erdou/agent-tools` imports **only** `@erdou/runtime-contract` (tools operate on the `Runtime` interface, never a concrete Runtime).
- `@erdou/agent-core` imports `@erdou/agent-tools`, `@erdou/model-gateway`, `@erdou/runtime-contract`.
- Runtime layers still must never import agent-*. New dependency-cruiser rules: `agent-tools → runtime-browser` forbidden (bind to the contract).

## `@erdou/model-gateway` — add tool calling

Extend the thin connector with OpenAI-compatible function calling (what 云雾 speaks):
- `ChatMessage` gains optional `toolCalls` (assistant) and `toolCallId` (tool-result role `"tool"`).
- `ToolSpec { name, description, parameters: JSONSchema }`, `ToolCall { id, name, arguments: string }`.
- `chat(config, messages, options?)` where `options.tools?: ToolSpec[]`; returns `ChatResult { content, toolCalls: ToolCall[] }`.
- Request maps tools to `tools: [{ type: "function", function: {...} }]`; response maps `choices[0].message.tool_calls`. Non-2xx still fails loudly. Anthropic tool-calling is deferred (openai-compatible is the primary path).

## `@erdou/agent-tools`

A provider-agnostic toolset over the `Runtime` contract:

```ts
export interface ToolContext { runtime: Runtime; }
export interface ToolResult { ok: boolean; output: string; }
export interface ToolDef {
  name: string;
  description: string;
  parameters: object;                 // JSON schema
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}
export function createTools(): ToolDef[];
```

Tools: `read_file`, `write_file`, `list_dir`, `make_dir`, `remove_path`, `run_shell` (via `runtime.exec` → stdout+stderr+exit code). Each validates its args and returns a `ToolResult` with a human-readable `output`; failures return `{ ok:false, output: <errno message> }` (surfaced, not thrown, so the model can react).

## `@erdou/agent-core`

The agent loop:

```ts
export interface AgentOptions {
  runtime: Runtime;
  gateway: ModelGateway;
  model: ModelConfig;
  tools?: ToolDef[];              // defaults to createTools()
  maxSteps?: number;              // default 20
  onEvent?: (e: AgentEvent) => void;  // trace: model text, tool call, tool result, done
}
export class CodingAgent {
  constructor(opts: AgentOptions);
  run(task: string): Promise<AgentRunResult>;   // { steps, finalMessage, transcript }
}
```

Loop: seed a system prompt (describe the runtime, tools, and to finish by replying without a tool call). Send messages + tool specs to the gateway. If the model returns tool calls, execute each via agent-tools against the runtime, append tool-result messages, repeat. If it returns content with no tool calls (or `maxSteps` hit), stop and return. Emits `AgentEvent`s for a live trace. The agent makes ALL task/decision judgments (the runtime only reports facts) — honoring the layering.

## Testing

- **Unit**: mock `ModelGateway` (deterministic tool-call script) drives `CodingAgent` against a real `BrowserRuntime`; assert files created / commands run. Tool unit tests against `BrowserRuntime`. model-gateway tool-calling with injected fetch.
- **E2E (live)**: a gated test (`ERDOU_LIVE_KEY` env) gives the agent a real task against 云雾 and asserts the runtime reflects the result. Skipped when the env var is absent so CI stays hermetic.

## Out of scope this round (deferred)

In-browser JS/TS execution (QuickJS/esbuild-wasm), preview, multi-agent, the web UI. The agent this round drives files + coreutils; code-execution is Round 3 and is what unlocks "run a React app."
