# Round 12 Follow-ups Fix Wave — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every deferred finding from the Round-12 final review + the two Round-11c PTY follow-ups (FU1/FU2), grouped so one re-bake absorbs all guest-side changes.

**Architecture:** 8 host-side tasks (all hermetic-testable, no re-bake) run in parallel lanes with disjoint file sets; 1 guest/bake task (T9) runs alone afterwards and performs the single re-bake + gated re-verification. Every task is grounded in a research dossier under `SCRATCH/r12-research/` (SCRATCH = `/tmp/claude-1018/-home-yzl-Erdou/47b8800b-6d93-4ada-bcbd-c3bb5b308f5f/scratchpad`) — implementers MUST read their dossier; it contains the full current-state quotes, exact fix code, and risk notes verified against the repo at branch `fix/round12-followups` (base 63159aa).

**Tech Stack:** pnpm 11 / Node 22 / Vitest / strict TS / React 18 / v86 0.5.424 / Alpine 3.24.1 guest.

## Global Constraints

- Strict layering (CI: `pnpm lint:deps`): runtime NEVER depends on agent; language/runtime packs depend on contract only.
- Default `pnpm test` stays hermetic — gated suites skip without `ERDOU_VM_E2E=1` + assets. Baseline today: **354 passed | 34 skipped**.
- Dev principles: no over-engineering, few fallbacks, fail-fast with detailed errors.
- `networkEgress` stays `"none"` (no value change anywhere — T3 is comment-only).
- Guest-side changes (`src/guest/*.py`, guest-visible `bake-image.mjs` steps) live ONLY in T9 (single re-bake).
- **Implementer agents do NOT `git commit`** (parallel index races) — the controller commits per task with the message given in each task. Agents also do NOT run repo-wide `pnpm typecheck`/`pnpm build` (integration checkpoint does); they run only their scoped vitest file(s).
- Report discipline: each agent writes its detailed report to `SCRATCH/r12-impl/<task>-report.md` and returns only a short (<25 line) summary — keeps agent responses small.

## Execution model (high parallelism)

Wave 1 lanes (parallel; file sets disjoint):
- L1: T1 dispatch header hygiene (`packages/runtime-vm/src/http-codec.ts`)
- L2: T2 delete orphaned port-registry (`packages/runtime-vm/src/port-registry*.ts`)
- L3: T3 capabilities comment (`packages/runtime-vm/src/capabilities*.ts`)
- L4: T4 FU2 virtio input sender (`packages/runtime-vm/src/v86-host.ts` + new test + gated conformance test)
- L5: T5 FU1 pty input gate (`apps/web/src/lib/pty-input-gate.ts` new + `PtyTerminal.tsx`)
- L6: T6 delete dead Google-Fonts link (`apps/web/index.html` + preview-e2e runner)
- L7: T7 kernel-switch port hygiene (`studio.ts` + `PreviewPanel.tsx` + `studio-switch.test.ts`) **then** T8 VM Bundle&Run (`run-detect.ts` + `PreviewPanel.tsx`) — sequential because both edit `PreviewPanel.tsx`.

Wave 1 integration checkpoint: controller commits per task → `pnpm test` + `pnpm typecheck` + `pnpm lint:deps` + `pnpm build` + gated conformance + all 3 gated e2es.

Wave 2: T9 re-bake batch (single agent, sequential). Then final gates + final whole-branch review.

---

### Task 1: dispatch header hygiene — strip wire-framing headers in `parseHttpResponse`

**Dossier:** `SCRATCH/r12-research/dispatch-hygiene.md` (read first — full rationale + risk notes)

**Files:**
- Modify: `packages/runtime-vm/src/http-codec.ts:107` (one edit in `parseHttpResponse`)
- Test: `packages/runtime-vm/src/http-codec.test.ts` (4 new tests in `describe("parseHttpResponse")`)

**Why (correctness, not just hygiene):** chunked bodies are already de-chunked at parse (`body = dechunk(rest)`) yet `transfer-encoding: chunked` survives — the header lies about the body on EVERY chunked response. And a truncated body under `content-length: N` clamps silently (`rest.subarray(0, n)`) — the preview SW then builds a `Response` with contradicting framing (T3a).

