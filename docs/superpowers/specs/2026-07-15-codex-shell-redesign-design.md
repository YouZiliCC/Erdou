# Erdou Round 8 — Codex-desktop UI + terminal & mount fixes

**Date:** 2026-07-15
**Status:** Design — awaiting review
**Depends on:** Rounds 1–7 (runtime kernel, agent, `apps/web`, languages, WASI, bundler/git, SW-preview + folder mount)

## 1. Context & goals

Three user-reported problems, one combined round:

1. **The terminal's interaction logic is confusing.** Two root causes, both confirmed in code:
   - `Vfs.rename` (`packages/runtime-browser/src/vfs/vfs.ts:223`) has **no "move into a directory" case** (its sibling `copy` at `vfs.ts:250` does). So `mv 1/src ./` with cwd `/` resolves the destination to root and runs `root.children.set("/", node)` — literally creating an entry named `/` and making `src` "vanish". Any `mv foo existingDir/` silently overwrites the directory too.
   - The terminal is **stateless**: `BrowserRuntime.exec` news up a fresh `Shell` per call (`browser-runtime.ts:81`, *"cwd/env never leak between exec calls"*), so `cd` never persists across terminal commands and there is no prompt showing the working directory. The `Shell` class itself already persists cwd/env across `execute` calls (`interpreter.ts:43`) — only `exec` throws that state away.

2. **Local folder mount doesn't work in real time (both symptoms).**
   - *Initial load is flaky:* `App.openFolder` wraps `mountFolder` in `catch {}` commented "user cancelled" (`App.tsx:47`), so a genuine load error is swallowed and the files never appear — violating the project's fail-fast principle.
   - *No live pull:* mount is a one-time load + debounced write-back; edits made to the folder on disk never sync back into the in-browser VFS.

3. **Frontend should look like the Codex desktop app.** Decisions locked with the user via the visual companion:
   - **Layout B** — the faithful three-column Codex shell: task/run **threads** on the left, agent **conversation** in the center, **review** pane (Diff / Files / Terminal / Preview) on the right.
   - **Full Codex clean look** — replace the amber-phosphor-on-ink theme with Codex's near-black canvas, hairline borders, one restrained blue accent, system-sans + mono. Light theme too.
   - **Global approval toggle** — default **Auto** (agent runs autonomously); switchable to **Confirm**, which pauses before each shell/destructive command for Allow/Deny. The mechanism is built but off by default.

