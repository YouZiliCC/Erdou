# @erdou/lang-python

A `python` / `python3` runtime for Erdou, backed by **Pyodide** (CPython compiled to WebAssembly). Register it and the shell, `exec`, and the agent can run Python:

```ts
import { createPythonRunner } from "@erdou/lang-python";

runtime.registerProgram("python", createPythonRunner({
  load: async () => {
    const { loadPyodide } = await import("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs");
    return loadPyodide();               // lazily loaded on first `python` call
  },
}));
```

It syncs the Erdou filesystem into Pyodide before running and back afterward (so `open("/app/x.txt")` and files the script writes both work), wires stdout/stderr, sets `sys.argv`/cwd, runs the script in a fresh namespace, and reports the real exit code (including `sys.exit(n)`).

Depends only on `@erdou/runtime-contract` — it's a language pack written against the executor extension point, so the same pattern adds Ruby, Lua, or any wasm runtime. Pyodide is injected (not bundled), so the package stays light and testable.