- [ ] **Step 1: Write 4 failing tests** — exact code in dossier §Tests: `strips content-length…`, `strips transfer-encoding after de-chunking…`, `T3a: a body truncated below Content-Length…`, `strips framing headers regardless of wire-case…`. Run: `pnpm vitest run packages/runtime-vm/src/http-codec.test.ts` → 4 FAIL.
- [ ] **Step 2: Implement** — before `return { status, headers, body };` add (comment included, dossier §Proposed fix):
```ts
  delete headers["content-length"];
  delete headers["transfer-encoding"];
```
- [ ] **Step 3: Re-run scoped tests** → all pass (existing tests untouched — none assert framing keys).
- [ ] **Step 4: Do NOT edit `vm-runtime.conformance.test.ts`** — the gated end-to-end assertions for this fix are folded into T9 (same file, avoids Wave-1 conflicts with T4).

**Commit (controller):** `fix(vm): parseHttpResponse strips wire-framing headers — de-chunked/clamped bodies can no longer carry a lying content-length/transfer-encoding (T3a)`

---

### Task 2: delete orphaned Round-11a `port-registry.ts`

**Dossier:** `SCRATCH/r12-research/registry-delete.md`

**Files:**
- Delete: `packages/runtime-vm/src/port-registry.ts`, `packages/runtime-vm/src/port-registry.test.ts` (via `git rm`)
- Modify: `packages/runtime-vm/src/index.browser-clean.test.ts:54-57` (stale comment: replace example `port-registry.ts` → `http-codec.ts`)

Orphanhood verified exhaustively (dossier §Current state): not in the barrel, not in `node.ts`, not a tsup entry, no importer outside its own test. Do NOT touch `packages/runtime-browser/src/port/registry.ts` (the live browser-kernel `PortRegistry`) nor the `PreviewPanel.tsx:18` comment (describes that live class).

- [ ] **Step 1:** `git rm packages/runtime-vm/src/port-registry.ts packages/runtime-vm/src/port-registry.test.ts`
- [ ] **Step 2:** Fix the comment in `index.browser-clean.test.ts` (exact replacement text in dossier §Proposed fix).
- [ ] **Step 3:** Run `pnpm vitest run packages/runtime-vm` → expect `Test Files 12 passed | 2 skipped (14)`, `Tests 64 passed | 31 skipped (95)` (baseline was 13/66 — minus 1 file, 2 tests).

**Commit (controller):** `chore(vm): delete orphaned Round-11a page-side PortRegistry — superseded by real guest dispatch + port watcher (R12 T3/T4)`

---

### Task 3: refresh `capabilities.ts` networkEgress comment (docs-only)

**Dossier:** `SCRATCH/r12-research/capabilities-comment.md`

**Files:**
- Modify: `packages/runtime-vm/src/capabilities.ts:3-5` (doc comment only — the VALUE `networkEgress: "none"` at line 16 must NOT change)
- Modify: `packages/runtime-vm/src/capabilities.test.ts:12` (trailing comment only)

Replacement texts are verbatim in dossier §Proposed fix (comment now says: R12 fetch-NAT is inbound-only preview dispatch; lo up; no outbound reach; gateway = future round). READMEs already accurate — no other edits.

- [ ] **Step 1:** Apply both comment edits.
- [ ] **Step 2:** `pnpm vitest run packages/runtime-vm/src/capabilities.test.ts packages/agent-core/src/prompt.test.ts` → all pass (zero behavior change).

**Commit (controller):** `docs(vm): networkEgress comment reflects R12 reality — NAT-dispatch is inbound-only preview; egress gateway is a future round`

---

### Task 4: FU2 — capacity-aware coalescing virtio-console input sender

**Dossier:** `SCRATCH/r12-research/fu2-pty-race.md` — **read fully**; root cause was CONFIRMED empirically (repro scripts in `SCRATCH/`): v86's `virtio-console*-input-bytes` handler consumes ONE 16-slot RX-ring slot per `bus.send` and SILENTLY DROPS input on ring exhaustion; a synchronous per-keystroke burst >16 (busy tab flushing queued keydowns) loses every byte past the 16th — deterministic 0/8 pre-fix, 8/8 with the fix.

