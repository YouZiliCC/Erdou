# Round 13 — Environments & Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-image VM profiles (base/node/sci) with real `pip install`/`npm install` through the v86 fetch-NAT, agent mid-run `switch_environment`, micropip on the browser kernel, and single-source-of-truth docs (agent brief v2 + help.html).

**Architecture:** Spec `docs/superpowers/specs/2026-07-17-round13-environments-design.md` (spike-verified). Every task has a spike dossier under `SCRATCH/r13-spikes/` (SCRATCH = `/tmp/claude-1018/-home-yzl-Erdou/47b8800b-6d93-4ada-bcbd-c3bb5b308f5f/scratchpad`) with file:line evidence, verified commands, and working prototype code — implementers MUST read their dossier(s) first. Base: branch `feat/round13-egress-gateway` @ 1467326.

**Tech Stack:** pnpm 11 / Node 22 / Vitest / strict TS / React 18 / v86 0.5.424 / Alpine 3.24.1 x86 / Pyodide 0.26.4 (CDN).

## Global Constraints

- Strict layering (`pnpm lint:deps`): runtime NEVER depends on agent; agent-core never imports apps/web (catalog data flows in via AgentOptions).
- Default `pnpm test` hermetic. Gates: `ERDOU_VM_E2E` (offline VM), NEW `ERDOU_NET_E2E` (real registries; Node-legged — sandbox Chromium has no egress).
- Dev principles: no over-engineering, fail-fast with detailed errors, few fallbacks.
- Baseline: hermetic 397 pass / 36 skip; gated conformance 32/32 (base image alpine-3.24.1-r12-lo-baked, MUST stay green throughout — real R13 bakes happen ONLY in T10).
- Implementer agents do NOT git commit / run repo-wide gates / run gated suites (controller does, serialized). Plain `rm` not `git rm`. Reports to `SCRATCH/r13-impl/<task>-report.md`, returns <20 lines.
- v86 barrel import in apps/web main bundle is FORBIDDEN (drags 700KB — kernel.ts:10-18 documents; profiles come via the new `/profiles` subpath).

## Execution model

- **Wave 1** (6 parallel lanes, disjoint files): T1 profiles/assets infra · T2 pypi egress shim · T3 bake pipeline multi-profile · T4 micropip pip command · T5 catalog + help pipeline · T6 agent-side plumbing (agent-core/agent-tools only).
- **Wave 2** (2 lanes): L-studio sequential T7→T8 (only lane touching studio.ts/kernel.ts/vm-kernel.ts/KernelToggle.tsx) ∥ T9 (prompt v2 + capabilities; agent-core + runtime-vm only).
- **Wave 3** (single agent sequential): T10 real bakes ×3 + gated smokes → T11 ERDOU_NET_E2E suite + switch e2e → T12 docs/final gates.
- Then: final whole-branch adversarial review (4 lenses + skeptic voting) → fix wave → push.

---

### T1: profiles + multi-profile assets (runtime-vm + apps/web glue)

**Dossier:** `SCRATCH/r13-spikes/S6-assets-plumbing.md` (complete refactor map with file:line)

