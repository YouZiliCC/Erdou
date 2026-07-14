# @erdou/web

The Erdou web app — open a page, describe a task, watch an AI agent operate a browser-native OS to accomplish it. Everything (filesystem, processes, shell, snapshots, the agent loop) runs **in your browser**; only the model API call leaves it.

## Run it

```bash
pnpm install
pnpm --filter @erdou/web dev
# open the printed URL, click "Model", paste your key
```

- **Model key** is stored only in your browser (localStorage) and sent straight to your provider.
- **CORS**: model APIs usually block direct browser calls, so the dev server proxies `/llm/*` to the provider. The default base URL `/llm/v1` uses this proxy; set `VITE_LLM_TARGET` to change the upstream (default `https://yunwu.ai`).
- **Persistence**: your project is snapshotted to IndexedDB and restored on reload. "Reset" clears it.

## What's on screen

- **Task composer + syscall tape** — the agent's every step (thought · tool call · result · exit) streams live as a color-coded trace.
- **Files** — the runtime filesystem, click to view.
- **Terminal** — an interactive shell into the runtime (`ls`, `cat`, pipes, redirection…).
- **Processes** — the live process table.

Composes `@erdou/runtime-browser`, `@erdou/agent-core`, `@erdou/agent-tools`, `@erdou/model-gateway`. This is the top (application) layer; it depends on everything below and nothing depends on it.