**Files:**
- Modify: `packages/runtime-vm/src/v86-host.ts` — add `VIRTIO_INPUT_CHUNK`, exported `assertVirtioConsoleQueue`, private `inputSenders`/`flushTimers` + `inputSender(port)`; rewire `channel()` and `terminal()` sends through it; `destroy()` clears timers first. Full code in dossier §Proposed fix.
- Test (new): `packages/runtime-vm/src/v86-host.input-sender.test.ts` — 5 hermetic tests (fake emulator with 16-slot ring, `vi.useFakeTimers`), full code in dossier §Tests.
- Test (gated): `packages/runtime-vm/src/vm-runtime.conformance.test.ts` — new `it("pty survives a synchronous per-keystroke burst larger than the 16-slot virtio RX ring (FU2)")`, full code in dossier §Tests. (T4 is the ONLY Wave-1 task allowed to touch this file.)

**Interfaces:** `assertVirtioConsoleQueue(q: unknown, queueId: number)` exported from `v86-host.ts` (fail-fast on v86 upgrades, mirrors `assertFs9pSymbols`). `channel()`/`terminal()` signatures unchanged.

- [ ] **Step 1:** Write the 5 hermetic tests (RED — `assertVirtioConsoleQueue` doesn't exist; sends drop on empty ring).
- [ ] **Step 2:** Implement per dossier. Guard: `flush()` must not re-arm timers after `destroy()` (clear the Set AND set a `destroyed` flag if needed — implementer's judgment, but the "destroy() cancels pending retry timers" test must pass).
- [ ] **Step 3:** `pnpm vitest run packages/runtime-vm/src/v86-host.input-sender.test.ts packages/runtime-vm/src/v86-host.symbols.test.ts packages/runtime-vm/src/pty.test.ts` → GREEN.
- [ ] **Step 4:** Add the gated burst test to `vm-runtime.conformance.test.ts` (it will run at the integration checkpoint — do not run gated suites yourself; they're serialized at checkpoints).

**Commit (controller):** `fix(vm): capacity-aware coalescing virtio-console input sender — v86 silently drops input past the 16-slot RX ring; fixes FU2 first-command byte loss (empirically confirmed)`

---

### Task 5: FU1 — queue PtyTerminal keystrokes until `openPty()` resolves

**Dossier:** `SCRATCH/r12-research/fu1-pty-input.md`

**Files:**
- Create: `apps/web/src/lib/pty-input-gate.ts` — pure `makePtyInputGate()` (`input`/`open`/`close`), full code in dossier §Proposed fix.
- Test (new): `apps/web/src/lib/pty-input-gate.test.ts` — 4 tests, full code in dossier §Tests.
- Modify: `apps/web/src/components/PtyTerminal.tsx` — attach `term.onData` at mount into the gate; dim `connecting…` hint via `term.write("\x1b[2mconnecting…\x1b[0m")`, erased with `\r\x1b[2K` on settle; wire `s.onData` BEFORE `gate.open` (echo/banner order); `.catch` closes the gate and guards `!disposed` before writing the error (fixes a latent write-after-dispose). Full replacement effect body in dossier §Proposed fix.

**Do NOT use xterm `disableStdin`** — it suppresses `onData` entirely (drops instead of queueing).

- [ ] **Step 1:** Write `pty-input-gate.test.ts` (RED — module missing).
- [ ] **Step 2:** Implement `pty-input-gate.ts` → `pnpm vitest run apps/web/src/lib/pty-input-gate.test.ts` GREEN.
- [ ] **Step 3:** Rewire `PtyTerminal.tsx` per dossier (ordering-sensitive; keep the inline comments).
- [ ] **Step 4:** Update the stale rationale comment at `apps/web/scripts/app-vm-e2e/run.mjs:244-248` (keep the `waitForXterm("$")` itself — the guest prompt still arrives asynchronously; only the "silently dropped" wording changes).

**Commit (controller):** `fix(web): PtyTerminal queues keystrokes until openPty resolves (FU1) — input gate + connecting hint; no more silent pre-session drops`

---

### Task 6: delete the dead Google-Fonts link (self-host finding, resolved by deletion)

**Dossier:** `SCRATCH/r12-research/font-selfhost.md` — research OVERTURNED the premise: commit `46623f8` moved the design to pure system font stacks (`--sans`/`--mono` in `styles.css:6-7` never reference the Google families; zero references repo-wide). The `<link>`s are leftover dead code that render-block first paint (and forced the R12 e2e `page.route` abort workaround). Correct fix = deletion, not vendoring.

**Files:**
- Modify: `apps/web/index.html` — delete lines 8-13 (both preconnects + the stylesheet link).
- Modify: `apps/web/scripts/app-vm-preview-e2e/run.mjs:144-149` — delete the 6-line fonts-abort workaround (comment + `page.route`).
- Test (new): `apps/web/src/index-html.test.ts` — 2 tests (`references no third-party origins…`, `keeps the same-origin shell intact`), full code in dossier §Tests.

- [ ] **Step 1:** Write `index-html.test.ts` (RED — index.html still has `https://` URLs).
- [ ] **Step 2:** Delete the link block; run `pnpm vitest run apps/web/src/index-html.test.ts` → GREEN.
- [ ] **Step 3:** Delete the e2e runner workaround (safe ONLY together with Step 2 — never remove the route while the link exists).

**Commit (controller):** `fix(web): drop the dead Google-Fonts link (system stacks since 46623f8) — offline first paint; delete the R12 e2e fonts-abort workaround`

---

### Task 7: kernel-switch port hygiene — Studio owns `servePid`; kill + close on the OUTGOING runtime pre-swap

**Dossier:** `SCRATCH/r12-research/port-hygiene.md`

**Files:**
- Modify: `apps/web/src/lib/studio.ts` — add `servePid: number | null = null` field (after `openPorts`, ~line 134); add private `stopTrackedServe()` (kill tracked pid with `.catch(()=>{})`, `closePort` every tracked port, clear both — full code in dossier §Proposed fix); call `await this.stopTrackedServe();` in `switchKernel` AFTER the post-boot `this.running` re-check (line ~301) and BEFORE `copyWorkspace` (line ~306) — must target the outgoing runtime while `this.runtime` still points at it.
- Modify: `apps/web/src/components/PreviewPanel.tsx` — delete the `servePid` ref (lines 55-58); use `studio.servePid` in the three places (set after serve ~line 77, kill-before-rerun ~134-137, Stop ~195-198); add the panel-half reset effect on `studio.kernelKind` change (reset `openedPorts.current`/`setSelectedPort(null)`) — full code in dossier §Proposed fix.
- Test: `apps/web/src/lib/studio-switch.test.ts` — 3 new tests (kill+close on outgoing runtime then cleared; new-kernel events repopulate; aborted swap leaves everything untouched), full code in dossier §Tests. Note: `exposePort` (not `listen`) emits `port.opened`; use `eventsSettled()`.

**Semantic decision (locked by research):** the outgoing kernel's server is KILLED, not kept — it's unreachable post-`setPreviewRuntime`, would serve a stale frozen mirror, and its socket blocks switch-back re-serves.

- [ ] **Step 1:** Add the 3 tests (RED: 1 and 3 fail; 2 passes today and pins resub behavior).
- [ ] **Step 2:** Implement studio.ts then PreviewPanel.tsx per dossier.
- [ ] **Step 3:** `pnpm vitest run apps/web/src/lib/studio-switch.test.ts apps/web/src/lib/run-serve.test.ts` → GREEN.

**Commit (controller):** `fix(web): kernel-switch port hygiene — kill tracked serve + close tracked ports on the outgoing runtime pre-swap; Studio owns servePid (absorbs T6a + stale chips)`

---

### Task 8: VM Bundle & Run — kernel-aware static-serve command (runs AFTER T7, same lane)

**Dossier:** `SCRATCH/r12-research/bundle-run-vm.md`

**Files:**
- Modify: `apps/web/src/lib/run-detect.ts` — new exported `staticServeCommand(kind, dir)` (vm → `python3 -m http.server 8080 --bind 0.0.0.0 -d <dir>`; browser → `erdou serve <dir> --spa`); `detectRunCommand(fs, kind = "browser")` uses it for both static prefills. `import type { Kernel } from "./kernel.js"` (type-only — must not drag v86 into the main bundle). Full code + doc comments in dossier §Proposed fix.
- Modify: `apps/web/src/components/PreviewPanel.tsx` — Bundle&Run uses `staticServeCommand(studio.kernelKind, "/dist")`; prefill passes `studio.kernelKind`; add the re-prefill-on-kernel-switch effect (only replaces the input when it still equals the previous kernel's auto-detection); kernel-aware placeholder optional. Full code in dossier §Proposed fix.
- Test: `apps/web/src/lib/run-detect.test.ts` — new `describe("staticServeCommand")` (2) + `describe("detectRunCommand (vm kernel)")` (4); update 2 existing expectations (`erdou serve . --spa` → `erdou serve / --spa`, `dist` → `/dist` — behaviorally identical in the builtin, verified). Full code in dossier §Tests.

**Design notes (locked):** busybox `httpd` is verified ABSENT from the bake; python3 is guaranteed (guestd needs it); port 8080 mirrors the browser builtin default; SPA-fallback loss on VM is an accepted, documented non-issue (iframe always enters at `/`; pushState never re-fetches). Transport reuses `runServeCommand`'s existing realOs detached path (T6) untouched — kill-before-rerun and `port.opened` await come free via T7's `studio.servePid`.

- [ ] **Step 1:** Add/adjust run-detect tests (RED).
- [ ] **Step 2:** Implement `run-detect.ts` → scoped tests GREEN.
- [ ] **Step 3:** Wire `PreviewPanel.tsx` (builds on T7's edits — same lane, sequential).
- [ ] **Step 4:** `pnpm vitest run apps/web/src/lib/run-detect.test.ts apps/web/src/lib/run-serve.test.ts` → GREEN.

**Commit (controller):** `feat(web): kernel-aware Bundle & Run + run prefill — the VM guest serves /dist with python3 http.server (no erdou binary in the guest)`

---

### Task 9 (Wave 2, single agent, sequential): re-bake batch — lo baked + asserted networking + guarded port_watcher

**Dossier:** `SCRATCH/r12-research/rebake-batch.md` (+ `SCRATCH/r12-research/verify-infra.md` for the command cookbook). The ONLY task touching guest files; one re-bake absorbs all three items.

**Files:**
- Modify: `packages/runtime-vm/scripts/bake-image.mjs` — replace the net step (lines ~104-110) with the asserted version: eth0 DHCP + `grep -q 192.168.86.100` → quote-split `ETH_O''K`/`ETH_F''AIL`, lo up → `LO_O''K`/`LO_F''AIL`, `NETD''ONE` marker; host-side `throw` on missing `ETH_OK`/`LO_OK` with serial tail. Full code in dossier §Proposed fix 1.
- Modify: `packages/runtime-vm/src/vm-runtime.ts:75-79` — delete the per-boot lo-up exec, replace with the 2-line "networking fully baked" comment (dossier §Proposed fix 2).
- Modify: `packages/runtime-vm/src/guest/guestd.py` — wrap the `port_watcher` loop body in `try/except Exception: traceback.print_exc()` (sleep stays OUTSIDE the try; `last = cur` stays INSIDE); add `traceback` to the import line. Full code in dossier §Proposed fix 3. Rationale: a `"!"` frame with id 0 is silently dropped host-side — stderr→/tmp/gd.log is the only log channel.
- Modify: `packages/runtime-vm/scripts/lib/preload.mjs:60` — add `traceback` to `PYCACHE_WARMUP_CMD` imports (pycache must warm before the ro-remount).
- Modify: `apps/web/src/lib/vm-assets.ts:8` + `apps/web/src/lib/vm-assets.test.ts:10` — version → `"alpine-3.24.1-r12-lo-baked"` (BOTH, same string).
- Modify: `packages/runtime-vm/README.md:140,160` — lo is baked+asserted (not per-boot); current version mention.
- Test (gated, new): `vm-runtime.conformance.test.ts` — `it("restores the baked state with loopback (lo) already up — no per-boot lo exec")` (dossier §Tests 2); PLUS fold in T1's gated dispatch-header assertions (3 lines inside the existing `dispatch reverse-proxies…` test — see `SCRATCH/r12-research/dispatch-hygiene.md` §Tests "Optional gated"): expect `content-length`/`transfer-encoding` undefined, `content-type` still flows.

- [ ] **Step 1 (BACKUP — mandatory before anything):**
```bash
cp packages/runtime-vm/assets/state.zst packages/runtime-vm/assets/state.zst.r12-net-watch.bak
cp packages/runtime-vm/assets/state.meta.json packages/runtime-vm/assets/state.meta.json.r12-net-watch.bak
```
(`assets/.gitignore` covers them; the only other backup on disk is the WRONG vintage — pre-port-watcher.)
- [ ] **Step 2 (honest RED):** apply the `vm-runtime.ts` exec removal FIRST, run gated conformance against the OLD state → the new lo test AND the existing `127.0.0.1-only server` test both FAIL (proves the exec was load-bearing).
- [ ] **Step 3:** apply bake-image.mjs + guestd.py + preload.mjs edits; `python3 -m py_compile packages/runtime-vm/src/guest/guestd.py`.
- [ ] **Step 4 (RE-BAKE):** `rm -f packages/runtime-vm/assets/state.bin && pnpm --filter @erdou/runtime-vm bake` — needs network (dl-cdn.alpinelinux.org); expect the new `marker: NETDONE (asserted: eth0=192.168.86.100 via DHCP, lo up)` line; ~1-3 min.
- [ ] **Step 5:** version bump (vm-assets.ts + test), README updates.
- [ ] **Step 6 (gated verify, in order):** `rm -f packages/runtime-vm/assets/state.bin && ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts` → **32 passed** (30 + lo test + FU2 burst test from T4); then `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/browser.e2e.test.ts` (fresh profile pulls the new state); then both app e2es (`apps/web/src/app-vm.e2e.test.ts`, `apps/web/src/app-vm-preview.e2e.test.ts`) → `RESULT ALL_PASS`.
- [ ] **Step 7:** hermetic `pnpm test` + `pnpm --filter @erdou/runtime-vm typecheck`.
- [ ] **Rollback (if the new bake regresses):** restore both `.bak` files, `rm -f assets/state.bin`, revert the version bump + vm-runtime.ts edit.

**Commit (controller):** `feat(vm): bake networking fully into the state — lo up + asserted eth0/lo markers at bake; guarded port_watcher (traceback→gd.log); drop the per-boot lo exec; re-bake alpine-3.24.1-r12-lo-baked`

---

## Integration & final verification (controller)

- [ ] After Wave 1: commit tasks in order T1→T8 (staging each task's file set), then run: `pnpm test` (expect ~375 passed | 35 skipped — verify actual; count grows +4 T1, −2 T2, +5 T4, +4 T5, +2 T6, +3 T7, +6 T8), `pnpm typecheck`, `pnpm lint:deps`, `pnpm build`, and the 4 gated suites (serialized).
- [ ] After Wave 2 (T9): full gate sweep again (cookbook in `SCRATCH/r12-research/verify-infra.md`): hermetic test/typecheck/lint:deps/build + gated conformance 32/32 + browser e2e + app-vm e2e + app-vm-preview e2e ALL_PASS.
- [ ] Final whole-branch review (multi-agent adversarial, per project convention) → fix wave if findings → re-verify → update `.superpowers/sdd/progress.md` → push branch.

## Self-review notes

- Spec coverage: all 9 ledger findings mapped (T1=dispatch hygiene, T2=port-registry, T3=capabilities comment, T4=FU2, T5=FU1, T6=font, T7=port hygiene incl. T6a, T8=Bundle&Run-on-VM, T9=re-bake batch: lo/T5b + watcher-guard/T4a + NETUP assertion). vm-runtime.conformance.test.ts is touched by exactly one task per wave (T4 in W1, T9 in W2). PreviewPanel.tsx shared by T7/T8 → same lane, sequential. All Wave-1 tasks re-bake-free (FU2 fix is host-side — empirically verified).
- Placeholder scan: fix code is either inline or verbatim in the named dossier section (dossiers are part of this plan's contract; implementers must read them).
- Type consistency: `staticServeCommand(kind: Kernel["kind"], dir: string): string`; `makePtyInputGate(): { input(Uint8Array): void; open(sink): void; close(): void }`; `assertVirtioConsoleQueue(q: unknown, queueId: number)`; `Studio.servePid: number | null`; `stopTrackedServe(): Promise<void>` — names match across tasks.
