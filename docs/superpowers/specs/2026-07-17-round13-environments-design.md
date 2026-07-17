# Erdou Round 13 — Environments & Packages: multi-image VM profiles, package egress, agent environment selection

Status: design approved by user (2026-07-17, brainstorming); spike verdicts folded in below. Branch `feat/round13-egress-gateway`.

## 1. Context & goals

Round 12.5 left the dual-kernel OS complete but package-less: the VM guest ships python3 only, `networkEgress` is `"none"`, and the browser kernel's Pyodide cannot load scientific packages. The user's driving need: **real package ecosystems** — `pip install flask` on the VM, numpy/pandas somewhere sensible — plus **agent-driven environment choice** and **discoverable documentation** of the whole OS collection.

One-line goal: *any environment in the collection can install real packages from real registries, the agent knows the collection and can switch mid-run, and both humans and agents have accurate docs.*

## 2. Decisions (locked with user during brainstorming)

- **Multi-image profiles, all baked locally**: `base` (python3 + py3-pip), `node` (base + nodejs + npm), `sci` (base + py3-numpy + py3-pandas). Each is a separate `state-<profile>.zst` + meta + version (`alpine-3.24.1-r13-<profile>`). Rationale: tools and 32-bit-wheel-less heavyweights get baked (chicken-and-egg: apk mirrors are not CORS-open, so runtime tool-install would demand external infra; guest rootfs is snapshot-ephemeral so runtime installs would repeat every session); day-to-day project deps flow through the gateway at runtime.
- **Package egress via the v86 fetch-NAT** (hypothesis verified by spike S1/S3): guest pip/npm are configured (baked) to plain-HTTP registry URLs; the page-side NAT turns guest HTTP into browser `fetch` to the real registries. PyPI + files.pythonhosted + registry.npmjs.org are CORS-open (curl-verified R10 research). TLS terminates at the browser; no MITM, no guest CA. VM `networkEgress` → `"cors-only"`.
- **Agent switches environments mid-run** ("运行中任意步间"): a `switch_environment` tool, injected app-side, executes between tool calls, gated by the existing Auto/Confirm approval mechanism. Human selector in the TitleBar stays authoritative outside runs.
- **micropip in scope**: browser-kernel `pip install` maps to Pyodide `loadPackage` (prebuilt numpy/pandas/scipy…, near-native speed) + `micropip.install` (pure-Python PyPI). This is the recommended home for data-science Python; the VM `sci` profile is the compatibility fallback.
- **One VM alive at a time**: switching VM profiles shuts down the outgoing VM after `copyWorkspace`; the workspace truth is host-side (9p), so nothing is lost.
- **Docs**: `docs/help.md` (human) rendered at build time to `public/help.html`, opened via a TitleBar Help button in a new window; the agent-facing usage guide is generated from a **single environments-catalog source of truth** also consumed by the UI selector and `buildSystemPrompt` (no drift).
- **Deferred (Round 14+)**: WISP relay client wiring (apk/git/arbitrary TCP), apk-over-gateway (impossible without relay — mirrors send no CORS), zstd re-compression, a second (64-bit) VM engine, guest gcc toolchain.

## 3. Architecture

### §1 Multi-image bake
`bake-image.mjs` gains a profile parameter (`pnpm --filter @erdou/runtime-vm bake --profile node`, default `base`; `--all` bakes the set). Each profile: its apk package list, its version string, its output pair `assets/state-<profile>.zst` + `state-<profile>.meta.json` (meta carries `version` + `profile` — the R12.5 fail-fast binding, per-profile). `base` replaces today's unnamed image; the conformance suite pins `base`. Guest-side, each profile bakes the package-manager configuration pointing at the gateway (pip: `/etc/pip.conf` index-url + trusted-host; npm: global npmrc registry), so installs work out of the box. The NETDONE-style bake assertions extend per-profile (tool `--version` smoke before `save_state`).

### §2 Package gateway
Spike-verified shape (see §Spike verdicts): guest-originated plain-HTTP through the v86 fetch adapter becomes page `fetch`. Where the raw relay needs help (redirect semantics, host allowlists, header hygiene), a thin page-side shim on the adapter's request path — allowlisting exactly the registry hosts — is the fallback; anything else fails guest-side with the real network error (fail-fast; the brief documents the reachable set). `vmCapabilities` gains `networkEgress: "cors-only"` and truthful `packageManagers` per profile.

