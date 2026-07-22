# Round 34 — Skill plugins + prepared document-editing environments

**Status:** design approved 2026-07-22. Built via superpowers brainstorming → writing-plans → implementation.

## 1. Problem & intent

Two user asks, one round:

1. **"Pyodide pip doesn't seem to work."** Diagnosed (not a bug in the happy path): browser `pip install` *does* work online within a session — bare names go to Pyodide `loadPackage` (prebuilt binary wheels incl. NumPy/Pandas/lxml/Pillow), the rest to `micropip` (pure-Python PyPI wheels). The friction is real but is about **persistence, discoverability, and docs**:
   - Installs are **session-only** — gone on page reload; only a name-manifest survives in `localStorage` as a *hint* (no auto-reinstall). This is the #1 "it didn't work" cause.
   - `pip list` reads only `pyodide.loadedPackages`, so a `micropip`-installed pure-Python package may `import` fine yet not appear in `pip list` → reads as failure.
   - Only `install`/`list` subcommands; any `-flag` (`-r`, `--upgrade`, `-e`) is rejected before any network call.
   - The agent brief **understates** browser pip as "pure-Python wheels only" (`prompt.ts:175`, `environments.ts:74`), hiding the `loadPackage` path → the agent needlessly flees to the slow `vm:sci` for NumPy and may wrongly believe `python-docx`/`lxml` can't be installed on the browser kernel.

2. **"Implement a skill-plugin feature; have PPT/Word editing environments prepared in advance."** A lightweight, Claude-Skills-style mechanism (progressive disclosure) seeded with built-in document skills, with the editing libraries **pre-prepared** so the agent doesn't hand-install them each time.

## 2. Decisions (locked with the user)

- **Skill shape:** a lightweight skill mechanism + built-in document skill content. Not a marketplace/distribution framework (explicit non-goal — see `roadmap.md:33`).
- **Execution home:** the **browser kernel (Pyodide)**. python-pptx / python-docx / openpyxl / fpdf2 are all pure-Python and Pyodide-compatible; no VM `docs` profile.
- **"Prepared" = pre-bundled wheels.** Ship the pure-Python wheels with Erdou; the browser `pip` resolves them **locally first** (offline, version-locked), falling back to `loadPackage`/`micropip` online.
- **Storage + activation = file-based, reusing `read_file` + `pip`.** Skills are directories the agent reads; no new `use_skill` tool.
- **Location correction:** skills live at **VFS `/.skills/<name>/`**, NOT `.erdou/skills/`. `.erdou/` is written straight to the mounted-folder handle and is in the mount SKIP + zip-exclusion sets (`folder-state.ts`, `local-mount.ts:24`, `project-zip.ts:19`) — it is **not in the Runtime VFS**, so `read_file` cannot see it. `/.skills/` is a normal VFS dir: agent-readable, syncs to a mounted folder (drop-a-folder = new skill), seeded like `ERDOU.md`.

## 3. Architecture (respects the layering invariant)

Agent depends on Runtime; Runtime never on Agent. All new agent-facing content flows **from the app** through existing data channels; `agent-core` only renders framing, `lang-python` stays Pyodide/storage-agnostic.

```
apps/web (owns content + wiring)
  public/wheels/*.whl + wheels.json (manifest)   ── downloaded by scripts/download-wheels.mjs (gitignored binaries)
  src/lib/skills/**                              ── built-in skill source (SKILL.md + examples), bundled via import.meta.glob
  src/lib/kernel.ts / languages.ts               ── inject a localWheels resolver into the pip loader hook
  src/lib/studio.ts                              ── seedSkills() into /.skills/ ; scan /.skills/ → environment.skills
      │ AgentOptions.environment.skills (data)         │ pip loader hook: localWheels (data)
      ▼                                                ▼
packages/agent-core/prompt.ts                    packages/lang-python/python.ts
  render SKILLS section (framing only)             pip: resolve local wheel index first, else loadPackage/micropip
```

### Component A — Local wheel index in `pip`
- `packages/lang-python`: the pip executor gains an optional injected resolver `localWheels(name) → string[] | null` (URLs of the pure-Python closure for a bundled top package). It rides on the loader object, exactly like the existing `pipInstalls` hook, so `lang-python` keeps no app dependency.
- pip algorithm becomes: for each requested requirement, if `localWheels(name)` returns URLs → `micropip.install([...urls])` (one call installs the whole local pure-Python closure offline; native deps like `lxml`/`Pillow` are resolved by micropip from the Pyodide lockfile). Else fall back to the existing `loadPackage`→`micropip` path. Unchanged: only `install`/`list`, `-flag` rejection, session-only notice.
- `apps/web`: `wheels.json` maps each top package → its bundled pure-Python wheel closure (files + versions); `download-wheels.mjs` (mirrors `download-assets.mjs`) fetches+verifies (sha256) the wheels into `public/wheels/` (gitignored). The app builds the `localWheels` resolver from the manifest and injects it. Native deps (`lxml`, `Pillow`) are intentionally NOT bundled in round 1 — they load from the Pyodide CDN on first use (documented caveat; total-offline self-hosting deferred).

