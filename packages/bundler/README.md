# @erdou/bundler

Bundles a project from the Erdou filesystem into a runnable, self-contained web app — **entirely in the browser**, no `npm install`. Local files load from the VFS; bare (npm) imports are fetched from a CDN (esm.sh) at build time and bundled in, so the preview needs no network at runtime and runs in a strictly-sandboxed iframe.

```ts
import * as esbuild from "esbuild-wasm";
import { bundle, findEntry, previewHtml } from "@erdou/bundler";

await esbuild.initialize({ wasmURL });
const entry = findEntry(runtime.fs);              // e.g. /src/main.tsx
const { js, css, errors } = await bundle({ esbuild, fs: runtime.fs, entry });
iframe.srcdoc = previewHtml(js, css);             // a real React/Vite-style app renders
```

Uses esbuild-wasm (injected, so this package stays light) for TS/JSX transform + bundling. `esbuild` is passed in structurally, so nothing hard-depends on it. Depends only on `@erdou/runtime-contract`. Verified: React TSX bundles with npm deps fetched+inlined (Node test), and a real interactive React counter renders in the browser preview.