### §3 Environment model & selection
`Environment = { kind: "browser" } | { kind: "vm", profile: "base" | "node" | "sci" }`. Studio's `switchKernel` generalizes to `switchEnvironment` (same guards, hygiene, copyWorkspace, preview re-point — all R12.5 machinery); VM-kernel caching becomes per-profile construction with an **at-most-one-VM-alive** policy (outgoing VmRuntime is shut down after the workspace mirror). Browser asset cache keys become `state:<profile>:<version>`, eviction scoped to the same profile's lineage (today's evict-everything-else would nuke sibling profiles). `link-vm-assets` serves every present profile; the UI lists present profiles and shows a "bake it" hint for absent ones (fail-fast, no silent downloads of nonexistent files).

### §4 Agent: switch_environment + harness v2
An app-injected `switch_environment` tool (agent-tools shape, app-side callback → `studio.switchEnvironment` via a sanctioned run-initiated path — the "refuse while running" guard distinguishes *foreign* switches from the run's own request, which executes between tool calls when the runtime is idle). Diff capture stays correct because `copyWorkspace` mirrors the workspace and the run-scoped `file.changed` subscription is re-pointed (spike S4 pins the exact seam). Confirm mode intercepts the tool exactly like `run_shell`. `buildSystemPrompt` is rewritten around the **environments catalog**: every available environment with interpreters, package managers, egress, speed class, and install recipes; the current environment; when and how to switch. The catalog data flows in via `AgentOptions.environment` (agent-core never imports the app — layering intact).

### §5 Docs
`docs/help.md` (English, user-facing: kernels & profiles, choosing an environment, installing packages in each, preview, terminal, folder mount, model config). Build-time renderer script (`apps/web/scripts/render-help.mjs`, prebuild hook beside link-vm-assets) produces `public/help.html` styled with the app's tokens; TitleBar Help button does `window.open("/help.html")`. The agent guide is not a second document: it is the catalog + prompt.ts narrative (single source of truth).

### §6 micropip (browser kernel)
`lang-python` gains a package-install path: `pip install X` in the browser-kernel shell dispatches to Pyodide — `loadPackage` when X is in Pyodide's prebuilt set, else `micropip.install` (pure-Python wheels from PyPI, CORS-open). Load errors surface the CDN/offline cause verbatim. Browser-runtime capabilities list `pip (micropip)` truthfully.

### §7 Testing
- Hermetic (default `pnpm test`): profile parameterization units, cache-eviction lineage, catalog/prompt composition, switch-tool guard logic, help renderer.
- `ERDOU_VM_E2E` (offline-gated): per-profile boot smokes (tools present), conformance stays green on `base`, agent mid-run switch e2e with a scripted model.
- **New `ERDOU_NET_E2E`** (real-internet-gated): VM `pip install` → real Flask preview closed loop; VM `npm install` small package; micropip numpy in headless Chromium (needs proxy-aware launch — the sandbox's Chromium runs `--no-proxy-server` today, spike S5 pins the workaround); these are the round's acceptance tests.

## 4. Spike verdicts (hands-on, 2026-07-17 — full evidence in session scratchpad r13-spikes/)

All seven spikes returned GO (WORKS or WORKS-WITH-CAVEATS). Load-bearing facts:

- **S1 NAT egress — WORKS.** v86's fetch adapter relays guest-originated plain-HTTP:80 to real servers with ZERO custom gateway code (Host header routes; fake DNS answers everything; fetch follows redirects; only port 80 — 443/other RST instantly, a clean failure mode). Blocker found: the image has **no /etc at all** → musl DNS defaults to 127.0.0.1; one baked line fixes it (`/etc/resolv.conf` → `nameserver 192.168.86.1`). On an **https-served page** v86 auto-upgrades guest `http://` targets to `https://` fetches (free); http-dev/Node need the shim's URL upgrade. Throughput ~1.7MB/s on 1MB files — fine for pip/npm.
- **S2 trial bakes — WORKS.** All three profiles resolve + bake + boot at `memoryMB=512`: base 43.7MB gz (31s bake), node 69.9MB (36s), sci 67.3MB (39s). Needs two bake-pipeline fixes: community-repo support (npm/py3-numpy/py3-pandas live in community) and `~`-version dep parsing. Guest smokes green: pip 26.1.2 / node 24.17.0 / npm 11.12.1 / numpy 2.4.6 / pandas 3.0.3. Caveat: first `import numpy` ≈ 50s under emulation (document; recompute in Pyodide instead).
- **S3 install e2e — WORKS.** THE closed loops ran against real registries from the guest: `npm install left-pad` **28s with zero shim** (registry 301s http→https, fetch follows; npm 11's `replace-registry-host` fixes tarball URLs itself; sha512 passes). `pip install six` **42s** with (a) `--break-system-packages` (PEP 668; bakeable into `/etc/pip.conf`), (b) the **pypi shim**: pypi.org/files.pythonhosted.org answer plain http with `403 SSL is required` (no redirect!) and simple-API bodies link `https://` wheels → a small page-side wrap of `networkAdapter().fetch` upgrades URLs (Node/http-dev only) and rewrites `https://files.pythonhosted.org|pypi.org` → `http://` in simple-API response bodies. **Ephemerality assumption REVERSED:** guest `/` is the chroot'd 9p workspace, `/usr` is ro → pip user-site (`/root/.local/...`) and `node_modules` land ON the workspace and persist via snapshots; only /tmp + skeleton dirs are ephemeral. venv works but adds ~1.5k files to snapshots — user-site is the default guidance. Bake additions: `/etc`, `/root`, resolv.conf, `/etc/pip.conf` (index-url + trusted-host ×2 + break-system-packages), `/root/.npmrc` (registry), `HOME=/root` in guestd exec env.
- **S4 switch audit — WORKS.** Clean injection seam: `createSwitchEnvironmentTool(cb)` in agent-tools (ToolDef shape) passed via `AgentOptions.tools`; approval gate slots in unchanged. **Critical bug-in-waiting found:** `runtime: this.runtime` at CodingAgent construction captures the getter ONCE — post-switch tools would hit the old kernel; fix = a stable delegating Runtime facade forwarding to `this.kernel.runtime`. Mid-run switch executes between tool calls (runtime idle); run-scoped diff subscription re-point pinned in the dossier.
- **S5 micropip — WORKS.** Proven with real Pyodide 0.26.4 in Node: `loadPackage("numpy")` + computation + `micropip.install` of a pure-python wheel. `pip` registers via the same `registerProgram` path as `python` but MUST reuse python's cached Pyodide instance; `loadPackage` does not reject on failure (check `loadedPackages` and fail-fast); no persistence across reloads (document). Sandbox headless Chromium has no egress → browser leg of net tests is Node-legged or proxy-wired.
- **S6 assets plumbing — WORKS.** Pure refactor, no contract change: new `@erdou/runtime-vm/profiles` subpath (browser-clean); cache key `state:<profile>:<version>` with same-lineage eviction (today's `startsWith("state:")` eviction would nuke sibling profiles — confirmed bug) + one-time legacy sweep; meta gains `profile`; `defaultAssets(profile="base")` keeps conformance stable; VmRuntime.shutdown is the one-VM-alive disposal seam.
- **S7 help docs — WORKS.** ~50-line hand-rolled md-subset renderer (fail-fast on unsupported constructs) prototyped and verified; no new deps; `public/help.html` served in dev and build; environments-catalog module shape anchored for all four consumers.

## 5. Risks

- **32-bit wheel gap**: pip on the VM covers pure-Python; C-extension packages need the `sci` bake (Alpine's prebuilt apks) or are out of scope — the brief must say so, or agents will burn steps on doomed `pip install numpy` in `base`.
- **PyPI requires an https-served page in production** (v86's auto-upgrade branch); on http-served dev the shim's URL upgrade covers it. npm works regardless. Only TCP:80 is relayed — guests must use `http://` URLs; anything else refuses instantly (clean failure).
- **In-browser CORS is the one unproven half** of the egress story (Node spikes bypass CORS): rests on R10 curl evidence (ACAO:* on npm + PyPI metadata AND artifacts, re-confirmed by S3 curl probes) until a net-enabled browser e2e runs.
- **Mid-run switch is the deepest change**: guarded by S4's audit; must not weaken the R12.5 mutual-exclusion work (foreign switches stay refused while running), and must ship the S4 runtime-facade fix (captured-once `this.runtime`) with it.
- **Snapshot weight**: venv adds ~1.5k files to every snapshot — guidance steers to pip user-site (persists, few files); sci first-import ≈ 50s under emulation — heavy numeric work belongs to Pyodide.
- **Sandbox network asymmetry**: Node reaches the net via proxy, headless Chromium does not — ERDOU_NET_E2E browser legs need explicit proxy wiring or are Node-legged.

## 6. Delivery

One round, SDD with parallel lanes (research dossiers → adversarially verified plan → implement+review waves → final whole-branch review), mirroring Round 12.5's process. Bake-touching tasks batch into single re-bake points per profile.
