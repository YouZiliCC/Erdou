# Erdou Studio — User Guide

This is the guide for *using* Erdou Studio, the web app in [`apps/web`](../apps/web). For architecture and development docs see the [README](../README.md) and each package's own README. The in-app **Help** button opens a short quick-reference; this document is the long form.

Erdou is a computer that lives in a browser tab: a coding agent, a runtime with a real filesystem and shell, and live app previews. Nothing is installed on your machine — your project lives in the browser's storage (or a folder you mount), and only the model API call leaves the tab.

## Getting started

```bash
pnpm install
pnpm --filter @erdou/web dev   # open the printed URL
```

1. Click **Settings** in the title bar and set a provider, model and API key. The dialog opens automatically on first load if no key is configured.
2. Type a task in the composer (e.g. "build a small Flask app and serve it") and press **Run** (or ⌘/Ctrl+Enter). The empty state offers example chips that pre-fill the composer.
3. Watch the agent's trace stream live; review its changes in the **Diff** tab when the turn ends.

### Model providers

Settings holds four things: **Provider**, **Base URL**, **Model**, **API key**. The key is stored only in this browser (localStorage) and sent to your provider — never to Erdou.

- **OpenAI-compatible** — any endpoint speaking the OpenAI chat-completions dialect. The default Base URL `/llm/v1` is a **dev-server proxy**: the Vite dev server forwards `/llm/*` to `https://yunwu.ai` unless you start it with `VITE_LLM_TARGET=<url>`. This exists because most providers (including `api.openai.com`) block direct browser calls with CORS.
- **Anthropic** — works **direct from the browser**: the default Base URL is `https://api.anthropic.com`, no proxy needed (the gateway sends Anthropic's browser-access header).

A direct provider URL also works as the Base URL whenever the provider permits browser requests (some OpenAI-compatible providers do allow CORS). For a **production** deployment (no Vite dev proxy) with a CORS-blocked provider, run the zero-dependency CORS relay shipped in this repo — `node scripts/model-proxy.mjs --target https://api.openai.com` — and point the Base URL at it; it mirrors the dev proxy's path mapping (`/llm/v1/…` → `<target>/v1/…`).

**Test before saving:** the **Test** button probes the values currently in the form (saved or not) with two checks — a minimal chat round-trip, and a tool-call probe. The second matters: an endpoint can be reachable yet ignore tool calling, which leaves the agent structurally unable to act — the probe warns you about exactly that instead of letting the first real task fail mysteriously. Errors are shown verbatim.

### Approvals: Auto vs Confirm

The **Command approvals** setting (also switchable in the composer) controls the gated tools — `run_shell`, `remove_path`, `switch_environment`, and the server-starting form of `open_preview`:

- **Auto** — the agent runs them freely.
- **Confirm** — the run pauses on each gated call with an inline prompt: **Allow**, **Always allow** (for that tool, for the rest of the run), or **Deny**. A bare `open_preview` that only shows you the panel (starts nothing) never asks.

## Task threads

Every task is a **thread** in the left sidebar:

- **Run / reply** — with an idle thread selected, the composer's next send *replies into it* (the model sees the whole conversation so far). **＋ New task** clears the selection so the next send starts a fresh thread.
- **Stop** — while a run is in flight the Run button becomes **Stop**. The abort takes effect at the agent's next checkpoint (an in-flight model call may take a moment — the button shows "Stopping…"), and a parked Confirm prompt is denied so the agent can't hang.
- **Rename** — hover a thread and click the pencil (✎); Enter commits, Escape cancels.
- **Delete** — hover and click ×, then click **Delete?** to confirm (the confirmation disarms itself after a few seconds). A *running* thread can't be deleted — stop it first.
- A pulsing dot marks the thread whose turn is currently in flight.

Threads persist in the browser (IndexedDB) — or in the mounted folder's `.erdou/` when one is mounted — and survive reload. A run interrupted by closing the page is marked as an error with an explanatory line. The sidebar and review pane are resizable by dragging their edges; the sidebar collapses with the ‹ button.

## The review pane

The right-hand pane has four main tabs — **Diff**, **Files**, **Terminal**, **Preview** — plus **Processes**.

### Diff

When a turn ends with file changes, the Diff tab opens automatically (unless the agent just opened the Preview for you — then it stays put until you look). Each changed file shows create/modify/delete, added/removed line counts, the line-level hunks, and a per-file **Revert** button that undoes just that change. Opening the diff marks the run reviewed.

### Files

The live runtime filesystem as a tree; click a file to view it. The header's **Download .zip** button exports the whole workspace as a zip — and the agent can do the same for you via its `package_project` tool (ask it to "package the project"), which drops a download card into the conversation. Exports include `.git` but never `node_modules` or the `.erdou` state (your API key can't end up in an export). The zip lives in browser memory only: after a reload its card honestly shows **expired** — ask for a fresh one.

