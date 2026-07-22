# Round 34 — Skill plugins + prepared document environments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight, file-based skill mechanism (progressive disclosure) seeded with built-in document skills (pptx/docx/xlsx/pdf), backed by pre-bundled Pyodide-compatible wheels the browser `pip` resolves locally, and correct the agent's understated pip/NumPy brief.

**Architecture:** All new agent-facing content originates in `apps/web` and flows through existing data channels — `agent-core` renders framing only (a SKILLS prompt section), `lang-python`'s pip gains an injected local-wheel resolver (rides on the loader like `pipInstalls`). Skills are VFS directories under `/.skills/` the agent reads with `read_file`; installs use the normal `pip`, now backed by a local wheel index.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Pyodide 0.26.4 + micropip, Vite (`import.meta.glob`), Node ≥22 (download script).

## Global Constraints

- Layering invariant (CI-enforced by `pnpm lint:deps`): Agent→Runtime only; `lang-python`/`agent-core` NEVER import from `apps/web`. New data crosses via `PipPyodideLoader` (function-attached hooks) and `AgentOptions.environment`.
- Dev principles: no over-engineering, minimize fallbacks, fail-fast with detailed errors (skip a malformed skill with a logged reason; never silently guess).
- Skills live at VFS `/.skills/<name>/` — NOT `.erdou/skills/` (that dir is not in the VFS; `read_file` can't see it).
- Wheels are gitignored (like VM assets); `wheels.json` pins version+url+sha256; the download script verifies sha256 and fails loud on mismatch.
- Pyodide is `0.26.4`; native deps `lxml`/`Pillow` are provided by Pyodide's lockfile (NOT bundled). Bundle only pure-Python `*none-any.whl`.
- Keep the env self-image single source of truth in sync (`ERDOU_ABOUT`, `ERDOU_MD_TEMPLATE`, `prompt.ts` briefs, `environments.ts`).

---

## Pinned wheel data (used by Task 3)

Pure-Python wheels to bundle + per-top-package closures. Native deps (`lxml`,`Pillow`) resolve from Pyodide.

| top package | closure (bundled) |
|---|---|
| python-pptx | python-pptx, XlsxWriter, typing_extensions |
| python-docx | python-docx, typing_extensions |
| openpyxl | openpyxl, et_xmlfile |
| fpdf2 | fpdf2, defusedxml, fonttools |

Wheel pins (name → version, file, sha256): stored in `apps/web/wheels.json` (full url+sha256 in scratchpad `wheels-manifest.json`; copy verbatim). Versions: python-pptx 1.0.2, python-docx 1.2.0, openpyxl 3.1.5, fpdf2 2.8.4, XlsxWriter 3.2.9, typing_extensions 4.16.0, et_xmlfile 2.0.0, defusedxml 0.7.1, fonttools 4.60.2.

---

## Task 1 — agent-core: SKILLS prompt section + pip/NumPy brief fix

**Files:**
- Modify: `packages/agent-core/src/prompt.ts`
- Test: `packages/agent-core/src/prompt.test.ts`

**Interfaces:**
- Produces: `interface SkillBrief { readonly name: string; readonly description: string; readonly path: string }`; `EnvironmentInfo.skills?: readonly SkillBrief[]` (declared via the same `declare module "./types.js"` augmentation the catalog uses); `buildSystemPrompt` renders a SKILLS section when `env.skills?.length`.

- [ ] **Step 1 (test):** In `prompt.test.ts`, add tests: (a) with `env.skills=[{name:'pptx',description:'Create/edit PowerPoint decks',path:'/.skills/pptx/SKILL.md'}]`, `buildSystemPrompt` output contains `SKILLS`, `pptx — Create/edit PowerPoint decks`, and `/.skills/pptx/SKILL.md`; (b) no `skills` → output contains no `SKILLS` header; (c) the browser (simulated) prompt's pip line mentions `loadPackage`/`NumPy` and does NOT say "pure-Python PyPI wheels" as the only source.
- [ ] **Step 2:** Run `pnpm --filter @erdou/agent-core test` → the new assertions FAIL.
- [ ] **Step 3 (impl):**
  - Add `SkillBrief` interface + `skills?` to the `declare module "./types.js"` block.
  - Add `skillsSection(env)` returning `""` when empty, else a block:
    ```
    SKILLS (task playbooks — read the file before doing that kind of task)
    - <name> — <description> → read <path>
    ```
    Prepend a lead line: `- Erdou ships skills: focused how-to guides for specific tasks (e.g. making a .pptx). When a task matches one, read its SKILL.md FIRST and follow it.`
  - Call `skillsSection(env)` in BOTH `simulatedPrompt` and `realOsPrompt`, placed right after `environmentsCatalogSection(env)`.
  - Fix `prompt.ts:175` pip line to: `"System/OS package managers (apt, yum, brew, apk) — but \`pip install\` works: Pyodide prebuilt wheels incl. C-extension packages (NumPy, Pandas, SciPy, lxml, Pillow) via loadPackage, plus pure-Python PyPI wheels via micropip. Online only; installs are session-only and reset on reload."`
- [ ] **Step 4:** Run `pnpm --filter @erdou/agent-core test` → PASS. Run `pnpm --filter @erdou/agent-core typecheck`.
- [ ] **Step 5:** Add one line to `ERDOU_ABOUT`: `"- Erdou ships SKILLS — task playbooks under /.skills/<name>/SKILL.md. When your task matches one, read that file first and follow it."` and a bullet to `ERDOU_MD_TEMPLATE`'s Network/where-it-lives area noting NumPy/Pandas run natively in the browser kernel via pip. Update `prompt.test.ts` if it asserts ERDOU_ABOUT length.
- [ ] **Step 6:** Commit: `feat(agent-core): SKILLS prompt section + accurate browser-pip brief (R34)`

---

## Task 2 — lang-python: local-wheel resolver in `pip`

**Files:**
- Modify: `packages/lang-python/src/python.ts`
- Test: `packages/lang-python/src/python.test.ts`

**Interfaces:**
- Produces: `export type LocalWheelResolver = (requirement: string) => readonly string[] | null;` and `PipPyodideLoader` gains optional `localWheels?: LocalWheelResolver`. Resolver returns the ordered list of wheel URLs (the pure-Python closure) for a bundled top package, or `null` if not bundled.

- [ ] **Step 1 (test):** In `python.test.ts`, extend the MockPyodide/micropip so `micropip.install` records the argument. Add tests:
  - (a) `load.localWheels = (r) => r === 'python-pptx' ? ['/wheels/python_pptx.whl','/wheels/xlsxwriter.whl','/wheels/typing_extensions.whl'] : null;` then `pip install python-pptx` → micropip.install received exactly that URL array (one call), exit 0, stdout `Successfully installed python-pptx`, and `loadPackage` was NOT called with `python-pptx` as a plain name.
  - (b) mixed: `pip install python-pptx requests` with resolver bundling only python-pptx → micropip.install called with the wheel URLs AND (separately) `requests` routed through the existing plain/micropip path.
  - (c) no resolver (`localWheels` undefined) → behavior byte-identical to today (existing tests still green).
  - (d) a bundled install whose micropip.install rejects → `pip: failed to install ...` exit 1.
- [ ] **Step 2:** Run `pnpm --filter @erdou/lang-python test` → new tests FAIL.
- [ ] **Step 3 (impl):** In `createPythonRunners`, read `opts.load.localWheels`. In `pipExecutor` (install branch), before the existing loadPackage/micropip block:
  - Partition `pkgs` into `bundled = pkgs.filter(p => resolver?.(p) != null)` and `external = pkgs.filter(p => resolver?.(p) == null)`.
  - If `bundled.length`: ensure micropip is loaded (reuse the existing `loadPackage("micropip")` + guard), build `const urls = [...new Set(bundled.flatMap(p => resolver!(p)!))]`, then `await micropip.install(urls_as_pylist)` in a try/catch that reports `pip: failed to install '<bundled join>': <msg>` on failure (exit 1). (Pass a JS array; the existing single-string `install` call is generalized — accept `string | string[]`.)
  - Replace the subsequent `plain`/`missing` computation to operate on `external` only.
  - Keep `preloaded`/`fresh`/notice reporting keyed on `pkgs` (bundled names count as fresh since they are not in `loadedPackages`).
  - `micropip.destroy()` in `finally` still runs once.
- [ ] **Step 4:** Run `pnpm --filter @erdou/lang-python test` → PASS. `pnpm --filter @erdou/lang-python typecheck`.
- [ ] **Step 5:** Commit: `feat(lang-python): pip resolves a local wheel index before loadPackage/micropip (R34)`

---

## Task 3 — apps/web: wheel manifest, download script, local-wheel wiring

**Files:**
- Create: `apps/web/wheels.json` (pins; copy scratchpad `wheels-manifest.json` with full url+sha256)
- Create: `apps/web/scripts/download-wheels.mjs`
- Create: `apps/web/src/lib/wheel-index.ts`
- Create: `apps/web/src/lib/wheel-index.test.ts`
- Modify: `apps/web/src/lib/kernel.ts` (attach `load.localWheels` in `appPyodideLoader`)
- Modify: `apps/web/package.json` (`"wheels"` script + `prebuild`/`predev` hook)
- Modify: `.gitignore` (`apps/web/public/wheels/`)

**Interfaces:**
- Consumes: `LocalWheelResolver` (Task 2).
- Produces: `export function buildLocalWheelResolver(manifest: WheelManifest, origin: string): LocalWheelResolver` — normalizes the requested requirement (strip version specifier, lowercase, `_`→`-`), looks up a closure, maps each closure member to an absolute `${origin}/wheels/<file>` URL. `export function normalizeReq(req: string): string`.

- [ ] **Step 1:** Write `apps/web/wheels.json` verbatim from scratchpad `wheels-manifest.json` (adds `pyodideProvided`, `closures`, `wheels{version,file,url,sha256}`).
- [ ] **Step 2 (test):** `wheel-index.test.ts`: `normalizeReq('python-pptx==1.0.2') === 'python-pptx'`, `normalizeReq('Python_PPTX') === 'python-pptx'`; `buildLocalWheelResolver(manifest,'https://x')('python-pptx')` returns `['https://x/wheels/python_pptx-1.0.2-py3-none-any.whl','https://x/wheels/xlsxwriter-3.2.9-py2.py3-none-any.whl'?...]` (the closure files) ; returns `null` for `'requests'`.
- [ ] **Step 3:** Run `pnpm --filter @erdou/web test wheel-index` → FAIL.
- [ ] **Step 4 (impl `wheel-index.ts`):** types `WheelManifest`; `normalizeReq` (regex split on `[=<>!~ ]`, lowercase, `_`→`-`); `buildLocalWheelResolver` returns a function: normalize → `closures[key]` (also allow a bundled leaf itself as a key) → map each member (normalize) → its wheel `file` → `${origin}/wheels/${file}`; `null` if not found. Fail-fast: a closure member with no matching wheel entry throws (manifest integrity).
- [ ] **Step 5:** Run test → PASS.
- [ ] **Step 6 (download script):** `download-wheels.mjs` mirrors `packages/runtime-vm/scripts/download-assets.mjs`: read `wheels.json`, for each wheel ensure `public/wheels/<file>` exists + sha256 matches (present→verify, missing→download from `url` to temp, verify, atomic rename; mismatch→delete temp, throw with both hashes). Idempotent. Use `node:crypto`, `node:fs`, `fetch`.
- [ ] **Step 7 (wire):** In `kernel.ts` `appPyodideLoader`, after `load.pipInstalls`, add (guarded by `typeof location !== "undefined"`): `load.localWheels = buildLocalWheelResolver(wheelsManifest, location.origin)` importing `wheels.json` (`import wheelsManifest from "../../wheels.json"`) + `buildLocalWheelResolver` from `./wheel-index.js`.
- [ ] **Step 8 (scripts):** `package.json`: `"wheels": "node scripts/download-wheels.mjs"`, and add to existing `predev`/`prebuild` (they already run `render-help.mjs`) → chain `&& node scripts/download-wheels.mjs`. `.gitignore`: add `apps/web/public/wheels/`.
- [ ] **Step 9:** Run `pnpm --filter @erdou/web wheels` → downloads 9 wheels, verifies. Run `pnpm --filter @erdou/web test` + `typecheck`.
- [ ] **Step 10:** Commit: `feat(web): pinned local wheel index + download script, wired into browser pip (R34)`

---

## Task 4 — apps/web: built-in skills, discovery, seeding, env wiring

**Files:**
- Create: `apps/web/src/lib/skills/pptx/SKILL.md`, `docx/SKILL.md`, `xlsx/SKILL.md`, `pdf/SKILL.md` (+ optional `examples/*.py`)
- Create: `apps/web/src/lib/skills.ts` (built-in bundle via glob, frontmatter parse, seed list, VFS scan)
- Create: `apps/web/src/lib/skills.test.ts`
- Modify: `apps/web/src/lib/studio.ts` (`seedSkills()`, scan → `environment.skills`)
- Modify: `apps/web/src/lib/environments.ts` (browser recipe/switchGuidance pip fix — Component E)

**Interfaces:**
- Consumes: `SkillBrief` (Task 1, duck-typed — no cross import needed; build a structurally-matching object).
- Produces: `export interface BuiltinSkill { name: string; files: Record<string,string> }` (relative path → content); `export const BUILTIN_SKILLS: BuiltinSkill[]` (from `import.meta.glob('./skills/**/*',{eager,as:'raw'})`); `export function parseFrontmatter(md: string): { name?: string; description?: string }`; `export function scanSkills(fs: FileSystemApi): SkillBrief[]` (reads `/.skills/*/SKILL.md`, parses frontmatter, skips + returns diagnostics for malformed).

- [ ] **Step 1 (content):** Write the 4 `SKILL.md` files. Each: YAML frontmatter `name:` + `description:`, then body = *When to use*, *Setup* (`pip install <lib>` — note it hits the local bundle, offline), *Minimal example* (a Python snippet writing a real file to `/out.<ext>`), *Tips*. Libs: pptx→python-pptx, docx→python-docx, xlsx→openpyxl, pdf→fpdf2. Keep each ≤~60 lines.
- [ ] **Step 2 (test):** `skills.test.ts`: `parseFrontmatter('---\nname: pptx\ndescription: d\n---\nbody')` → `{name:'pptx',description:'d'}`; `BUILTIN_SKILLS` has 4 entries each with a `SKILL.md`; `scanSkills(fakeFs)` where fs has `/.skills/pptx/SKILL.md` → one `SkillBrief{name:'pptx',path:'/.skills/pptx/SKILL.md'}`; a `/.skills/broken/SKILL.md` without frontmatter → skipped (not in result). Use a small in-memory `FileSystemApi` fake (mirror existing app test fakes).
- [ ] **Step 3:** Run `pnpm --filter @erdou/web test skills` → FAIL.
- [ ] **Step 4 (impl `skills.ts`):** glob-load `BUILTIN_SKILLS` (group files by top dir under `skills/`); `parseFrontmatter` (simple `---`-fenced `key: value` lines, no YAML lib); `scanSkills` walks `/.skills/*/SKILL.md` via `fs.readdir`/`fs.readFile`, parses, builds `SkillBrief`; malformed (no name/description) skipped and collected into a returned diagnostics list (or a second return) so the caller can log — fail-loud, not silent.
- [ ] **Step 5:** Run test → PASS.
- [ ] **Step 6 (seed):** In `studio.ts`, add `seedSkills()` beside `seedEnvNotes()`: for each `BUILTIN_SKILLS` file, if `/.skills/<name>/<relpath>` is absent, `this.fs.writeFile` it (mkdir parents); never overwrite. Call `seedSkills()` at the SAME point `seedEnvNotes()` is called (before the run snapshot), and bump `fsVersion` if anything was written.
- [ ] **Step 7 (wire):** In `studio.ts` where `AgentOptions.environment` is built (the object with `catalog`), add `skills: scanSkills(this.fs)` (structurally a `SkillBrief[]`). Log any scan diagnostics via `this.logSystem`.
- [ ] **Step 8 (Component E — environments.ts):** Fix the browser descriptor: `installRecipes` line → `"pip install <package> — Pyodide prebuilt wheels (NumPy/Pandas/SciPy/lxml/Pillow…) + pure-Python PyPI wheels; document libs (python-pptx/python-docx/openpyxl/fpdf2) are pre-bundled and install offline; session-only (reset on reload)."`; `switchGuidance` → note NumPy/Pandas run natively here (fast) and `vm:sci` is the slow persistent fallback. Update the `sci` `switchGuidance` to say "for persistent installs or when a package is missing from Pyodide" (stop implying the browser can't do NumPy). Adjust any `environments.test.ts` snapshot/assertion.
- [ ] **Step 9:** Run `pnpm --filter @erdou/web test` + `typecheck`.
- [ ] **Step 10:** Commit: `feat(web): built-in document skills + /.skills discovery/seeding + env-text fix (R34)`

---

## Task 5 — Verification (unit + e2e)

**Files:** Modify a browser-e2e harness under `scripts/browser-e2e/` (follow the existing gated pattern).

- [ ] **Step 1:** `pnpm test` (full), `pnpm typecheck`, `pnpm lint:deps`, `pnpm build` — all green. `lint:deps` MUST still pass (no apps/web import leaked into agent-core/lang-python).
- [ ] **Step 2 (e2e, gated):** Add a headless-Chromium scenario: browser kernel, run `pip install openpyxl` (fully offline pure-Python closure — no native dep), then `python` a script that builds a workbook and writes `/out.xlsx`; assert exit 0 and `/out.xlsx` exists + non-empty. Requires `pnpm --filter @erdou/web wheels` first + the dev server serving `/wheels/`. Gate behind an env flag like the existing `ERDOU_*_E2E` scenarios.
- [ ] **Step 3:** Run the e2e; record PASS/FAIL honestly.
- [ ] **Step 4:** Commit: `test(web): headless e2e — offline pip install openpyxl → generate xlsx (R34)`

---

## Task 6 — Adversarial review + fixes

- [ ] **Step 1:** Dispatch parallel reviewers (correctness, layering/CI, security/CSP for wheel URLs + micropip, prompt-truth, test-bite) over the branch diff. Verify each finding adversarially before acting.
- [ ] **Step 2:** Fix confirmed findings; re-run Task 5 Step 1.
- [ ] **Step 3:** Final commit; update memory (`erdou-project.md`) with the Round-34 summary.

---

## Self-review (spec coverage)

- Spec §2 execution home (browser + wheels) → Task 3. Storage `/.skills/` → Task 4. Activation via read_file+pip → Tasks 1/4. Component A → Tasks 2/3. Component B → Task 4 (seed). Component C → Tasks 1 (render) + 4 (scan/wire). Component D → Task 4 (content). Component E → Task 1 (prompt) + Task 4 (environments.ts). Testing §5 → Task 5. All covered.
