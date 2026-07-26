# @erdou/lang-python

A `python` / `python3` runtime for Erdou, backed by **Pyodide** (CPython compiled to WebAssembly). Register it and the shell, `exec`, and the agent can run Python:

```ts
import { createPythonRunners } from "@erdou/lang-python";

const { python, pip } = createPythonRunners({
  load: async () => {
    const { loadPyodide } = await import("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs");
    return loadPyodide();               // lazily loaded on first `python` call
  },
});
runtime.registerProgram("python", python);
runtime.registerProgram("python3", python);
runtime.registerProgram("pip", pip);    // `pip3` too, if you want it
```

`createPythonRunners` returns **both** executors from one factory so they share a single lazily-loaded interpreter — installs made by `pip` land in the very interpreter `python` then runs in. `pip install <pkg…>` resolves in three steps: an optional host-supplied wheel resolver (`load.localWheels`) installs a bundled requirement from its same-origin wheel closure in one `micropip.install(urls)` call; everything it does not claim goes to Pyodide's prebuilt wheels (NumPy/Pandas/SciPy/lxml/Pillow… — C extensions included) via `loadPackage`, then to `micropip` for pure-Python PyPI wheels; a package in none of the three fails loudly. Note `loadPackage` only ever sees a **bare** name — a version-pinned requirement fails the `PLAIN_NAME` check, so `pip install numpy==2.0` skips the prebuilt set entirely and goes straight to `micropip`, which honors the pin rather than silently installing Pyodide's version. Installs live in the page session only.

It syncs the Erdou filesystem into Pyodide before running and back afterward (so `open("/app/x.txt")` and files the script writes both work), wires stdout/stderr, sets `sys.argv`/cwd, runs the script in a fresh namespace, and reports the real exit code (including `sys.exit(n)`).

Depends only on `@erdou/runtime-contract` — it's a language pack written against the executor extension point, so the same pattern adds Ruby, Lua, or any wasm runtime. Pyodide is injected (not bundled), so the package stays light and testable.