### Terminal

A real terminal (xterm.js), kept alive across tab switches:

- On a **Linux VM** it is a streaming PTY into the guest — a real Alpine shell (BusyBox ash).
- On the **Browser kernel** it drives the persistent kernel shell: built-in commands (`ls`, `cat`, `python`, `git`, `erdou serve`, …) rather than a full Unix userland, with echo, history, and line editing.

Either way the working directory and environment persist across commands.

### Preview

The Preview is **agent-primary**: when the agent starts a server or calls its `open_preview` tool, the pane switches to Preview and shows it. Every open port appears as a chip in the **ports bar** — **view** it, open it in a browser tab (↗), or stop it (×). The previewed app may use relative or absolute URLs (both are proxied), and can reach a *sibling* open port via `/__port__/<n>/…`.

You can also run something yourself with the **command + port row** under the frame:

- Type any serve command and press **Run** — it executes in the persistent shell, and the panel attaches to the port it opens. The optional **port** field picks which port to *view* after the run; if that port never opens you get told, truthfully.
- On a React/TS project with a bundle entry and an empty (or auto-detected) command field, **Run** instead bundles the project in-browser (esbuild-wasm, npm imports inlined from a CDN) to `/dist` and serves that — the TS/React preview path on the browser kernel.
- Re-running first stops whatever the previous run served, so the same port can be rebound.

On the VM, servers must bind `0.0.0.0` — a `127.0.0.1` bind is only reachable inside the guest, and the panel says so. On the browser kernel, `erdou serve <dir> --spa` serves static files on a virtual port.

### Processes

The live process table of the current runtime.

### Log

The system channel's home: mount/restore/sync notices, kernel-switch progress and errors, newest at the bottom (auto-scroll pins to the tail until you scroll up). The first-run screen no longer dumps this log — look here instead. **Clear** empties it; nothing in it is load-bearing.

## Kernels and environments

Your code runs in one of four environments, selectable in the title bar (or by the agent via its `switch_environment` tool — approval-gated in Confirm mode):

- **Browser kernel** — instant, in-tab simulated OS. Python via Pyodide, `wasm32-wasi` binaries via the WASI host, JS/TS via the bundler. The default.
- **Linux VM · Python 3** (`vm:base`) — real 32-bit Alpine Linux (v86/WASM) with python3 + pip.
- **Linux VM · Python 3 + Node.js** (`vm:node`) — adds Node.js + npm.
- **Linux VM · Python 3 + NumPy/Pandas** (`vm:sci`) — the scientific stack preinstalled.

Switching copies your project across — there is one logical project and it follows you (both kernels persist to the same snapshot slot; last writer wins). The first boot of a VM profile downloads its image (roughly 48–84 MB, then cached); a switch is locked while a run is active. The VM is emulated x86 without hardware virtualization — expect roughly 10–100x slower than native. Each guest has 512 MB of RAM.

**Bake prerequisite:** VM images are baked artifacts, not committed to the repo. On a fresh clone every VM option shows "— not baked" until you run:

```bash
pnpm --filter @erdou/runtime-vm bake --profile base   # or: node | sci | --all
```

