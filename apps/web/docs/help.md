# Er**dou** Help

Erdou is a **computer that lives in a browser tab**: a coding agent, a runtime with a real filesystem and shell, and live app previews. Nothing is installed on your machine — close the tab and it is gone; your project stays in the browser's storage.

## Getting started

1. Open **Settings** in the title bar and set a model + API key.
2. Type a task in the chat, e.g. "build a small Flask app and serve it".
3. Watch the agent edit files and run commands; review its changes in the diff pane.

## Environments

Your code runs in one of several environments. Pick one from the selector in the title bar, or ask the agent to switch (it has a `switch_environment` tool):

{{environments}}

How to choose:

- Start on the **Browser kernel** — instant, and it covers pure-Python and static-web work.
- Switch to a **Linux VM** profile when you need a real shell, `npm`, or packages with native code. The VM is emulated x86 — expect it to be roughly 10-100x slower than native.
- Switching copies your project across. The first boot of a VM profile downloads its image (roughly 40-70 MB, then cached); a profile that has not been baked fails loudly with the bake command to run.

## Installing packages

- **Browser kernel**: `pip install <package>` uses micropip — pure-Python wheels from PyPI only, no C extensions. Installs reset on page reload.
- **Linux VM (all profiles)**: `pip install <package>` goes through the package gateway; a small package takes about 40 s. Installs land in the user site (`/root/.local`), which lives in your project workspace and **persists** across VM reboots and snapshots.
- **Linux VM · Node.js**: `npm install <package>` works the same way (about 30 s for a small package) and persists in `node_modules`.
- Virtualenvs work but are heavy under emulation: `python3 -m venv` takes ~95 s and adds ~1.5k small files to every snapshot. Prefer the default user-site installs unless you need isolation.
- NumPy/Pandas: use the **sci** profile — they are preinstalled. The first `import pandas` in a process takes ~50 s; later imports in the same process are fast.
- `apk` system packages are baked into the VM images, not installed at runtime — switch to the profile that has what you need.

```sh
pip install requests
python3 -c "import requests; print(requests.__version__)"
```

## Running and previewing apps

- The Preview panel runs a serve command in your project — e.g. `erdou serve . --spa` for static sites on the browser kernel, or a real server (Flask, `python3 -m http.server`, Node) on the VM.
- When the server opens a port, the preview attaches to it; edits can rerun the server live.
- On the VM the server must bind `0.0.0.0` — a server bound to `127.0.0.1` is only reachable inside the guest, and the panel will tell you so.

## Terminal

- On a **Linux VM** the Terminal panel is a real Alpine shell (BusyBox ash) on the guest.
- On the **Browser kernel** the shell provides built-in commands (`ls`, `cat`, `python`, `git`, `erdou serve`, …) rather than a full Unix userland.

## Working with a local folder

- You can mount a folder from your disk (File System Access API — Chromium browsers). Erdou reads it into the workspace and writes changes back to disk.
- `.git`, `node_modules` and `.erdou` are skipped on mount.

## Model configuration

- **Settings** holds the model provider, base URL, model name and API key. Any OpenAI-compatible endpoint works; the key stays in your browser's storage.
- Approval mode: **auto** lets the agent run shell commands freely; **confirm** pauses before each gated step (shell commands, deletions, environment switches) so you can allow or deny it.

## Limits and troubleshooting

- **The VM is slow.** Emulated x86 without hardware virtualization: pip runs take tens of seconds; heavy imports take ~1 min. This is expected, not a hang — watch the terminal output.
- **"image not baked"** when switching to a VM profile: run the bake command from the error (`pnpm --filter @erdou/runtime-vm bake --profile <p>`) and reload.
- **Preview shows no page**: make sure the command actually serves HTTP, and on the VM that it binds `0.0.0.0` (not `127.0.0.1`).
- **pip fails on the browser kernel**: the package probably has native code — switch to a Linux VM profile and install it there.
- **Memory**: each VM guest has 512 MB of RAM; very large installs or builds can run out.
- The browser kernel loads Python (Pyodide) from a CDN on first use — it needs network access the first time.