**Guiding principles** (from the user's standing dev principles): no over-engineering / YAGNI, minimize fallbacks (one correct path), fail-fast with detailed errno-style errors. The **layering invariant** is unchanged: agent → contract, runtime never depends on agent.

## 2. Non-goals / deferred (explicit)

- **Multi-turn conversation replies.** A run is one task execution + its transcript. The composer starts a *new* run; selecting a past run shows it read-only. Continuing a thread is deferred (would require agent-core conversation state).
- **Full git staging UI.** The review pane *views* diffs and can *revert* a file; per-chunk staging / commit stays in the terminal (`git` executor already exists).
- **Multi-tab terminal.** One persistent shell session this round (the mockup's "+ tab" is deferred).
- **Disk-delete propagation.** Live pull is additive/update-only (never deletes VFS files because they vanished on disk) — matching the existing non-deleting `saveVfsToFolder`, to avoid data loss.
- **Real command sandboxing.** "Confirm" mode is a human-in-the-loop gate, not a sandbox.
- No changes to `@erdou/runtime-contract`, `@erdou/conformance`, or the language packs.

## 3. Architecture & layering

Where each change lands, bottom-up:

| Layer | Package | Change |
|---|---|---|
| Runtime kernel | `@erdou/runtime-browser` | **A** `mv`/rename move-into-dir fix (Vfs). **B** `openShell()` → persistent `ShellSession` on `BrowserRuntime`. |
| Agent | `@erdou/agent-core` | **F** optional `approve` callback in `AgentOptions`, gating command-like tools in the run loop. |
| App | `apps/web` | **C** mount fixes, **D** run model, **E** diff tracking, **F** approval UI + mode, **G** the full Codex UI. |

No contract change: `openShell` lives on the concrete `BrowserRuntime` (the app uses it directly); the agent doesn't need it. The `approve` callback is agent-core-level (agent semantics are allowed there), so the runtime stays free of agent business.

---

## 4. Workstream A — Kernel: `mv`/rename move-into-directory

**File:** `packages/runtime-browser/src/vfs/vfs.ts` (`rename`).

Mirror `copy`'s move-into-directory semantics. Compute the **effective destination** first, then run the cycle guard against it:

```
rename(from, to):
  src = resolve(from, {followSymlinks:false})
  if src.node === undefined → ENOENT(from)
  dst = resolve(to, {followSymlinks:false})
  // move INTO an existing directory, keeping the source's basename
  if dst.node !== undefined && dst.node.type === "directory":
      targetParent = dst.node
      targetName   = src.name
      effectivePath = joinPath(normalize(to), src.name)
  else:
      targetParent = dst.parent
      targetName   = dst.name
      effectivePath = normalize(to)
  // cycle guard uses the EFFECTIVE path (a dir can't move into itself/descendant)
  if src.node.type === "directory":
      nf = normalize(from)
      if effectivePath === nf || effectivePath.startsWith(nf + "/") → EINVAL(effectivePath)
  src.parent.children.delete(src.name)
  targetParent.children.set(targetName, src.node)
  // mtimes + emit delete(from) & create(effectivePath)
```

Notes:
- Overwriting an existing **file** at the destination is allowed (POSIX). Overwriting an existing non-empty **directory** keeps `copy`'s current behavior (replace) — not worth special-casing for this round.
- The `mv` builtin (`builtins/fs.ts:106`) and `BrowserRuntime.rename` need no change — they delegate to `Vfs.rename`.

**Tests** (`vfs.test.ts` + a regression case in `regression.test.ts`):
- `mv /1/src /` → `/src` exists, **no** entry named `/`, `/1/src` gone. (the exact reported bug)
- `mv /a /dir` where `/dir` is a directory → `/dir/a`.
- `mv /a.txt /dir/` → `/dir/a.txt`.
- `mv /a /a` → EINVAL; `mv /a /a/b` (into descendant) → EINVAL.
- `mv /a.txt /b.txt` (rename, dst absent) → still works (regression guard).

---

## 5. Workstream B — Persistent terminal shell session

**Files:** `packages/runtime-browser/src/browser-runtime.ts`, new `shell/session.ts`; export from `index.ts`.

Add a thin session that owns one long-lived `Shell` (which already persists cwd/env):

```ts
export interface ShellSession {
  readonly cwd: string;                 // live working directory (for the prompt)
  exec(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }>;
}
// BrowserRuntime:
openShell(opts?: { cwd?: string; env?: Record<string,string> }): ShellSession
```

`openShell` constructs one `Shell({ table, vfs, cwd, env })` and returns a session whose `exec` calls `shell.execute(line)`, drains stdout/stderr to strings, and reports `shell.cwd`. Because the `Shell` instance is reused, `cd` and `export` persist across commands — exactly what the terminal needs. (`BrowserRuntime.exec` stays as-is for one-shot/agent use.)

**Frontend** (`TerminalPanel`, rewritten): hold one `ShellSession` (via the Studio). Render a **prompt** `⟨workspace⟩ ⟨cwd⟩ $` (workspace = mount name or `erdou`, cwd = `session.cwd` in the accent color). Behavior:
- `cd` sticks; the prompt updates from `session.cwd` after each command.
- **Only non-zero exit codes are shown** (`exit 3`); success prints nothing extra — kills the `exit 0` spam.
- **Command history**: ↑/↓ recalls previous inputs (in-memory array + index).
- stderr is rendered in the red token; errno messages already carry the offending path.

**Tests:** a `session.test.ts` in runtime-browser — `cd /a` then `pwd`/`session.cwd` reflects `/a`; `export X=1` then `echo $X` → `1` across two `exec` calls.

---

## 6. Workstream C — Local mount: fail-fast load + live pull

**File:** `apps/web/src/lib/local-mount.ts`, `apps/web/src/lib/studio.ts`, `App.tsx`.

**(a) Surface load errors.** In `openFolder`, only swallow the picker's `AbortError` (real user-cancel); any other error from `mountFolder` is logged to the trace as an error and rethrown-to-trace, not silently dropped. `mountFolder` itself already fails fast (no try/catch) — good; we just stop the caller from hiding it.

**(b) Live pull (disk → VFS).** Add a bounded, mtime-diff watcher — no `FileSystemObserver` dependency (experimental / not broadly available):

- Track `mountMtimes: Map<vfsPath, lastModified>` — recorded when we load a file **and** when we write one back.
- A **rescan** walks the mounted dir (skipping `.git`/`node_modules`): for each file, read `file.lastModified`; if it differs from the recorded value → the file changed on disk externally → load it into the VFS and update the map. New files load; deleted-on-disk files are left in the VFS (documented non-goal).
- Recording mtimes on **write-back** is what prevents a sync war: a file the browser just wrote won't be re-pulled as an "external" change.
- Triggers: on **window `focus`** (primary — you edited on disk, tab back) **and** a modest **interval (5 s)** while mounted and the tab is visible. Both call the same idempotent `rescan()`.

This is deliberately lean (one code path, mtime compare) and non-destructive. Two-way sync retains the existing debounced `saveVfsToFolder` for VFS → disk.

**Tests:** extend `local-mount.test.ts` with the mock handle — a rescan pulls a changed file's new bytes into the mock FS; a file whose mtime we just recorded on write-back is **not** re-pulled.

---

## 7. Workstream D — Run/thread model + persistence

**File:** `apps/web/src/lib/studio.ts` (+ a small `runs-store.ts`).

Introduce the **Run** (Codex "thread") — the left sidebar is the history of these:

```ts
type RunStatus = "running" | "review" | "done" | "error";
interface Run {
  id: string;
  title: string;          // derived from the task (first line, truncated)
  task: string;
  status: RunStatus;
  trace: TraceLine[];     // the transcript for this run
  changes: FileChange[];  // see §8
  createdAt: number;
}
```

- `runs: Run[]` replaces the single `trace`. `activeRunId` selects which run the center + review show.
- **Composer → Run.** Hitting Run creates a new `Run` (`running`), makes it active, and drives `CodingAgent`; agent events append to *that run's* `trace` (not a global one).
- **Status transitions:** `running` → on `done` event: `review` if the run has changes, else `done`; on thrown error / agent error → `error`. `review` → `done` when the user opens that run's **Diff** tab (marks it reviewed).
- **Persistence:** a dedicated IndexedDB store keyed by run id (separate from the VFS snapshot store). Persist run metadata + trace + changes (before/after content of *touched files only* — bounded). Keep the most recent **20** runs; older ones drop. History survives reload.

Terminal/mount system messages that used to go into the single trace now go to a lightweight **system log** shown in the empty/first-run state and the sidebar footer, not into a specific run.

---

## 8. Workstream E — Per-run diff tracking & review pane

**File:** `apps/web/src/lib/studio.ts`, new `apps/web/src/lib/diff.ts`, `apps/web/src/components/DiffPanel.tsx`.

Codex's defining review affordance is "see what the agent changed." Data source, git-independent:

- **At run start**, capture a VFS snapshot via the existing `runtime.createSnapshot()` (in-memory; Erdou projects are small).
- **During the run**, collect the set of changed paths from `file.changed` events.
- **Before/after diff:** for each changed path, *before* = content in the start snapshot (absent → "added"), *after* = current VFS content (absent → "deleted"). Compute a line diff with a small LCS-based util in `diff.ts` (no new dependency).
- `FileChange = { path, kind: "create"|"modify"|"delete", added: number, removed: number, hunks: DiffLine[] }`.

**DiffPanel** renders the changed-file list (`+n/−m`) and, on select, the hunks with a line-number gutter and green/red tinting (per the approved mockup). **Revert** a file = restore its `before` content from the run's captured snapshot (or delete if it was created). Opening the panel flips a `review` run to `done`.

*Edge:* mount live-pull writes during an active agent run would appear in that run's change set. Rare; accepted for this round.

---

## 9. Workstream F — Approval toggle

**Files:** `packages/agent-core/src/types.ts` + `agent.ts`; `apps/web/src/lib/studio.ts`, new `components/ApprovalPrompt.tsx`.

**agent-core** gains an optional gate — generic, no UI:

```ts
// types.ts
interface ApprovalRequest { tool: string; command?: string; args: Record<string, unknown>; }
type ApprovalDecision = "allow" | "deny";
interface AgentOptions { /* … */ approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>; }
```

In `agent.ts:runTool`, before executing a **command-like** tool (`run_shell`, `remove_path`), if `opts.approve` is set, await it. On `"deny"`, skip execution and return `{ ok:false, output:"Denied by the user." }` so the model observes it and adapts. Non-command tools (`write_file`, `make_dir`, `read_file`, `list_dir`) are never gated (Codex "Auto-edit" semantics: auto-apply edits, confirm commands).

**apps/web** owns the mode:
- `approvalMode: "auto" | "confirm"` (persisted with the model config; default `"auto"`), surfaced as the composer's **Auto ▾ / Confirm** selector and in Settings.
- In `auto`, Studio passes no `approve` callback. In `confirm`, it passes one that emits an `ApprovalPrompt` into the active run's transcript and returns a Promise resolved by the user's Allow/Deny click. "Always allow" (session-scoped) sets a flag so that tool stops prompting for the rest of the run.

**Tests:** an agent-core test with a stub gateway that emits a `run_shell` call — with `approve: async () => "deny"`, the shell tool does not run and the tool result says denied; with `"allow"`, it runs.

---

## 10. Workstream G — Codex-desktop shell UI

**File:** `apps/web/src/App.tsx` (rewritten) + new/rewritten components; `styles.css` replaced.

### 10.1 Layout (B)

```
┌ title bar: Er·dou — ⟨workspace⟩          runtime·chip  model  theme  ⌘K ┐
├──────────────┬───────────────────────────────┬────────────────────────┤
│ TASK SIDEBAR │        CONVERSATION           │      REVIEW PANE        │
│ + New task   │  thread head + status         │  [Diff·Files·Terminal·  │
│ Tasks  ⇅     │  transcript:                  │   Preview]              │
│ • run (run)  │   you → thinking → tool call  │  diff hunks / file tree │
│ • run (rev)  │   → approval (confirm mode)   │  / persistent terminal  │
│ • run (done) │  ────────────────────────     │  / SW preview           │
│ • run (err)  │  composer  [Auto▾] [Run⏎]     │                         │
│ ─footer─     │                               │                         │
│ 📁 mount ·●  │                               │                         │
└──────────────┴───────────────────────────────┴────────────────────────┘
```

Resizable center|review split; sidebar fixed ~238px.

### 10.2 Component inventory

| Component | Status | Purpose |
|---|---|---|
| `TitleBar` | new | wordmark, workspace, runtime/model chips, theme toggle, settings |
| `TaskSidebar` | new | New-task button, run list w/ status chips, mount + runtime footer |
| `Conversation` | rewrite of `TraceTape` | thread head + transcript (you / thinking / tool-call / result / done) |
| `Composer` | new | textarea, `@files` affordance, `Auto▾ / Confirm` mode selector, Run |
| `ApprovalPrompt` | new | inline Allow / Always / Deny (confirm mode) |
| `ReviewPane` | new | tab host: Diff · Files · Terminal · Preview (+ Processes, de-emphasized) |
| `DiffPanel` | new | per-run changed files + hunks + revert (§8) |
| `FilePanel` | restyle | Files tab: tree + viewer |
| `TerminalPanel` | rewrite | persistent session, prompt, history, no exit-0 spam (§5) |
| `PreviewPanel` | restyle | Preview tab (SW preview, live toggle) |
| `ProcessPanel` | restyle | Processes (secondary tab) |
| `SettingsDialog` | extend | model + theme + approval mode |

`@files` in the composer is a light affordance this round (inserts a path from a picker); full fuzzy `@`/`$` popovers are a nice-to-have, not required.

### 10.3 Design tokens (`styles.css`)

CSS custom properties, dark default + light via `:root[data-theme="light"]` and `prefers-color-scheme`:

```
Dark:  --bg #0d0d0d  --panel #141414  --side #0f0f0f  --elev #1c1c1c
       --border rgba(255,255,255,.08)  --ink #ededed  --muted #8b8b8b  --faint #5c5c5c
       --accent #58a6ff  --green #3fb950  --red #f85149  --purple #c695c6  --amber #d29922
Light: --bg #ffffff  --panel #f7f7f8  --side #f2f2f3  --elev #ffffff
       --border #e5e5e5  --ink #0d0d0d  --muted #6e6e80  --faint #9a9aa5  (accent/diff shared)
Type:  --sans: -apple-system,"Segoe UI",Roboto,sans-serif   (Söhne-ish system stack)
       --mono: ui-monospace,"SF Mono",Menlo,Consolas,monospace
Radius: 6–11px · borders over shadows · body 13px / code 12px / meta 11px
```

Theme persists in `localStorage`. One accent, two typefaces (an explicit OpenAI tenet).

---

## 11. Testing strategy

- **Kernel (A, B):** Vitest in `runtime-browser` — the `mv` cases (§4), the `ShellSession` cwd/env persistence (§5). Node-runnable, no browser.
- **Agent (F):** Vitest in `agent-core` with a stub gateway — allow vs deny gating (§9).
- **Mount (C):** extend `local-mount.test.ts` with the mock handle — external-change pull + no-resync-war (§6).
- **Diff (E):** unit-test `diff.ts` (LCS line diff) directly.
- **End-to-end (verify skill / headless Chromium):** the terminal reproduction — `cd`/`mv` now behave; mount a mock folder and see files; run a task and review its diff. Keep the existing live-model e2e green.
- Keep `pnpm lint:deps` (dependency-cruiser) passing — no new cross-layer edges.

## 12. Risks & open questions

- **Run persistence size** — capping at 20 runs and storing only touched-file before/after bounds it. If it still grows, drop `before/after` for runs older than N and show metadata-only.
- **Snapshot-per-run cost** — fine for small projects; if large mounts make it heavy, switch to lazy first-touch capture. Not optimizing pre-emptively (YAGNI).
- **Live-pull interval churn** — 5 s + focus is conservative; mtime compare makes rescans cheap and no-op when nothing changed.
- **"review" status UX** — kept minimal (opening the diff marks reviewed). Revisit if it feels noisy.

## 13. Rollout / sequencing

1. **A** `mv` fix (+ tests) — isolated kernel win, unblocks the terminal complaint immediately.
2. **B** `ShellSession` (+ tests) — backend for the new terminal.
3. **G-scaffold** the new App shell / layout / tokens (static), then port panels in.
4. **D** run model → **E** diff tracking → wire Conversation + DiffPanel.
5. **C** mount fixes.
6. **F** approval toggle (agent-core + UI), default Auto.
7. **verify** end-to-end; keep all Vitest + `lint:deps` green.

Each step ships behind the same app; nothing here touches the runtime contract or the layering invariant.