### Component B — Skill store + seeding
- A skill = a directory: `SKILL.md` with YAML frontmatter (`name`, `description`, optional `wheels:`), then the how-to body; optional `examples/`.
- Built-in skills are bundled from `apps/web/src/lib/skills/**` (via `import.meta.glob`, eager, as raw strings). `Studio.seedSkills()` (sibling to `seedEnvNotes()`) writes any missing built-in skill into `/.skills/<name>/…` at run start, **never overwriting**, **before the run snapshot** (so seeds are not attributed to the agent as diffs).

### Component C — Discovery + progressive disclosure
- `agent-core`: extend the environment channel with `skills?: readonly SkillBrief[]` (`{ name, description, path }`), same pattern as the environments catalog. `prompt.ts` renders a **SKILLS** section: one line per skill — `name — description → read <path> to use it`. Bodies are never inlined. Returns "" when no skills supplied (old callers unaffected).
- `apps/web`: `studio.ts` scans `/.skills/*/SKILL.md`, parses frontmatter (`name`, `description`), builds `SkillBrief[]`, and passes it on `AgentOptions.environment.skills`. A malformed/missing frontmatter skill is skipped with a system-log line (fail-loud, per dev principles — no silent guess).

### Component D — Built-in document skills (round-1 content)
Four skills, each `SKILL.md` = *when to use* + *install line* (`pip install <lib>`, hits the local wheel index) + a minimal example that writes a real file into `/`:
- `pptx` → python-pptx
- `docx` → python-docx
- `xlsx` → openpyxl
- `pdf` → fpdf2 (pure-Python; chosen over reportlab, which ships a C accelerator)

### Component E — Correct the pip/NumPy brief (in-scope)
- `prompt.ts:175`: browser pip = "Pyodide prebuilt wheels (incl. NumPy/Pandas/SciPy/lxml/Pillow) via `loadPackage` + pure-Python PyPI wheels via micropip; session-only, resets on reload."
- `environments.ts:74`: same correction to the browser install recipe; update the "pure-Python wheels from PyPI only" phrasing.
- `environments.ts` browser `switchGuidance` / the catalog line so NumPy/Pandas are presented as **native to the browser kernel** (fast), with `vm:sci` as the slow compat fallback — reverse the current mis-steer.
- Add one SKILLS line to `ERDOU_ABOUT` and a short bullet to `ERDOU_MD_TEMPLATE` (keep the env self-image single-source-of-truth in sync).

## 4. Data flow — an agent using the `pptx` skill

1. Run starts → `seedSkills()` ensures `/.skills/pptx/SKILL.md` exists; `studio.ts` scans `/.skills/` and passes `skills:[{name:'pptx',…}]`.
2. `prompt.ts` SKILLS section tells the agent `pptx` exists and where its SKILL.md is.
3. User asks for a slide deck → agent `read_file /.skills/pptx/SKILL.md`.
4. SKILL.md says `pip install python-pptx` → browser pip hits the **local wheel closure** (offline) + pulls `lxml`/`Pillow` from Pyodide → installs.
5. Agent writes a Python script per the example, runs `python deck.py` → a real `.pptx` lands in `/`, previewable/downloadable.

## 5. Testing

- **Unit (`vitest run`, hermetic):**
  - `lang-python`: pip resolves a local-wheel package via the injected resolver (mock micropip receives the local URLs); falls back to loadPackage/micropip when not bundled; the resolver is optional (absent → old behavior).
  - `agent-core`: SKILLS section renders name+desc+path; empty when no skills; frontmatter parsing (name/description extraction; malformed skipped).
  - `apps/web`: `seedSkills` writes missing skills / never overwrites / seeds before snapshot; skill scan → `SkillBrief[]`; `download-wheels` manifest shape (node --test or vitest, no network in CI).
- **Headless-Chromium smoke (gated, real Pyodide):** in the browser kernel, `pip install openpyxl` (fully offline pure-Python closure) then a script generates a real `.xlsx` under `/` — proves the local-wheel path end to end without the CDN. (openpyxl chosen because it has **no** native dep, isolating the local-wheel mechanism.)
- Existing suite (typecheck, `lint:deps`, build) stays green.

## 6. Non-goals (YAGNI)

Marketplace / discovery / third-party distribution; a `use_skill` tool; a VM `docs` profile; persisting browser installs across reload; self-hosting the full Pyodide dist for total offline (a clean, separately-scoped follow-up that would also kill the CDN/adblocker failure mode); bundling `lxml`/`Pillow` wasm wheels locally.

## 7. Rollout / deploy note

Wheels are gitignored (like VM assets). A fresh clone runs `pnpm --filter @erdou/web wheels` (→ `download-wheels.mjs`) before build/deploy; `wheels.json` pins url+sha256+version so the fetch is reproducible. The download script is idempotent and fails loudly on hash mismatch (mirrors `ensure-asset.mjs`).