The bake needs network access to the Alpine CDN plus three boot blobs staged in `packages/runtime-vm/assets/` — see the [README](../README.md#enable-the-linux-vm-optional) for details. Selecting an unbaked profile fails loudly with the exact bake command and keeps you on the working kernel.

### What persists where

- **Project files** — snapshotted to IndexedDB (debounced) and restored on reload, on both kernels. **Reset** in the title bar deletes the workspace and run history from the browser.
- **VM package installs** — `pip` installs land in the user site (`/root/.local`), `npm` installs in `node_modules`; both live in the project workspace and **persist** across VM reboots, snapshots and kernel switches.
- **Browser-kernel pip installs** — live only in the in-page Python session and die with the page. The next session prints a one-line `pip install <names>` restore hint listing what you had installed (no automatic re-download).

## Installing packages

- **Browser kernel**: `pip install <package>` uses micropip — pure-Python wheels from PyPI only, no C extensions.
- **Linux VM (all profiles)**: `pip install <package>` goes through the package gateway (guest HTTP rides the browser's own `fetch` out to PyPI); a small package takes about 40 s.
- **Linux VM · Node.js**: `npm install <package>` works the same way (about 30 s for a small package).
- Virtualenvs work but are heavy under emulation: `python3 -m venv` takes ~95 s and adds ~1.5k small files to every snapshot. Prefer the default user-site installs.
- NumPy/Pandas: use the **sci** profile — they are preinstalled. The first `import pandas` in a process takes ~50 s; later imports in the same process are fast.
- `apk` system packages are baked into the VM images, not installed at runtime — switch to the profile that has what you need.

## Working with a local folder

**Open folder** in the sidebar mounts a directory from your disk (File System Access API — Chromium browsers only). Mounting makes **the folder the source of truth**: a non-empty in-browser workspace is replaced by the folder's contents (this is logged, and it protects your disk from being overwritten by last session's files). `.git`, `node_modules` and `.erdou` are skipped on mount.

- **Auto-sync** — workspace changes are written back to disk (debounced ~0.6 s). External disk edits are pulled in by a rescan every 5 s and on window focus.
- **Conflict skipping** — a file that changed on disk outside Erdou since the last sync is *not* overwritten by auto-save; the system log names the skipped files. If both sides changed, the next rescan pulls the disk version over the workspace copy (disk wins) and says so.
- **Pull ↓ (disk → workspace)** — a **true mirror**: loads every disk file *and deletes workspace entries absent on disk* (`.git`/`node_modules`/`.erdou` and VM image dirs always survive). Use it to make the workspace match the folder exactly.
- **Push ↑ (workspace → disk)** — the symmetric **true mirror**: writes every workspace file *and deletes disk files absent from the workspace*; files edited on disk outside Erdou are skipped as conflicts (pull first to resolve). The background auto-sync stays additive/merge-like — only these two explicit buttons delete.
- Both directions refuse to run only when they would actually destroy data (mirroring an empty side onto a non-empty one); empty-onto-empty is a harmless no-op. The status line always reports counts (written/loaded, deleted, conflicts).
- **Re-select folder…** — swap the mount to a different directory.
- **`.erdou/` state** — the mounted folder gets an `.erdou/` directory holding your chat history (`runs.json`) and app config (`config.json`: theme, approval mode, model **including the API key, in the clear**). A generated `.erdou/.gitignore` keeps `config.json` out of git commits made inside the folder — that gitignore is the only guard. A folder that already has `.erdou/` hydrates the session from it on mount.
- After a reload, the browser requires a click to re-grant folder permission — the sidebar shows a **Reconnect** button.

## Themes

The swatch button in the title bar opens the theme picker: **Ink** (dark, the default), **Paper** (light), **二豆**, and **Cream**. The choice persists in the browser and is mirrored into a mounted folder's `.erdou/` config; the Help page follows it too.

## Troubleshooting

- **"— not baked" on every VM option**: the images aren't built on your machine. Run the bake command shown (e.g. `pnpm --filter @erdou/runtime-vm bake --profile base`) and reload. Selecting one anyway fails with the same instruction.
- **Yellow banner: "Preview and local folder-mount are disabled"**: you opened the app on a plain `http://<ip>` origin, which is not a secure context — browsers withhold the Service Worker the preview proxy needs and the File System Access API. The agent, terminal and model calls still work. Fix: tunnel (`ssh -L 5173:localhost:5173 user@host`, then open `http://localhost:5173`) or serve behind TLS.
- **Preview shows no page / a port never opens**: make sure the command actually serves HTTP and keeps running; on the VM it must bind `0.0.0.0`, not `127.0.0.1`. If you named a port in the port field and the command opened a different one, the panel tells you which ports actually opened.
- **"Couldn't save your project to this browser (storage may be full or restricted)"**: the IndexedDB snapshot save is failing — free browser storage (or leave private-browsing mode). The message clears itself once a save succeeds; your in-memory session keeps working meanwhile.
- **The VM is slow**: expected, not a hang — emulated x86, no hardware virtualization. pip runs take tens of seconds; heavy imports around a minute. Watch the terminal output.
- **`pip` fails on the browser kernel**: the package probably has native code — micropip only handles pure-Python wheels. Switch to a Linux VM profile and install there.
- **Python won't start on the browser kernel**: Pyodide loads from a CDN on first use — it needs network access the first time.