**Files:** Create `packages/runtime-vm/src/profiles.ts` (+ subpath export in package.json/tsup: `@erdou/runtime-vm/profiles`, browser-clean). Modify: `packages/runtime-vm/src/assets.ts` (`defaultAssets(profile = "base")` → `state-<profile>.zst` naming; meta `profile` field check), `browser-assets.ts` (cache key `state:<profile>:<version>`; evict ONLY same-profile lineage — today's `startsWith("state:")` eviction at ~:76 nukes siblings, confirmed bug; one-time legacy 2-part-key sweep; `expectedStateVersion` check gains profile), `browser-entry.ts`, `apps/web/scripts/link-vm-assets.mjs` (serve every present `state-<p>.zst`/meta pair), `apps/web/src/lib/vm-assets.ts` (per-profile version map `alpine-3.24.1-r13-<p>` + expectedStateVersion threading) + tests (vm-assets.test.ts, browser-assets.test.ts, new profiles.test.ts).

**Interfaces (produces):** `type VmProfile = "base" | "node" | "sci"`; `PROFILE_META: Record<VmProfile, { version: string; packages: string[]; label: string; interpreters: string[]; packageManagers: string[] }>` in profiles.ts (single source for bake lists T3, capabilities T9, catalog T5); `defaultAssets(profile?)`, `loadBrowserInputs({..., profile})`.

**Transition note:** the CURRENT on-disk asset stays `state.zst` (r12-lo-baked) until T10 bakes the real profiles — `defaultAssets("base")` must fall back to legacy `state.zst` when `state-base.zst` is absent (with a loud console note), so conformance stays green during Waves 1-2. Remove the fallback in T10.

- [ ] TDD: profiles.test.ts (shape), browser-assets eviction-lineage tests (sibling survives, same-profile old version evicted, legacy sweep), assets naming/fallback tests → RED → implement → GREEN.
- [ ] Scoped: `pnpm vitest run packages/runtime-vm/src/browser-assets.test.ts packages/runtime-vm/src/index.browser-clean.test.ts apps/web/src/lib/vm-assets.test.ts` + new files.

**Commit:** `feat(vm): multi-profile assets — profiles subpath, state-<profile> naming, per-lineage cache eviction (legacy fallback until R13 bakes)`

---

### T2: pypi egress shim (runtime-vm)

**Dossiers:** `SCRATCH/r13-spikes/S3-install-e2e.md` §2 (proven shim, exact behavior) + `S1-nat-egress.md` §1/§4.

**Files:** Create `packages/runtime-vm/src/egress-shim.ts` + test. Modify `packages/runtime-vm/src/vm-runtime.ts` (install the shim on `host.networkAdapter()` at boot — instance-property wrap of `adapter.fetch`).

**Behavior (from the proven spike code — s3b-pip.mjs in SCRATCH/r13-spikes):** wrap `fetch(url, opts)`: (1) upgrade `http://`→`https://` ONLY when `typeof window === "undefined"` or page is http-served (v86 does it free on https pages — do not double-upgrade); (2) for responses whose target host is `pypi.org`/`files.pythonhosted.org` and content-type is `application/vnd.pypi.simple.v1+json` OR `text/html` (simple API), rewrite body: `https://files.pythonhosted.org`→`http://files.pythonhosted.org`, `https://pypi.org`→`http://pypi.org`; skip 304s/empty bodies; return Response-like `{status,statusText,url,redirected,headers,arrayBuffer()}` (relay strips content-length — length change safe); (3) pass request headers through untouched (pip's Accept negotiation). Everything else passes through unmodified. Fail-fast: shim errors must not mask the original response — rethrow with context.

- [ ] TDD hermetic with a fake adapter/fetch: upgrade-only-when-no-window, pypi JSON body rewrite, html fallback rewrite, non-pypi passthrough byte-identical, 304 skip, npm-host untouched → RED → implement → GREEN.
- [ ] Scoped: `pnpm vitest run packages/runtime-vm/src/egress-shim.test.ts` (+ conformance stays untouched — do NOT run).

**Commit:** `feat(vm): pypi egress shim on the fetch-NAT — https upgrade (non-https contexts) + simple-API link rewrite; npm needs nothing`

---

### T3: bake pipeline multi-profile (scripts + guestd env; NO real bakes)

**Dossiers:** `SCRATCH/r13-spikes/S2-trial-bakes.md` (community repo + tilde-dep fixes, sizes, memoryMB=512 OK) + `S3-install-e2e.md` §3 RE-BAKE TODO + `S1-nat-egress.md` §2.

**Files:** Modify `packages/runtime-vm/scripts/bake-image.mjs` (`--profile <p>` / `--all` args; per-profile package list FROM `../src/profiles.ts` (import the TS via the same esbuild-bundle trick the e2e scripts use, or duplicate with a test-enforced match — dossier S2 shows what the spike did; prefer importing the single source), output `assets/state-<p>.zst` + `state-<p>.meta.json` with `version`+`profile` stamped; per-profile pre-save_state guest smokes with quote-split markers: base `pip --version`, node `+node --version, npm --version`, sci `+python3 -c "import numpy, pandas"`; keep ETH_OK/LO_OK asserts), `scripts/lib/apk.mjs` (community-repo APKINDEX support + `~` version-constraint parsing — exact fixes in S2 dossier), guest config baked in the setup steps: `mkdir -p /etc /root`, `/etc/resolv.conf` = `nameserver 192.168.86.1`, `/etc/pip.conf` = `[global]` index-url `http://pypi.org/simple/` + trusted-host pypi.org + files.pythonhosted.org + break-system-packages true (base/node/sci), `/root/.npmrc` = `registry=http://registry.npmjs.org/` (node), `packages/runtime-vm/src/guest/guestd.py` (exec env gains `HOME=/root`).

- [ ] `node --check` the scripts; `python3 -m py_compile` guestd.py; hermetic test for any pure helper extracted (e.g. profile→package-list resolution). NO bake runs (T10 does them; S2's trial images at `SCRATCH/r13-spikes/state-{node,sci}.zst` remain available for reference).
- [ ] guestd.py change note: takes effect only at T10's bakes (frozen in snapshot until then) — hermetic suite unaffected.

**Commit:** `feat(vm): multi-profile bake pipeline — community repo + tilde deps, per-profile packages/configs/smokes, resolv.conf+pip.conf+npmrc+HOME baked`

---

### T4: micropip pip command (browser kernel)

**Dossier:** `SCRATCH/r13-spikes/S5-micropip.md` (wiring points with file:line, shared-instance requirement, loadPackage failure semantics).

**Files:** Modify `packages/lang-python/src/python.ts` (export the pip executor from the same module so it SHARES the cached Pyodide instance — python.ts:45-46 closure; loadPackage for Pyodide-prebuilt names (check `pyodide.loadedPackages` after — loadPackage does NOT reject on failure, fail-fast if absent), micropip.install fallback for others; clear stderr on CDN/offline failure), `apps/web/src/lib/languages.ts` (register `pip` alongside `python` — same registerProgram path), + tests with a fake pyodide object (hermetic; the real-CDN leg is T11's).

**UX:** `pip install numpy pandas` → loadPackage; `pip install cowsay` → micropip; `pip install` with no args / unsupported subcommands (`uninstall`, `freeze`?) → implement `list` via loadedPackages, error clearly on the rest (no fake success).

- [ ] TDD with fake pyodide: prebuilt→loadPackage path, pure-py→micropip path, loadPackage silent-failure→error, shared-instance (pip after python reuses instance; python after pip too), offline error message → RED → implement → GREEN.
- [ ] Scoped: `pnpm vitest run packages/lang-python apps/web/src/lib/languages.test.ts` (check the actual test file names first).

**Commit:** `feat(lang-python): pip command on the browser kernel — Pyodide loadPackage + micropip, shared instance, fail-fast on silent load failures`

---

### T5: environments catalog + help pipeline (apps/web)

**Dossier:** `SCRATCH/r13-spikes/S7-help-docs.md` (+ working renderer prototype `SCRATCH/r13-spikes/render-help-proto.mjs`).

**Files:** Create `apps/web/src/lib/environments.ts` (catalog: id `browser | vm:base | vm:node | vm:sci`, label, speed class, interpreters, packageManagers, install recipes, switch guidance — VM entries DERIVED from `@erdou/runtime-vm/profiles` PROFILE_META (type-only + data import via the profiles subpath is browser-clean per S6); consumed by KernelToggle (T7), switch tool schema (T8), AgentOptions.environment (T9), render-help (this task)), `apps/web/docs/help.md` (English; sections: what Erdou is, kernels & profiles + how to choose, installing packages per environment (incl. pip user-site persistence + venv weight note + sci 50s first-import), preview, terminal, folder mount, model config, troubleshooting), `apps/web/scripts/render-help.mjs` (hand-rolled md-subset renderer from the verified prototype — fail-fast with line numbers on unsupported constructs; inject catalog-derived environment table; app design tokens inline), + `apps/web/package.json` predev/prebuild hooks, `apps/web/src/components/TitleBar.tsx` (Help button → `window.open("/help.html")`), root `.gitignore` (+ `apps/web/public/help.html`).

- [ ] TDD: environments.test.ts (catalog shape + derivation from PROFILE_META), renderer unit test (sample md → expected HTML, unsupported construct throws with line) → implement → GREEN; `pnpm --filter @erdou/web exec node scripts/render-help.mjs` produces help.html; verify dev serve (curl 200) briefly.
- [ ] Depends on T1's profiles.ts existing — if T1 hasn't landed when you start, define the import and coordinate via the plan's interface block (PROFILE_META shape is fixed above); run your scoped tests once T1 lands (controller re-runs at checkpoint).

**Commit:** `feat(web): environments catalog (single source of truth) + help.md build-time renderer + TitleBar Help`

---

### T6: agent-side plumbing (agent-core + agent-tools ONLY — studio wiring is T8)

**Dossier:** `SCRATCH/r13-spikes/S4-switch-audit.md` (injection seam, facade design, approval compatibility — file:line).

**Files:** Modify `packages/agent-core/src/types.ts` (`AgentOptions.tools?: ToolDef[]` — extra tools appended to the built-ins), `packages/agent-core/src/agent.ts` (merge opts.tools into the tool table + system-prompt tool list; approval gate applies by tool name as for built-ins). Create `packages/agent-tools/src/switch-environment.ts` (+ export): `createSwitchEnvironmentTool(cb: (target: string) => Promise<string>, opts: { environments: string[] })` returning a ToolDef (schema: `{ target: enum }`; description states when to switch + that the workspace follows) — the callback is app-provided; agent-tools stays contract-only (no studio import). Tests: agent-core extra-tools merge + approval-gated extra tool; agent-tools tool-shape + callback invocation + unknown-target error.

- [ ] TDD both packages → GREEN. Scoped: `pnpm vitest run packages/agent-core packages/agent-tools`.
- [ ] Do NOT touch studio.ts (T8's lane owns it — the S4 facade fix lands there).

**Commit:** `feat(agent): AgentOptions.tools extension point + createSwitchEnvironmentTool (callback-bound, approval-gated)`

---

### T7 (Wave 2, lane L-studio): Studio.switchEnvironment + per-profile VM kernels + selector UI

**Dossiers:** `SCRATCH/r13-spikes/S6-assets-plumbing.md` (one-VM-alive seam: VmRuntime.shutdown; kernel caching map) + `S4-switch-audit.md` §5 (UI assumptions).

**Files:** Modify `apps/web/src/lib/kernel.ts` (+`Environment` type = `{ kind: "browser" } | { kind: "vm"; profile: VmProfile }`; env id string form `browser|vm:<profile>`), `apps/web/src/lib/vm-kernel.ts` (`createVmKernel(profile)` — per-profile assets/version/capabilities via PROFILE_META interpreters/packageManagers), `apps/web/src/lib/studio.ts` (`switchKernel` → `switchEnvironment(envId)`: same guards/hygiene/copyWorkspace/preview-repoint from R12.5, PLUS one-VM-alive — when leaving a VM kernel for another VM profile or browser, after copyWorkspace call the outgoing `VmRuntime.shutdown()` and drop it from the cache (cache becomes per-envId; browser kernel stays cached); keep a `switchKernel("vm"|"browser")` thin compat wrapper if existing tests rely on it, else update tests), `apps/web/src/components/KernelToggle.tsx` (selector lists browser + PRESENT vm profiles (assetsPresent per profile via vm-assets) + "bake it" hint for absent ones; boot progress per env), `apps/web/src/lib/studio-switch.test.ts` (extend: vm:base→vm:node switch shuts down the outgoing VM (spy shutdown), workspace follows, one-VM-alive, absent-profile refused with clear error).

- [ ] TDD → GREEN. Scoped: `pnpm vitest run apps/web/src/lib/studio-switch.test.ts apps/web/src/lib/run-serve.test.ts apps/web/src/lib/kernel.test.ts`.

**Commit:** `feat(web): Environment model — switchEnvironment with per-profile VM kernels, one-VM-alive, present-profile selector`

---

### T8 (Wave 2, lane L-studio, after T7): agent switch_environment wiring + runtime facade + run-initiated switch

**Dossier:** `SCRATCH/r13-spikes/S4-switch-audit.md` — THE critical fixes live here; read fully.

**Files:** Modify `apps/web/src/lib/studio.ts`: (1) **runtime facade** (S4 critical): the CodingAgent construction (~:615) passes a STABLE delegating Runtime forwarding every contract method to `this.kernel.runtime` at CALL time (captured-once `this.runtime` is the bug); apply S4's exact facade shape; (2) **run-initiated switch path**: `switchEnvironment` gains an internal variant callable while `running` ONLY from the agent tool callback — executes between tool calls (agent loop is awaiting the tool), re-checks no in-flight exec/serve (S4 pins what to await/refuse; serve is studio-owned since R12.5 — refuse switch while `servePid` alive? No: stopTrackedServe handles it — follow the dossier), preserves the run-scoped diff subscription by re-pointing per S4 §3; (3) inject `createSwitchEnvironmentTool` into AgentOptions.tools with the catalog's env ids; callback returns a summary string for the model ("switched to vm:node — npm available; workspace copied"); (4) Confirm-mode approval flows unchanged (tool name in the gate). Extend `studio-switch.test.ts` + a new `studio-agent-switch.test.ts`: scripted fake model triggers the tool mid-run → workspace mirrored, subsequent fake tool call executes on the NEW runtime (facade proof), foreign switch (UI) still refused while running, approval-gated in Confirm.

- [ ] TDD → GREEN. Scoped: `pnpm vitest run apps/web/src/lib/studio-switch.test.ts apps/web/src/lib/studio-agent-switch.test.ts apps/web/src/lib/studio-approval.test.ts`.

**Commit:** `feat(web): agent mid-run switch_environment — delegating runtime facade (captured-once fix), sanctioned run-initiated switch, approval-gated`

---

### T9 (Wave 2, parallel lane): agent brief v2 + per-profile capabilities

**Dossiers:** `SCRATCH/r13-spikes/S7-help-docs.md` §2 (catalog flow) + S1/S3/S5 for the truthful narratives.

**Files:** Modify `packages/agent-core/src/prompt.ts` (buildSystemPrompt v2: environments-catalog section from `AgentOptions.environment` (extend the existing environment input shape — agent-core defines the TYPE, app supplies data): current env + available envs + interpreters/packageManagers/egress + install recipes (VM pip: preconfigured, user-site persists, venv is heavy; VM npm: preconfigured; browser pip: Pyodide/micropip, no persistence across reloads; sci: numpy baked, first import ~50s) + when/how to `switch_environment`; keep the simulated-vs-real-Linux narratives), `packages/agent-core/src/prompt.test.ts`, `packages/runtime-vm/src/capabilities.ts` (`vmCapabilities(interpreters, packageManagers?)` or per-profile derivation; `networkEgress: "cors-only"` NOW — the egress is real this round) + capabilities.test.ts + the agent-core prompt "cors-only on realOs" phrasing check (it already says npm/pip work through a gateway — verify truthful for VM).

- [ ] TDD → GREEN. Scoped: `pnpm vitest run packages/agent-core packages/runtime-vm/src/capabilities.test.ts`.

**Commit:** `feat(agent): catalog-driven environment brief v2 + VM networkEgress cors-only with per-profile capabilities`

---

### T10 (Wave 3, single agent): REAL BAKES ×3 + gated smokes

**Dossiers:** S2 (sizes/times/fixes), S3 §3 (config expectations), verify-infra cookbook (`SCRATCH/r12-research/verify-infra.md`).

- [ ] Backup: `cp packages/runtime-vm/assets/state.zst{,.pre-r13.bak}` + meta likewise.
- [ ] `pnpm --filter @erdou/runtime-vm bake --profile base` then `node` then `sci` (each ~2-4min, network via proxy). Each must print its per-profile smoke markers + ETH_OK/LO_OK. Products: `state-{base,node,sci}.zst` + metas with version+profile.
- [ ] Remove T1's legacy `state.zst` fallback (and the old `state.zst` file after conformance passes on `state-base.zst`).
- [ ] Gated: conformance vs base → 32/32; per-profile boot smokes (node: node/npm --version; sci: import numpy — allow ~90s timeout); browser e2e; app-vm e2e; app-vm-preview e2e (all against base).
- [ ] Hermetic full: `pnpm test` + typecheck + lint:deps + build.

**Commit:** `feat(vm): bake the R13 profile set (base/node/sci) — resolv.conf/pip.conf/npmrc/HOME baked, per-profile smokes asserted; drop legacy single-image fallback`

---

### T11 (Wave 3, after T10): ERDOU_NET_E2E suite + agent switch e2e

**Dossiers:** S3 (exact commands + expected times) + S5 §3 (Node pyodide).

**Files:** Create `packages/runtime-vm/src/net.e2e.test.ts` (gated `ERDOU_NET_E2E=1` + assets: (a) base: `pip install six` via baked config → import OK (~45s budget); (b) node: `npm install left-pad` → require OK (~35s); (c) THE acceptance loop: `pip install flask` (~60-90s) + minimal Flask app on 0.0.0.0:8000 → `dispatch` returns the rendered page; (d) sci: `python3 -c "import numpy, pandas"` (~90s timeout)), `apps/web/src/lib/micropip-net.e2e.test.ts` OR a script under scripts/ (Node-side pyodide: loadPackage numpy + micropip pure-py — S5's proven pattern; gate on ERDOU_NET_E2E), plus the agent mid-run switch gated app e2e IF cheap (else the hermetic studio-agent-switch test from T8 suffices — decide per S4 dossier's risk note and report).
- [ ] Run the suite (each test quotes its wall time). Default `pnpm test` must skip them all (hermetic check).

**Commit:** `test: ERDOU_NET_E2E — real pip/npm/flask-preview/micropip loops against live registries`

---

### T12 (Wave 3): docs final + gates + ledger

- [ ] `packages/runtime-vm/README.md`: profiles table (sizes/contents/bake commands), egress story (http-only, https-page requirement for PyPI, CORS boundary, what fails and how), install-persistence semantics. Root `README.md`: Round 13 one-paragraph update. Verify help.md consistency (T5) against final reality.
- [ ] Full gate sweep: hermetic + typecheck + lint:deps + build + ERDOU_VM_E2E suites + ERDOU_NET_E2E suite. Record numbers in the ledger.

**Commit:** `docs: Round 13 — profiles, egress, and package-persistence documentation; final gates green`

---

## Verification cookbook

| Gate | Command | Expected |
|---|---|---|
| Hermetic | `pnpm test` | grows from 397 pass/36 skip; no gated leak |
| Types/layers/build | `pnpm typecheck && pnpm lint:deps && pnpm build` | clean |
| VM conformance | `rm -f packages/runtime-vm/assets/state.bin && ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts` | 32/32 (base) |
| App e2es | `ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm.e2e.test.ts apps/web/src/app-vm-preview.e2e.test.ts` | ALL_PASS |
| Net e2e (new) | `ERDOU_NET_E2E=1 pnpm vitest run packages/runtime-vm/src/net.e2e.test.ts` | all pass, times quoted |

## Self-review notes

- Spec coverage: §1→T1/T3/T10, §2→T2/T3 (+S1's zero-gateway verdict), §3→T1/T7, §4→T6/T8/T9, §5→T5/T12, §6→T4, §7→T10/T11. All spike caveats have owners (resolv.conf→T3; facade→T8; lineage eviction→T1; shared pyodide instance→T4; https-page note→T12 docs).
- File-conflict audit: studio.ts/kernel.ts/vm-kernel.ts/KernelToggle.tsx ONLY in lane L-studio (T7→T8 sequential). profiles.ts created T1, consumed T3/T5/T7/T9 (read-only). capabilities.ts only T9. TitleBar.tsx only T5. agent-core: T6 (types/agent) vs T9 (prompt) — different files, parallel-safe; controller stages commits accordingly.
- Type consistency: `VmProfile`, `PROFILE_META`, `Environment`, env id `browser|vm:<profile>`, `createSwitchEnvironmentTool(cb, {environments})`, `AgentOptions.tools` — single definitions, cross-referenced.

---

## PLAN VERIFICATION AMENDMENTS (v2 — AUTHORITATIVE; these OVERRIDE any conflicting task text above)

Adversarial plan-verification (2 lenses, 6 Critical + 9 Important + 7 Minor) folded in. Every implementer MUST read the amendments for their task; where an amendment contradicts the task body, the amendment wins. Dossier naming is superseded: the switch tool arg is `target` with ids `browser|vm:<profile>` (not `profile`); the VM kernel cache is keyed by env id.

### Single source of truth for profile package lists (resolves M11 + the .mjs-can't-import-.ts fact)
`bake-image.mjs` is a plain Node `.mjs` (imports `./lib/apk.mjs`, no tsx) — it CANNOT import `src/profiles.ts`. Canonical package DATA lives in **`packages/runtime-vm/src/profiles.data.json`** (`{ base: {version, packages, label, interpreters, packageManagers}, node: {...}, sci: {...} }`). `profiles.ts` imports it (`resolveJsonModule` is on — verify tsconfig; else `import ... assert {type:"json"}`) and re-exports typed `PROFILE_META`/`VmProfile`; `bake-image.mjs` reads it via `JSON.parse(fs.readFileSync(new URL("../src/profiles.data.json", import.meta.url)))`. One file, both sides. (T1 creates both; T3 reads the JSON.)

### T1 amendments
- Subpath export: add to `packages/runtime-vm/package.json` `exports` `"./profiles": { "types": "./src/profiles.ts", "import": "./src/profiles.ts" }` AND `publishConfig.exports` `"./profiles": { "types": "./dist/profiles.d.ts", "import": "./dist/profiles.js" }`; add `src/profiles.ts` to the tsup build entry list (`build: tsup src/index.ts src/node.ts src/profiles.ts ...`).
- **I5 (no v86 in bundle) — T1 OWNS the guard test:** add a hermetic static-graph test (reuse the `localGraph` walker from `index.browser-clean.test.ts`) asserting `profiles.ts`'s transitive LOCAL import graph contains no `v86` specifier, no `v86-host.ts`, no node builtins. profiles.ts must import ONLY the JSON (+ pure TS).

### T2 amendments (I4 — shim must have boot-install bite)
Install the shim in **`V86Host.boot`** (right after emulator creation / `networkAdapter()` availability), NOT in vm-runtime.ts — V86Host has the proven `makeEmulator()` FakeHost seam (`v86-host.input-sender.test.ts:14-30`). Add a hermetic v86-host test: fake emulator exposes a NetworkAdapter `{fetch}`; after boot assert `adapter.fetch` was wrapped (marker prop) AND a fake pypi simple-API response comes back link-rewritten. Files: add `packages/runtime-vm/src/v86-host.ts` + `v86-host.input-sender.test.ts` (or a new v86-host.egress.test.ts) to T2; vm-runtime.ts drops out of T2's list.

### T4 amendments
- **I7:** T4 CREATES `apps/web/src/lib/languages.test.ts` (none exists): fake runtime records `registerProgram` calls; assert python/python3 AND pip/pip3 register, and pip+python share ONE factory (single load).
- **I3 (concurrency):** serialize `python`/`pip` executions on a shared promise-chain tail inside the shared factory (~5 lines); the serve/dispatch WSGI callback stays OUTSIDE the queue (a long pip install must not stall a served app). One test: pip started while a python run is pending executes after it (no stdout/stderr crossing).

### T5 amendments
- **C3/I2 presence channel:** do NOT browser-probe `assetsPresent` (Node-only; SPA-fallback trap). `link-vm-assets.mjs` additionally writes `apps/web/public/vm-assets/profiles.json` listing the profiles it actually linked; the selector fetches it. Extract a PURE `environmentOptions(catalog, presentProfiles) -> {value,label,disabled?,hint?}[]` into `environments.ts` with a unit test (KernelToggle stays a dumb renderer — this is the bite seam, avoids the R12.5 no-component-test gap).
- **I9 hook chaining:** predev/prebuild slots ALREADY run link-vm-assets — CHAIN, don't add: `"prebuild": "node scripts/link-vm-assets.mjs && node scripts/render-help.mjs"` (same for predev). render-help.mjs exports `renderMd`/`inject` so the unit test imports them (no duplicate renderer).
- **M11 catalog for the script:** render-help.mjs reads env data from `profiles.data.json` (same single source) + a plain env-catalog description; do not import the TS catalog.

### T6 amendments (C1-tests + C3/I8-semantics)
- `AgentOptions.tools` ALREADY EXISTS with REPLACE semantics (`types.ts:40`, `agent.ts:21` `opts.tools ?? createTools()`). Do NOT change its meaning. Add a NEW `extraTools?: ToolDef[]` appended after the built-ins in agent.ts; T8 passes `extraTools:[switchTool]` only. Test: "built-ins not duplicated when extraTools passed" (tool-name uniqueness in toolSpecs).
- **GATED_TOOLS:** T6 MUST add `"switch_environment"` to `agent-core/src/agent.ts:6` `GATED_TOOLS` + a unit test (switch_environment in Confirm mode awaits approve; a non-gated extra tool does not). This is the ONLY approval mechanism — do not invent a per-ToolDef flag.

### T7 amendments (C1 + C2 + C3 + I2 — the deepest task; these are authoritative)
One-VM-alive EXACT sequence (S6 §3, supersedes the task one-liner AND S4 §2.e/§2.3):
1. profile-aware guards (target==current → no-op; `switchingKernel`/`running` per existing rules).
2. **Boot target B first, A untouched** (accept transient 2×512MB overlap).
3. `this.running` re-check → if a run started: `await B.shutdown()`, **keep A cached**, abort.
4. `stopTrackedServe()` on the OUTGOING runtime (kills servePid, closes ports) while `this.runtime` still targets A.
5. `copyWorkspace(A.fs, B.fs)`.
6. Swap: unsub → `kernel = next` → `_shell = undefined` → resubscribe → `setPreviewRuntime`.
7. **LAST:** `await A.shutdown().catch(e => logSystem(...))` then update cache — but ONLY when A is a VM being replaced. **vm→browser KEEPS the VM cached alive** (preserves R12.5 I4 + `studio-switch.test.ts:68,:126-150`); shutdown fires only when a VM profile is replaced by a *different* VM profile (or a stale cached VM while browser is active, per S6 §3 bullet 1). Cache: single `vmKernel` slot is fine; if a Map, VM entries are dropped on shutdown.
- **C2 stale PTY:** add `apps/web/src/components/TerminalPanel.tsx` + `PtyTerminal.tsx` to T7's files AND to the L-studio conflict audit. Remount the PTY on kernel identity (a `key={envId}` or a Studio kernel-generation counter on `<PtyTerminal>`), so a vm:base→vm:node switch re-opens the terminal on the new guest. Add a step asserting the PTY re-opens after a vm→vm switch.
- **C3/I2 selector:** lists browser + ALL vm profiles; switching to an unbaked profile fails LOUDLY at boot with the `bake --profile <p>` hint (existing catch at `studio.ts:341-346` keeps the user on the working kernel). Use the pure `environmentOptions()` from T5 (disabled+hint from profiles.json). The "absent-profile refused" studio test targets the makeKernel/boot failure path (name it in the assertion).

### T8 amendments (C2-tests + I1 + M1)
- S4 §2 ordering is authoritative EXCEPT step (e) and caveat §2.3 (predate one-VM-alive) — use T7's sequence.
- **I1 servePid (pinned, no waffle):** NEVER refuse for servePid. Order in the run-initiated switch: defensive guard → set `this.switchingKernel` FIRST (inherits runServe's refuse + the stale-settle poison path) → `await eventsSettled()` → `await stopTrackedServe()` on the outgoing runtime → T7 sequence → clear switchingKernel → return new-env brief. FAILURE path: try/catch — on boot/asset failure clear switchingKernel, leave current kernel untouched, return `ok:false` with the bake-hint error (model continues on the old env).
- **Facade (M1):** forward ALL 22 `Runtime` methods (runtime-contract/src/runtime.ts) to `this.kernel.runtime` at call time, incl. `subscribe` (type-completeness; note a facade-made subscription binds to the then-current runtime — harmless: agent-tools uses only readFile/writeFile/readdir/mkdir/rm/exec, grep-verified no subscribe). Studio's own subscriptions stay on concrete runtimes.
- **C2 facade test recipe (hermetic, MUST be constructible):** in `studio-agent-switch.test.ts`: override `(studio as any).gateway` with a scripted gateway (turns: `switch_environment{target:"vm:node"}` → `write_file`/`run_shell` → final); pre-seed the per-envId VM kernel cache with a FAKE vm:node kernel (distinct fs + spied runtime) via internals cast BEFORE the run; assert the 2nd tool call executed on the seeded kernel's runtime (file lands in its fs / exec spy) AND `run.changes` contains the post-switch edit (proves `repointRunDiff`). M2: do NOT await `wait()` on a shut-down runtime in tests (never settles post-dispose).

### T9 amendments (M3)
The catalog section must state "the current environment can change mid-run via switch_environment; trust the latest tool result" (reply turns do NOT rebuild the system prompt — `agent.ts:37-39`). The switch tool's callback summary string (T8) must carry full new-env facts (interpreters, packageManagers, egress, install recipe) since it is the model's only in-band update.

### T10 amendments (M10)
Per-profile pre-save_state smokes ALSO cat-assert baked config markers: `/etc/resolv.conf` contains `192.168.86.1`; `/etc/pip.conf` contains `break-system-packages`; node `/root/.npmrc` contains `registry.npmjs.org`; `echo $HOME`→`/root`. Cheap, catches bake typos at bake time.

### T11 amendments (I6 + M13)
Explicit per-`it` timeouts: flask acceptance loop `{timeout:300_000}`, sci import `180_000`, pip/npm legs `180_000`, micropip `120_000` (place micropip test in runtime-vm's package to inherit 120s default, or set it — apps/web default is 5s, fatal). PIN versions: `six==1.17.0`, `left-pad@1.3.0`, flask pinned to a current exact minor. No auto-retries; each test quotes wall time; on failure capture the NAT fetch log. Gating idiom (visible skips, no false pass): `const RUN = assetsPresent(profile) && process.env.ERDOU_NET_E2E === "1"; describe.skipIf(!RUN)(...)`.

### Conflict-audit corrections
L-studio (T7→T8, sequential) now also owns `TerminalPanel.tsx` + `PtyTerminal.tsx`. T2 owns `v86-host.ts` (shim install) — no other Wave-1 lane touches it (T4 FU2's input-sender test is committed to main already; T2's egress test is a new file). agent-core: T6 edits `types.ts`+`agent.ts`; T9 edits `prompt.ts` — disjoint, parallel-safe (Wave 2). `capabilities.ts` only T9.
