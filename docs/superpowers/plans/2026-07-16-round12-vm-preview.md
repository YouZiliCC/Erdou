# Round 12 — VM guest-server live preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Note:** the tasks are sequentially dependent, not independent — Task 3 needs Task 1's re-baked `state.zst`, Task 5 needs Task 4's re-baked `state.zst`, and Task 6 needs Task 5's runtime interface. If run one subagent per task, the controller MUST thread each task's interfaces plus the shared rebuilt `state.zst` asset forward — do not treat the tasks as order-agnostic, independent units.

**Goal:** Make a real server running INSIDE the Alpine VM guest (e.g. `python3 -m http.server 8000 --bind 0.0.0.0`) previewable live in the app's Preview panel — the browser kernel already does this for in-JS servers; the VM kernel gains a real `VmRuntime.dispatch(port, req)` that reverse-proxies the existing preview Service Worker into the guest server over v86's fetch-NAT network adapter, plus a guest-side `/proc/net/tcp` port watcher so `port.opened`/`port.closed` fire from real sockets.

**Architecture:** Re-bake `assets/state.zst` with a virtio NIC (`net_device`) and a DHCP-addressed `eth0` (192.168.86.100) frozen in the saved state; restore with `preserve_mac_from_state_image: true` so v86's in-JS `FetchNetworkAdapter` can reach the guest. `V86Host` exposes `networkAdapter()`; `VmRuntime.dispatch` opens a per-request TCP connection to the guest, writes an HTTP/1.1 request (pure `http-codec`), accumulates the response, and finishes on Content-Length/chunked-terminator/idle/close. A daemon thread in `guestd` watches `/proc/net/tcp(6)` for LISTEN sockets and pushes `"L"` port-event frames over hvc0; `VmRuntime` translates them into `port.opened`/`port.closed` plus the existing `resource.warning` event for a loopback-only bind (no new contract event) on its event bus. The app's serve flow becomes kernel-aware: for a real OS it spawns the server detached and awaits `port.opened` instead of the browser kernel's serve-returns-after-registering assumption.

**Tech Stack:** TypeScript strict, pnpm workspaces, Vitest. `packages/runtime-vm` (v86 + Alpine guest, `guestd.py` Python daemon), `packages/runtime-contract` (shared event/HTTP types), `apps/web` (Vite + React, preview Service Worker bridge). Gated e2e via playwright-core + system Chromium. NO new npm dependencies.

## Global Constraints

- Node ≥ 22, pnpm ≥ 11. Layering (`pnpm lint:deps`): apps/web MAY import runtime-vm; runtime packages import only the contract. No new violations.
- Repo clean: the VM boot binaries (state.zst/kernel/bios) stay GITIGNORED, NEVER committed. The re-baked networked `state.zst` is a gitignored build artifact.
- Zero regression + hermetic default: `pnpm test` stays green and SKIPS the gated VM suites by default (gated on the asset + `ERDOU_VM_E2E=1` + system Chromium). The Node gated VM conformance stays green (currently 25/25; new dispatch/port tests ADD to it).
- Fail fast, no silent fallbacks (EXCEPT: IndexedDB asset caching is best-effort; and a dispatch to an unbound/loopback-only port returns a real 502, not a hang).
- **On re-bake, BUMP the asset `version` string** (`apps/web/src/lib/vm-assets.ts` + any bake manifest) so IndexedDB-cached clients re-fetch the networked state.
- All commits on branch `feat/round12-vm-preview`.
- Scope is VM PREVIEW ONLY. The npm/pip network-egress gateway (spec §7) and WISP are OUT OF SCOPE this round (deferred; `networkEgress` stays `"none"`).

## Verified foundation (Spike) — see `.superpowers/sdd/r12-spike-notes.md`

The spike proved **page→guest HTTP dispatch works end-to-end IN THE BROWSER** with our Alpine image (headless Chromium booted the re-baked networked `state.zst`, started a real `python3 -m http.server` via the production `guestd` exec path, and got a real HTTP response back through v86's in-JS fetch-NAT: `PASS dispatch (HTTP/1.0 200 OK, ttfb=78ms)`). All pre-existing self-tests (python-42, sync-fs, pty) still passed — networking added zero regressions. Critical verified facts the plan MUST match:

- **RE-BAKE IS MANDATORY.** Adding `net_device` only at RESTORE time crashes v86 (`TypeError: Cannot read properties of null (reading '0')` in `ed.set_state` — the snapshot's per-device state array is index-out-of-bounds for a device it never had). The NIC must be present at bake time. The kernel only creates `eth0` if the virtio-NIC is present at boot; we bring `eth0` up + DHCP **before** `save_state`, so restores boot with a live, addressed `eth0` — zero per-boot network setup.
- **`preserve_mac_from_state_image: true` IS REQUIRED on the restore path.** `connect()`/`tcp_probe()` build the ethernet frame with `hdest = adapter.vm_mac`, which is set only by the `net{id}-mac` bus message. On restore the device does NOT re-emit it UNLESS this flag makes `ed.set_state` re-teach the freshly-constructed adapter the guest MAC. Without it every `connect`/`tcp_probe` **hangs forever** (240s timeout). With it: `tcp_probe(closed)=false` fast, `tcp_probe(open)=true`, dispatch works.
- **Network addressing is hard-coded in the NAT at construction:** `router_ip=192.168.86.1`, `vm_ip=192.168.86.100`, `router_mac=52:54:0:1:2:3`. DHCP just hands the guest `vm_ip`. `connect(port)`/`tcp_probe(port)` target 192.168.86.100 regardless of DHCP history, so a fresh post-restore adapter reaches the baked guest with no re-DHCP.
- **0.0.0.0 bind is mandatory.** The NAT connects `router_ip → vm_ip:port`. A `127.0.0.1` bind is on the guest loopback, not eth0, so it is unreachable — dispatch 502s. The port-watcher detects a loopback-only bind and surfaces a "bind 0.0.0.0" hint; page-side `tcp_probe` can NOT tell loopback from closed.
- **HTTP end-detection:** `python -m http.server` answers HTTP/1.0 with `Content-Length` and closes per request; send `Connection: close`. For keep-alive HTTP/1.1 the socket won't close — find the end yourself: prefer `Content-Length`, else `Transfer-Encoding: chunked` (parse to the `0\r\n\r\n` terminator), else fall back to a 600ms idle timer / `close`. **v86's `close` event is unreliable** (does not always fire on the guest FIN) — never block solely on it; always have a completion condition + a hard timeout.
- **Per-request `connect` (no reuse).** `connect(port)` returns the stream synchronously; drive writes from the `connect` event, never immediately. Convert `data` payloads defensively (`d instanceof Uint8Array ? d : new Uint8Array(d)`).
- **Latency:** python http.server cold-start until probe-open ~16 s (a property of `python3 -m http.server` on the emulated CPU, not the transport); TTFB 10 ms (warm) / 53–78 ms (cold); `tcp_probe(closed)` < 100 ms returns `false` (no hang). Poll generously for cold starts.
- **Port-watcher:** guest-side `/proc/net/tcp(6)` watch inside `guestd` (authoritative, complete, detects the 0.0.0.0-vs-127.0.0.1 distinction, cheap — one small periodic read over the existing hvc0 channel; no SYN storms). `/proc/net/tcp` columns: `local_address = HEXIP:HEXPORT` little-endian hex, `st` column `0A` = LISTEN. Spike-verified: `0.0.0.0` = `00000000`, `127.0.0.1` = `0100007F`, port 8000 = `1F40`. Derived, not spike-run: `192.168.86.100` = `6456A8C0`, port 9000 = `2328`.
- Verified re-bake delta: `bake-image.mjs` adds `net_device: { relay_url: "fetch", type: "virtio" }` to the V86 config + an `ip link set eth0 up; udhcpc -i eth0 -n -q` step before `save_state` (buildroot busybox already ships `udhcpc` v1.36.1 — no apk change). `v86-host.ts` adds the same `net_device` + `preserve_mac_from_state_image: true` + a `networkAdapter()` accessor. Bump the asset `version`.

## File Structure

```
packages/runtime-contract/           # UNCHANGED (Task 5 reuses the existing `resource.warning` event — no contract change this round)
packages/runtime-vm/
  scripts/bake-image.mjs             # MODIFY (Task 1): net_device + eth0/DHCP step; net note in state.meta.json
  src/v86-host.ts                    # MODIFY (Task 1): net_device + preserve_mac + networkAdapter(); NetworkAdapter/TcpConn types
  src/http-codec.ts                  # NEW (Task 2): serializeHttpRequest / parseHttpResponse / responseComplete (pure)
  src/http-codec.test.ts             # NEW (Task 2): pure unit coverage
  src/vm-runtime.ts                  # MODIFY (Task 3 dispatch; Task 5 port lifecycle + onPortEvent wiring)
  src/proc-net-parse.ts              # NEW (Task 4): parseListeningPorts (pure TS reference mirrored by guestd.py)
  src/proc-net-parse.test.ts         # NEW (Task 4): fixture-based unit coverage
  src/guest/guestd.py                # MODIFY (Task 4): /proc/net/tcp(6) watcher thread → "L" frames
  src/guestd-protocol.ts             # MODIFY (Task 4): FrameType.PORT_EVENT = "L"
  src/guestd-client.ts               # MODIFY (Task 4): parse "L" → onPortEvent(cb)
  src/guestd-client.test.ts          # MODIFY (Task 4): onPortEvent surfacing test
  src/vm-runtime.conformance.test.ts # MODIFY (Tasks 1/3/5): gated eth0/adapter/dispatch/port-event tests
  README.md                          # MODIFY (Task 8): networking/preview section
apps/web/
  src/lib/vm-assets.ts               # MODIFY (Tasks 1 & 4): bump version on each re-bake
  src/lib/run-serve.ts               # MODIFY (Task 6): capability-gated detached VM serve path + loopbackPorts/pid
  src/lib/run-serve.test.ts          # MODIFY (Task 6): fake gains getCapabilities; new VM-path tests
  src/lib/studio.ts                  # MODIFY (Task 6): subscribeRuntime handles resource.warning (system-log hint)
  src/components/PreviewPanel.tsx     # MODIFY (Task 6): kill-before-rerun (VM pid) + kill the tracked pid on Stop
  src/app-vm-preview.e2e.test.ts     # NEW (Task 7): gated app e2e wrapper
  scripts/app-vm-preview-e2e/run.mjs # NEW (Task 7): headless-Chromium preview driver
```

---

### Task 1: Networked image + v86-host restore path

Re-bake `state.zst` with a virtio NIC and a DHCP-addressed `eth0` frozen in the saved state, and give `V86Host` the `net_device` + `preserve_mac_from_state_image` restore options plus a `networkAdapter()` accessor for `VmRuntime.dispatch`. The bake output is not unit-tested (it needs network + ~1 min); the `v86-host.ts` change is verified by gated conformance.

**Files:**
- Modify: `packages/runtime-vm/scripts/bake-image.mjs` (V86 config `net_device`; eth0/DHCP step before `save_state`; net note in `state.meta.json`)
- Modify: `packages/runtime-vm/src/v86-host.ts` (`net_device` + `preserve_mac_from_state_image` boot opts; `NetworkAdapter`/`TcpConn` types; `networkAdapter()`)
- Modify: `apps/web/src/lib/vm-assets.ts` (bump `version`)
- Test: `packages/runtime-vm/src/vm-runtime.conformance.test.ts` (gated eth0 + networkAdapter checks)

**Interfaces:**
- Consumes: `V86BootInputs` (existing), `loadNodeInputs`/`defaultAssets` from `./node.js` (existing).
- Produces:
  - `interface TcpConn { on(event: "connect", cb: () => void): void; on(event: "data", cb: (data: Uint8Array) => void): void; on(event: "close", cb: () => void): void; write(bytes: Uint8Array): void }`
  - `interface NetworkAdapter { tcp_probe(port: number): Promise<boolean>; connect(port: number): TcpConn }`
  - `V86Host.networkAdapter(): NetworkAdapter` (returns `this.emulator.network_adapter`)

- [ ] **Step 1: Write the failing gated tests**

Append to `packages/runtime-vm/src/vm-runtime.conformance.test.ts` — add `V86Host` + `loadNodeInputs`/`defaultAssets` to the imports at the top (they are already partially imported: `loadNodeInputs`, `defaultAssets` come from `./node.js`; add `V86Host`), then add these two tests inside the existing `describe.skipIf(!RUN)("VmRuntime (gated e2e)", …)` block:

```ts
import { V86Host } from "./v86-host.js";

// (inside the existing describe.skipIf(!RUN) block)
it("restores the networked state cleanly: eth0 has 192.168.86.100", async () => {
  const rt = new VmRuntime(makeInputs);
  await rt.boot();
  const p = await rt.exec("ip -o addr show eth0");
  expect(await p.stdout.text()).toContain("192.168.86.100");
  await rt.shutdown();
});

it("V86Host.networkAdapter() is live after boot from the networked state", async () => {
  const host = new V86Host();
  await host.boot(await makeInputs(), { bootTimeoutMs: 30_000 });
  host.run();
  const net = host.networkAdapter();
  expect(net).toBeDefined();
  expect(typeof net.tcp_probe).toBe("function");
  expect(typeof net.connect).toBe("function");
  await host.destroy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && ERDOU_VM_E2E=1 pnpm vitest run src/vm-runtime.conformance.test.ts -t networkAdapter`
Expected: FAIL — `host.networkAdapter is not a function` (accessor not yet added). If the asset is not present the suite skips (no failure); re-bake first if so, but the point of this step is that the accessor is missing.

- [ ] **Step 3: Add the restore-path networking to `v86-host.ts`**

At the top of `packages/runtime-vm/src/v86-host.ts`, after the existing imports, add the network types:

```ts
/** v86's in-JS TCP stream from FetchNetworkAdapter.connect(). The handshake is
 *  async — always write from the "connect" event, never immediately. The "close"
 *  event is unreliable (may not fire on the guest FIN); never block solely on it. */
export interface TcpConn {
  on(event: "connect", cb: () => void): void;
  on(event: "data", cb: (data: Uint8Array) => void): void;
  on(event: "close", cb: () => void): void;
  write(bytes: Uint8Array): void;
}

/** v86's FetchNetworkAdapter (in-JS NAT). Addressing is hard-coded at
 *  construction (router_ip=192.168.86.1, vm_ip=192.168.86.100); connect/probe
 *  target the guest regardless of DHCP history. */
export interface NetworkAdapter {
  tcp_probe(port: number): Promise<boolean>;
  connect(port: number): TcpConn;
}
```

In `boot()`, extend the `opt` object literal — add these two properties alongside the existing ones (e.g. after `virtio_console: true,`):

```ts
      // Networking (Round 12): a virtio NIC + v86's in-JS fetch-NAT. The NIC MUST
      // be present in the baked state (adding it only at restore crashes v86's
      // per-device set_state). preserve_mac_from_state_image re-teaches the freshly
      // constructed adapter the guest MAC on restore — WITHOUT it every
      // connect/tcp_probe hangs forever (verified spike).
      net_device: { relay_url: "fetch", type: "virtio" },
      preserve_mac_from_state_image: true,
```

Add the accessor method to the `V86Host` class (e.g. after `serial()`):

```ts
  /** v86's in-JS network adapter, for VmRuntime.dispatch's reverse-proxy into a
   *  real guest server. Available after boot(). */
  networkAdapter(): NetworkAdapter {
    return this.emulator.network_adapter as NetworkAdapter;
  }
```

- [ ] **Step 4: Add networking to `bake-image.mjs`**

In `packages/runtime-vm/scripts/bake-image.mjs`, in the `new V86({ … })` config (the object with `wasm_path`/`bios`/… around line 48-59), add `net_device` after `virtio_console: true,`:

```js
  net_device: { relay_url: "fetch", type: "virtio" }, // Round 12: virtio NIC baked into the saved device set
```

After the `LAUNCH_GUESTD_CMD` line (`await sh(LAUNCH_GUESTD_CMD, "GDLAUNCHED"); …`) and before the `await new Promise((r) => setTimeout(r, 1500));`, add the eth0 bring-up + DHCP step:

```js
  // 4.5/6 bring eth0 up + DHCP so the saved state boots with 192.168.86.100
  // already assigned (buildroot busybox ships udhcpc — no apk change). The
  // marker string is real command output, not appended text (quote-split like
  // the other markers so the tty echo can't self-match it).
  await sh("ip link set eth0 up; udhcpc -i eth0 -n -q 2>&1; ip -o addr show eth0 2>&1; echo NETU''P", "NETUP", 30000);
  console.log("  marker: NETUP (eth0 up + DHCP lease 192.168.86.100)");
```

In the `state.meta.json` write (the `JSON.stringify({ rawBytes, compressedBytes, alpine: ver, codec: "gzip" }, …)`), add a `net: true` field so the manifest records that this state is networked:

```js
  fs.writeFileSync(path.join(assets, "state.meta.json"), JSON.stringify({ rawBytes: state.length, compressedBytes: compressed.length, alpine: ver, codec: "gzip", net: true }, null, 2));
```

- [ ] **Step 5: Bump the asset version**

In `apps/web/src/lib/vm-assets.ts`, change the `version` string so IndexedDB-cached clients re-fetch the networked state:

```ts
  return { baseUrl: "/vm-assets", wasmUrl, version: "alpine-3.24.1-r12-net" };
```

- [ ] **Step 6: Re-bake the networked state**

Run: `cd /home/yzl/Erdou && rm -f packages/runtime-vm/assets/state.bin && pnpm --filter @erdou/runtime-vm bake`
Expected: bake logs reach `marker: NETUP (eth0 up + DHCP lease 192.168.86.100)` and `done: state … bytes (assets/state.zst)`. The new `assets/state.zst` is a gitignored build artifact — do NOT commit it.

- [ ] **Step 7: Run the gated tests to verify they pass**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && ERDOU_VM_E2E=1 pnpm vitest run src/vm-runtime.conformance.test.ts`
Expected: PASS — the two new tests plus the existing 25 conformance tests are green (the networked state restores cleanly, eth0 shows 192.168.86.100, and `networkAdapter()` returns a live adapter).

- [ ] **Step 8: Commit**

```bash
git add packages/runtime-vm/scripts/bake-image.mjs packages/runtime-vm/src/v86-host.ts packages/runtime-vm/src/vm-runtime.conformance.test.ts apps/web/src/lib/vm-assets.ts
git commit -m "feat(vm): networked baked state + V86Host.networkAdapter() (net_device + preserve_mac restore)"
```

---

### Task 2: HTTP/1.1 codec (pure, unit-tested)

A pure request-serializer + response-parser with no VM dependency, so `VmRuntime.dispatch` can turn a contract `HttpRequest` into wire bytes and the raw response bytes back into an `HttpResponse`. Includes `responseComplete` — the read-loop's completion detector — because it is the codec's concern (find the end of a response) and belongs beside the parser for DRY + unit coverage.

**Files:**
- Create: `packages/runtime-vm/src/http-codec.ts`
- Test: `packages/runtime-vm/src/http-codec.test.ts`

**Interfaces:**
- Consumes: `HttpRequest`, `HttpResponse` from `@erdou/runtime-contract`.
- Produces:
  - `serializeHttpRequest(req: HttpRequest): Uint8Array` — request line `METHOD url HTTP/1.1`, a `Host:` header if absent, forced `Connection: close`, the request headers (minus any incoming `connection`), a blank line, then the body.
  - `parseHttpResponse(bytes: Uint8Array): HttpResponse` — status line → status number; headers (lowercased keys); body via Content-Length if present, else chunked-decoded to the `0\r\n\r\n` terminator, else the remainder.
  - `responseComplete(bytes: Uint8Array): boolean` — true once headers are terminated AND (Content-Length satisfied OR chunked terminator seen); false when there is no length info (caller falls back to idle/close).

- [ ] **Step 1: Write the failing test**

Create `packages/runtime-vm/src/http-codec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { HttpRequest } from "@erdou/runtime-contract";
import { serializeHttpRequest, parseHttpResponse, responseComplete } from "./http-codec.js";

const dec = new TextDecoder();
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("serializeHttpRequest", () => {
  it("emits a request line, a synthesized Host, forced Connection: close, headers, and body", () => {
    const req: HttpRequest = {
      method: "post",
      url: "/api?q=1",
      headers: { "content-type": "application/json", connection: "keep-alive" },
      body: bytes("{}"),
    };
    const out = dec.decode(serializeHttpRequest(req));
    expect(out).toBe(
      "POST /api?q=1 HTTP/1.1\r\n" +
        "Host: erdou.local\r\n" +
        "content-type: application/json\r\n" +
        "Connection: close\r\n" +
        "\r\n" +
        "{}",
    );
  });

  it("keeps a caller-supplied Host and omits the synthesized one", () => {
    const req: HttpRequest = { method: "GET", url: "/", headers: { Host: "example.com" }, body: new Uint8Array() };
    const out = dec.decode(serializeHttpRequest(req));
    expect(out).toContain("Host: example.com\r\n");
    expect(out).not.toContain("Host: erdou.local");
  });
});

describe("parseHttpResponse", () => {
  it("parses a Content-Length response", () => {
    const res = parseHttpResponse(bytes("HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello"));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(dec.decode(res.body)).toBe("hello");
  });

  it("decodes a chunked response to its concatenated body", () => {
    const res = parseHttpResponse(bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"));
    expect(res.status).toBe(200);
    expect(dec.decode(res.body)).toBe("hello world");
  });

  it("parses a headers-only 204 with an empty body", () => {
    const res = parseHttpResponse(bytes("HTTP/1.1 204 No Content\r\n\r\n"));
    expect(res.status).toBe(204);
    expect(res.body.length).toBe(0);
  });
});

describe("responseComplete", () => {
  it("is false before the header terminator", () => {
    expect(responseComplete(bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n"))).toBe(false);
  });
  it("is false until Content-Length bytes have all arrived, then true", () => {
    expect(responseComplete(bytes("HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhel"))).toBe(false);
    expect(responseComplete(bytes("HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhello"))).toBe(true);
  });
  it("is true once the chunked terminator is present", () => {
    expect(responseComplete(bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n"))).toBe(false);
    expect(responseComplete(bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && pnpm vitest run src/http-codec.test.ts`
Expected: FAIL — cannot find module `./http-codec.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/runtime-vm/src/http-codec.ts`:

```ts
import type { HttpRequest, HttpResponse } from "@erdou/runtime-contract";

const CR = 13;
const LF = 10;

/** Byte-exact latin1 decode — safe for HTTP header/chunk-size text (ASCII) and
 *  never mangles a byte the way a UTF-8 decode would mid-multibyte. */
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Index of the first CRLFCRLF (header/body separator), or -1. */
function headerEnd(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === CR && b[i + 1] === LF && b[i + 2] === CR && b[i + 3] === LF) return i;
  }
  return -1;
}

function parseHeaderLines(headText: string): { status: number; headers: Record<string, string> } {
  const lines = headText.split("\r\n");
  const statusLine = lines[0] ?? "";
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  if (!m) throw new Error(`parseHttpResponse: bad status line ${JSON.stringify(statusLine)}`);
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status: Number(m[1]), headers };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Decode a Transfer-Encoding: chunked body (from just past the headers). Stops
 *  at the `0\r\n\r\n` terminator or when the buffer runs out. */
function dechunk(b: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let off = 0;
  while (off < b.length) {
    let eol = -1;
    for (let i = off; i + 1 < b.length; i++) {
      if (b[i] === CR && b[i + 1] === LF) { eol = i; break; }
    }
    if (eol === -1) break;
    const size = parseInt((latin1(b.subarray(off, eol)).split(";")[0] ?? "").trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break; // 0 => terminator (or garbage)
    const dataStart = eol + 2;
    const dataEnd = dataStart + size;
    if (dataEnd > b.length) { chunks.push(b.subarray(dataStart)); break; }
    chunks.push(b.subarray(dataStart, dataEnd));
    off = dataEnd + 2; // skip the CRLF after the chunk data
  }
  return concat(chunks);
}

/** Serialize a contract HttpRequest to HTTP/1.1 wire bytes. Forces
 *  `Connection: close` (per-request connections) and synthesizes a Host header
 *  if the caller supplied none. */
export function serializeHttpRequest(req: HttpRequest): Uint8Array {
  const method = req.method.toUpperCase();
  const entries = Object.entries(req.headers);
  const hasHost = entries.some(([k]) => k.toLowerCase() === "host");
  const lines = [`${method} ${req.url} HTTP/1.1`];
  if (!hasHost) lines.push("Host: erdou.local");
  for (const [k, v] of entries) {
    if (k.toLowerCase() === "connection") continue; // forced below
    lines.push(`${k}: ${v}`);
  }
  lines.push("Connection: close");
  const head = new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n");
  const body = req.body ?? new Uint8Array();
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** Parse raw HTTP response bytes into a contract HttpResponse. */
export function parseHttpResponse(bytes: Uint8Array): HttpResponse {
  const sep = headerEnd(bytes);
  if (sep === -1) throw new Error("parseHttpResponse: no header/body separator (CRLFCRLF)");
  const { status, headers } = parseHeaderLines(latin1(bytes.subarray(0, sep)));
  const rest = bytes.subarray(sep + 4);
  const cl = headers["content-length"];
  const te = (headers["transfer-encoding"] ?? "").toLowerCase();
  let body: Uint8Array;
  if (cl !== undefined) {
    const n = Number(cl);
    body = rest.subarray(0, Number.isFinite(n) ? n : rest.length);
  } else if (te.includes("chunked")) {
    body = dechunk(rest);
  } else {
    body = rest;
  }
  return { status, headers, body };
}

/** True once the accumulated bytes are a complete response by a self-describing
 *  rule (Content-Length satisfied OR chunked terminator seen). False when there
 *  is no length info — the caller then completes on idle/close. */
export function responseComplete(bytes: Uint8Array): boolean {
  const sep = headerEnd(bytes);
  if (sep === -1) return false;
  const { headers } = parseHeaderLines(latin1(bytes.subarray(0, sep)));
  const bodyLen = bytes.length - (sep + 4);
  const cl = headers["content-length"];
  if (cl !== undefined) return bodyLen >= Number(cl);
  if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
    // terminator: CRLF "0" CRLF CRLF anywhere after the headers. Known
    // simplification: a raw substring match, not a real chunk-boundary walk —
    // acceptable because python http.server (the only server this round
    // targets) uses Content-Length, never chunked encoding.
    return latin1(bytes.subarray(sep + 4)).includes("0\r\n\r\n");
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && pnpm vitest run src/http-codec.test.ts`
Expected: PASS — all serialize/parse/complete cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-vm/src/http-codec.ts packages/runtime-vm/src/http-codec.test.ts
git commit -m "feat(vm): pure HTTP/1.1 codec (serialize request, parse response, completion detector)"
```

---

### Task 3: `VmRuntime.dispatch` → real guest

Replace the page-side `PortRegistry`-stub dispatch (which always 502s for the VM) with the spike recipe: probe-first, else per-request `connect`, write the serialized request on `connect`, accumulate `data` chunks (converted defensively), and finish on Content-Length/chunked-complete OR a 600ms idle timer OR `close` OR a 15s hard cap → parse. `listen`/`exposePort`/`closePort` still go through `this.ports` (PortRegistry) for now — Task 5 replaces those.

**Files:**
- Modify: `packages/runtime-vm/src/vm-runtime.ts` (replace `dispatch`; add codec + host-adapter helpers)
- Test: `packages/runtime-vm/src/vm-runtime.conformance.test.ts` (gated dispatch test)

**Interfaces:**
- Consumes: `V86Host.networkAdapter(): NetworkAdapter` / `TcpConn` (Task 1); `serializeHttpRequest`, `parseHttpResponse`, `responseComplete` (Task 2).
- Produces: `VmRuntime.dispatch(port: number, req: HttpRequest): Promise<HttpResponse>` — real reverse-proxy into the guest (502 on an unbound/loopback-only port; 504 on a hard-cap timeout with no bytes).

- [ ] **Step 1: Write the failing gated test**

Append inside the existing `describe.skipIf(!RUN)("VmRuntime (gated e2e)", …)` block in `packages/runtime-vm/src/vm-runtime.conformance.test.ts`:

```ts
it("dispatch reverse-proxies to a real guest HTTP server bound to 0.0.0.0", async () => {
  const rt = new VmRuntime(makeInputs);
  await rt.boot();
  await rt.writeFile("/index.html", "hello-from-guest-dispatch");
  // Detached: exec resolves on process START; the server binds after cold-start.
  await rt.exec("python3 -m http.server 8000 --bind 0.0.0.0");
  const get = () => rt.dispatch(8000, { method: "GET", url: "/index.html", headers: {}, body: new Uint8Array() });
  let ok: import("@erdou/runtime-contract").HttpResponse | undefined;
  const deadline = Date.now() + 40_000; // python cold-start ~16s — poll generously
  while (Date.now() < deadline) {
    const r = await get();
    if (r.status === 200) { ok = r; break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  expect(ok).toBeDefined();
  expect(new TextDecoder().decode(ok!.body)).toContain("hello-from-guest-dispatch");
  // A closed port probes false → 502, no hang.
  const closed = await rt.dispatch(9999, { method: "GET", url: "/", headers: {}, body: new Uint8Array() });
  expect(closed.status).toBe(502);
  await rt.shutdown();
}, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && ERDOU_VM_E2E=1 pnpm vitest run src/vm-runtime.conformance.test.ts -t "reverse-proxies"`
Expected: FAIL — dispatch returns 502 for port 8000 too (the current `PortRegistry` stub has no handler), so `ok` is never defined.

- [ ] **Step 3: Implement the real dispatch in `vm-runtime.ts`**

Add the codec import near the top of `packages/runtime-vm/src/vm-runtime.ts` (after the existing imports):

```ts
import { serializeHttpRequest, parseHttpResponse, responseComplete } from "./http-codec.js";
```

Replace the existing `dispatch` method:

```ts
  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> { return this.ports.dispatch(port, req); }
```

with the real reverse-proxy:

```ts
  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> {
    const net = this.host.networkAdapter();
    // Probe-first: fast + reliable (mac fix). A closed OR loopback-only bind
    // probes false → a real 502, never a hang.
    if (!(await net.tcp_probe(port))) {
      return { status: 502, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(`No server listening on port ${port}`) };
    }
    const raw = serializeHttpRequest(req);
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const conn = net.connect(port);
      const chunks: Uint8Array[] = [];
      let idle: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const acc = (): Uint8Array => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
      };
      const finish = (): void => {
        if (done) return;
        done = true;
        if (idle) clearTimeout(idle);
        clearTimeout(hard);
        resolve(acc());
      };
      // Hard cap: never hang forever if the guest wedges mid-response.
      const hard = setTimeout(finish, 15_000);
      conn.on("connect", () => conn.write(raw));
      conn.on("data", (d) => {
        chunks.push(d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBufferLike));
        if (responseComplete(acc())) { finish(); return; }
        if (idle) clearTimeout(idle);
        idle = setTimeout(finish, 600); // idle fallback for keep-alive servers with no length info
      });
      conn.on("close", finish); // unreliable — a backstop, not the primary condition
    });
    if (bytes.length === 0) {
      return { status: 504, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(`No response from port ${port}`) };
    }
    return parseHttpResponse(bytes);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && ERDOU_VM_E2E=1 pnpm vitest run src/vm-runtime.conformance.test.ts -t "reverse-proxies"`
Expected: PASS — the guest's real body (`hello-from-guest-dispatch`) round-trips and the closed port returns 502.

- [ ] **Step 5: Run typecheck + the hermetic suite**

Run: `cd /home/yzl/Erdou && pnpm --filter @erdou/runtime-vm typecheck && pnpm vitest run packages/runtime-vm`
Expected: typecheck clean; `pnpm test` green with the gated suites skipped.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-vm/src/vm-runtime.ts packages/runtime-vm/src/vm-runtime.conformance.test.ts
git commit -m "feat(vm): real VmRuntime.dispatch reverse-proxy into the guest via networkAdapter + http-codec"
```

---

### Task 4: guestd port watcher

Add a daemon thread in `guestd.py` that polls `/proc/net/tcp` and `/proc/net/tcp6`, extracts LISTEN sockets, classifies each as reachable (0.0.0.0 / eth0 IP) vs loopback-only, diffs against the last set, and pushes `"L"` port-event frames over hvc0. Add the frame type; parse it in `guestd-client` and surface it via `onPortEvent`. A pure TS `parseListeningPorts` mirrors the Python parse for unit coverage (the tricky little-endian hex logic), and `guestd-client`'s surfacing is unit-tested with a fake channel. The Python watcher itself is covered by the gated conformance in Task 5.

**Files:**
- Create: `packages/runtime-vm/src/proc-net-parse.ts` + `packages/runtime-vm/src/proc-net-parse.test.ts`
- Modify: `packages/runtime-vm/src/guestd-protocol.ts` (`FrameType.PORT_EVENT = "L"`)
- Modify: `packages/runtime-vm/src/guestd-client.ts` (parse `"L"` → `onPortEvent`)
- Modify: `packages/runtime-vm/src/guestd-client.test.ts` (surfacing test)
- Modify: `packages/runtime-vm/src/guest/guestd.py` (watcher thread mirroring `parseListeningPorts`)

**Interfaces:**
- Produces:
  - `interface ListeningPort { port: number; loopback: boolean }`
  - `parseListeningPorts(procText: string, opts?: { eth0Hex?: string }): ListeningPort[]` (pure; dedup by port, reachable wins over loopback)
  - `FrameType.PORT_EVENT = "L"`
  - `GuestdClient.onPortEvent(cb: (e: { port: number; listening: boolean; loopback: boolean }) => void): void`

- [ ] **Step 1: Write the failing tests**

Create `packages/runtime-vm/src/proc-net-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseListeningPorts } from "./proc-net-parse.js";

// Real /proc/net/tcp shape: sl local_address rem_address st … (st 0A = LISTEN).
const FIXTURE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000 100 0 0 10 0", // 0.0.0.0:8000 LISTEN
  "   1: 0100007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000 100 0 0 10 0", // 127.0.0.1:9000 LISTEN
  "   2: 0100007F:0050 0100007F:C001 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000 100 0 0 10 0", // 127.0.0.1:80 ESTABLISHED (not LISTEN)
].join("\n");

describe("parseListeningPorts", () => {
  it("extracts reachable and loopback LISTEN ports and skips non-LISTEN rows", () => {
    const ports = parseListeningPorts(FIXTURE);
    expect(ports).toEqual([
      { port: 8000, loopback: false },
      { port: 9000, loopback: true },
    ]);
  });

  it("treats the eth0 IP (192.168.86.100 = 6456A8C0) as reachable", () => {
    const line = "   0: 6456A8C0:1F90 00000000:0000 0A 0 0 0 0 0 0 0 0 999 1 0 100 0 0 10 0";
    expect(parseListeningPorts(line)).toEqual([{ port: 8080, loopback: false }]);
  });

  it("a port listening on both 0.0.0.0 and 127.0.0.1 is reachable (reachable wins)", () => {
    const both = [
      "   0: 0100007F:1F40 00000000:0000 0A 0 0 0 0 0 0 0 0 1 1 0 100 0 0 10 0",
      "   1: 00000000:1F40 00000000:0000 0A 0 0 0 0 0 0 0 0 2 1 0 100 0 0 10 0",
    ].join("\n");
    expect(parseListeningPorts(both)).toEqual([{ port: 8000, loopback: false }]);
  });
});
```

Append to `packages/runtime-vm/src/guestd-client.test.ts` (inside the existing `describe("GuestdClient", …)` block):

```ts
it("surfaces an unsolicited port-event (L) frame via onPortEvent", () => {
  let push: (b: Uint8Array) => void = () => {};
  const channel: GuestChannel = { send() {}, subscribe(cb) { push = cb; } };
  const client = new GuestdClient(channel);
  const events: Array<{ port: number; listening: boolean; loopback: boolean }> = [];
  client.onPortEvent((e) => events.push(e));
  push(encodeJsonFrame(FrameType.PORT_EVENT, 0, { port: 8000, listening: true, loopback: false }));
  push(encodeJsonFrame(FrameType.PORT_EVENT, 0, { port: 8000, listening: false, loopback: false }));
  expect(events).toEqual([
    { port: 8000, listening: true, loopback: false },
    { port: 8000, listening: false, loopback: false },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && pnpm vitest run src/proc-net-parse.test.ts src/guestd-client.test.ts`
Expected: FAIL — `./proc-net-parse.js` not found; `FrameType.PORT_EVENT` undefined; `client.onPortEvent` is not a function.

- [ ] **Step 3: Implement the pure parser**

Create `packages/runtime-vm/src/proc-net-parse.ts`:

```ts
/**
 * Pure `/proc/net/tcp(6)` LISTEN-socket parser. This is the TS reference of the
 * exact algorithm `guestd.py`'s port watcher runs (Python can't import TS) — the
 * two MUST stay in sync (precedent: preview-bridge.ts ↔ preview-sw.js). Unit-
 * testing it here pins the fiddly little-endian hex logic without a VM boot.
 *
 * Columns are whitespace-separated: `sl local_address rem_address st …`.
 * local_address is `HEXIP:HEXPORT` (little-endian hex); st `0A` = LISTEN.
 * Reachable (previewable) IPs: 0.0.0.0 (00000000), :: (all-zero v6), or the
 * eth0 IP (192.168.86.100 = 6456A8C0). Everything else (127.0.0.1 = 0100007F,
 * ::1, a specific non-eth0 IP) is loopback-only / not previewable.
 */
export interface ListeningPort {
  port: number;
  loopback: boolean;
}

const V4_ANY = "00000000";
const V6_ANY = "00000000000000000000000000000000";
const DEFAULT_ETH0_HEX = "6456A8C0"; // 192.168.86.100 little-endian

export function parseListeningPorts(procText: string, opts: { eth0Hex?: string } = {}): ListeningPort[] {
  const eth0 = (opts.eth0Hex ?? DEFAULT_ETH0_HEX).toUpperCase();
  const byPort = new Map<number, boolean>(); // port -> loopback (false wins)
  for (const line of procText.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== "0A") continue; // not a LISTEN row
    const local = cols[1] ?? "";
    const colon = local.indexOf(":");
    if (colon === -1) continue;
    const ip = local.slice(0, colon).toUpperCase();
    const port = parseInt(local.slice(colon + 1), 16);
    if (!Number.isFinite(port) || port <= 0) continue;
    const reachable = ip === V4_ANY || ip === V6_ANY || ip === eth0;
    const loopback = !reachable;
    const prev = byPort.get(port);
    byPort.set(port, prev === undefined ? loopback : prev && loopback);
  }
  return [...byPort.entries()]
    .map(([port, loopback]) => ({ port, loopback }))
    .sort((a, b) => a.port - b.port);
}
```

- [ ] **Step 4: Add the frame type + guestd-client surfacing**

In `packages/runtime-vm/src/guestd-protocol.ts`, add `PORT_EVENT: "L"` to the `FrameType` map:

```ts
export const FrameType = {
  READY: "R", STARTED: "S", STDOUT: "O", STDERR: "E", EXIT: "X", PROCS: "P", ERROR: "!",
  EXEC: "x", SPAWN: "s", KILL: "k", PS: "p", PING: "i", PTY_OPEN: "t", PTY_OPENED: "T",
  PORT_EVENT: "L",
} as const;
```

In `packages/runtime-vm/src/guestd-client.ts`, add the callback field + accessor to the `GuestdClient` class (e.g. beside `readyResolve`):

```ts
  private portEventCb?: (e: { port: number; listening: boolean; loopback: boolean }) => void;

  /** Register a listener for unsolicited guest port events (from the guestd
   *  /proc/net/tcp watcher). Idempotent-set: the latest callback wins. */
  onPortEvent(cb: (e: { port: number; listening: boolean; loopback: boolean }) => void): void {
    this.portEventCb = cb;
  }
```

In `onFrame`, add a branch immediately after the `READY` branch (before the `control`/`pending` lookups), so the unsolicited id-0 frame is routed:

```ts
    if (type === FrameType.PORT_EVENT) {
      this.portEventCb?.(decodeJson(body) as { port: number; listening: boolean; loopback: boolean });
      return;
    }
```

- [ ] **Step 5: Add the watcher thread to `guestd.py`**

In `packages/runtime-vm/src/guest/guestd.py`, add the parser + watcher above the final `send_json("R", 0, {"pid": os.getpid()})` line (after the `list_procs` definition). This mirrors `parseListeningPorts` exactly:

```python
# --- port watcher: mirror of src/proc-net-parse.ts (keep in sync) ---
_V4_ANY = "00000000"
_V6_ANY = "00000000000000000000000000000000"
_ETH0_HEX = "6456A8C0"  # 192.168.86.100 little-endian

def _parse_listening(text):
    out = {}
    for line in text.split("\n"):
        cols = line.split()
        if len(cols) < 4 or cols[3] != "0A":
            continue
        local = cols[1]
        if ":" not in local:
            continue
        iphex, porthex = local.split(":", 1)
        try:
            port = int(porthex, 16)
        except ValueError:
            continue
        if port <= 0:
            continue
        ip = iphex.upper()
        reachable = ip in (_V4_ANY, _V6_ANY, _ETH0_HEX)
        loop = not reachable
        prev = out.get(port)
        out[port] = loop if prev is None else (prev and loop)
    return out

def port_watcher():
    last = {}
    while True:
        cur = {}
        for path in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                with open(path) as f:
                    text = f.read()
            except OSError:
                continue
            for port, loop in _parse_listening(text).items():
                prev = cur.get(port)
                cur[port] = loop if prev is None else (prev and loop)
        for port, loop in cur.items():
            if port not in last or last[port] != loop:
                send_json("L", 0, {"port": port, "listening": True, "loopback": loop})
        for port, loop in last.items():
            if port not in cur:
                send_json("L", 0, {"port": port, "listening": False, "loopback": loop})
        last = cur
        time.sleep(0.5)

threading.Thread(target=port_watcher, daemon=True).start()
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && pnpm vitest run src/proc-net-parse.test.ts src/guestd-client.test.ts src/guestd-protocol.test.ts`
Expected: PASS — parser fixtures, the onPortEvent surfacing, and the existing protocol/client tests are green.

- [ ] **Step 7: Re-bake so the new `guestd.py` rides in the saved state, and bump the version**

The watcher lives in `guestd.py`, which is baked into `state.zst` (frozen in the resident guestd process at `save_state`), so the guest-side watcher only exists after a re-bake. In `apps/web/src/lib/vm-assets.ts` bump the version again:

```ts
  return { baseUrl: "/vm-assets", wasmUrl, version: "alpine-3.24.1-r12-net-watch" };
```

Run: `cd /home/yzl/Erdou && rm -f packages/runtime-vm/assets/state.bin && pnpm --filter @erdou/runtime-vm bake`
Expected: bake completes with `marker: NETUP …` and `done: state …`. The re-baked `state.zst` (with the watcher-enabled guestd) is gitignored — do NOT commit it.

- [ ] **Step 8: Commit**

```bash
git add packages/runtime-vm/src/proc-net-parse.ts packages/runtime-vm/src/proc-net-parse.test.ts packages/runtime-vm/src/guestd-protocol.ts packages/runtime-vm/src/guestd-client.ts packages/runtime-vm/src/guestd-client.test.ts packages/runtime-vm/src/guest/guestd.py apps/web/src/lib/vm-assets.ts
git commit -m "feat(vm): guestd /proc/net/tcp port watcher → L frames + onPortEvent; pure parseListeningPorts"
```

---

### Task 5: VmRuntime port events + exposePort/closePort

Wire `guestd.onPortEvent` into `VmRuntime`: a `listening && !loopback` event emits `port.opened { port, url: "/__port__/<port>/" }` (idempotent per port); `!listening` emits `port.closed { port }` (only if previously opened); `listening && loopback` emits the EXISTING contract `resource.warning { resource: "port:" + port; detail }` event (visible, not previewable — the "bind 0.0.0.0" hint; no new contract event this round). Replace the `PortRegistry` stub for `listen`/`exposePort`/`closePort` with a Set-backed lifecycle so the auto-detected and manual paths can't double-emit.

**Files:**
- Modify: `packages/runtime-vm/src/vm-runtime.ts` (Set-backed port lifecycle + `onPortEvent` registration; drop `PortRegistry`)
- Test: `packages/runtime-vm/src/vm-runtime.conformance.test.ts` (gated port-event tests)

(No `packages/runtime-contract` changes this round — the loopback hint reuses the existing `resource.warning` event; see Global Constraints / File Structure.)

**Interfaces:**
- Consumes: `GuestdClient.onPortEvent` (Task 4).
- Produces: the VM emits real `{ type: "port.opened"; port; url }` / `{ type: "port.closed"; port }` (both already in the contract) plus the EXISTING `{ type: "resource.warning"; resource; detail }` event for a loopback-only bind — NOT a new contract event.

- [ ] **Step 1: Write the failing gated port-event tests**

Append inside `describe.skipIf(!RUN)("VmRuntime (gated e2e)", …)` in `packages/runtime-vm/src/vm-runtime.conformance.test.ts`. Add a `RuntimeEvent` type import if not present (`import type { RuntimeEvent } from "@erdou/runtime-contract";`):

```ts
const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor: condition not met within ${ms}ms`);
};

it("emits port.opened for a 0.0.0.0 guest server and port.closed when it dies", async () => {
  const rt = new VmRuntime(makeInputs);
  await rt.boot();
  const events: RuntimeEvent[] = [];
  rt.subscribe((e) => events.push(e));
  const server = await rt.exec("python3 -m http.server 8000 --bind 0.0.0.0");
  await waitFor(() => events.some((e) => e.type === "port.opened" && e.port === 8000), 40_000);
  const opened = events.find((e) => e.type === "port.opened" && e.port === 8000);
  expect(opened && opened.type === "port.opened" && opened.url).toBe("/__port__/8000/");
  await rt.kill(server.pid, "SIGKILL");
  await waitFor(() => events.some((e) => e.type === "port.closed" && e.port === 8000), 15_000);
  await rt.shutdown();
}, 70_000);

it("does NOT emit port.opened for a 127.0.0.1-only server (emits resource.warning)", async () => {
  const rt = new VmRuntime(makeInputs);
  await rt.boot();
  const events: RuntimeEvent[] = [];
  rt.subscribe((e) => events.push(e));
  await rt.exec("python3 -m http.server 8001 --bind 127.0.0.1");
  await waitFor(() => events.some((e) => e.type === "resource.warning" && e.resource === "port:8001"), 40_000);
  expect(events.some((e) => e.type === "port.opened" && e.port === 8001)).toBe(false);
  await rt.shutdown();
}, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && ERDOU_VM_E2E=1 pnpm vitest run src/vm-runtime.conformance.test.ts -t "port.opened for a 0.0.0.0"`
Expected: FAIL — no `port.opened` fires because `VmRuntime` does not yet register `onPortEvent` (no contract change needed this round — `port.opened`/`port.closed` and `resource.warning` already exist in `packages/runtime-contract/src/events.ts`).

- [ ] **Step 3: Replace the port lifecycle in `vm-runtime.ts`**

Remove the `PortRegistry` import and the `private ports!: PortRegistry;` field. Delete the `import { PortRegistry } from "./port-registry.js";` line.

In `boot()`, remove `this.ports = new PortRegistry((e) => this.emit(e));` and register the port-event listener right after constructing `guestd`:

```ts
    this.guestd = new GuestdClient(this.host.channel());
    this.guestd.onPortEvent((e) => this.onGuestPortEvent(e));
    await this.guestd.ready({ deadlineMs: this.bootTimeoutMs ?? 60_000 });
```

Replace the whole `// ---- ports … ----` block (the `listen`/`exposePort`/`closePort` methods; `dispatch` stays as implemented in Task 3) with the Set-backed lifecycle. Add the two fields near the other private fields:

```ts
  /** Ports currently reachable+listening (idempotent emit tracking). */
  private readonly openPorts = new Set<number>();
  /** Ports bound loopback-only (not previewable) — tracked so we emit the hint once. */
  private readonly loopbackPorts = new Set<number>();
```

And the methods:

```ts
  // ---- ports (real guest proxy; Round 12) ----
  private emitOpened(port: number): void {
    this.loopbackPorts.delete(port);
    if (this.openPorts.has(port)) return;
    this.openPorts.add(port);
    this.emit({ type: "port.opened", port, url: `/__port__/${port}/` });
  }
  private emitClosed(port: number): void {
    this.loopbackPorts.delete(port);
    if (!this.openPorts.delete(port)) return;
    this.emit({ type: "port.closed", port });
  }
  private emitLoopback(port: number): void {
    if (this.openPorts.has(port) || this.loopbackPorts.has(port)) return;
    this.loopbackPorts.add(port);
    this.emit({
      type: "resource.warning",
      resource: `port:${port}`,
      detail: `Server on port ${port} is bound to loopback (127.0.0.1) — bind 0.0.0.0 to make it previewable.`,
    });
  }
  /** guestd /proc/net/tcp watcher → runtime bus. Reachable listen → opened;
   *  gone → closed; loopback-only listen → a visible "bind 0.0.0.0" hint. */
  private onGuestPortEvent(e: { port: number; listening: boolean; loopback: boolean }): void {
    if (!e.listening) { this.emitClosed(e.port); return; }
    if (e.loopback) this.emitLoopback(e.port);
    else this.emitOpened(e.port);
  }

  async listen(port: number): Promise<VirtualPort> {
    this.emitOpened(port);
    return { port, close: async () => this.emitClosed(port) };
  }
  async exposePort(port: number): Promise<string> {
    this.emitOpened(port);
    return `/__port__/${port}/`;
  }
  async closePort(port: number): Promise<void> { this.emitClosed(port); }
```

(Leave `port-registry.ts` and its test in place — `VmRuntime` no longer imports it, but removal is out of scope; the browser kernel uses its own separate `packages/runtime-browser/src/port/registry.ts`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/yzl/Erdou/packages/runtime-vm && ERDOU_VM_E2E=1 pnpm vitest run src/vm-runtime.conformance.test.ts && cd /home/yzl/Erdou && pnpm --filter @erdou/runtime-vm typecheck`
Expected: PASS — `port.opened` fires with `/__port__/8000/`, `port.closed` fires on kill, a loopback-only server emits `resource.warning` and NOT `port.opened`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-vm/src/vm-runtime.ts packages/runtime-vm/src/vm-runtime.conformance.test.ts
git commit -m "feat(vm): emit real port.opened/closed from the guestd port watcher + loopback resource.warning hint"
```

---

### Task 6: App serve flow — detached spawn + await port.opened (capability-gated)

For a real-OS runtime a serve command (`python app.py`, `python3 -m http.server`) blocks forever, so the serve/preview flow must start it DETACHED (not exec-and-wait) and resolve on `port.opened`. Make `runServeCommand` capability-gated on `getCapabilities().realOs` (browser=false, VM=true), surface a loopback-bind hint, and — so a live re-run doesn't hit a still-bound guest socket — return the detached server's pid and kill it before re-serving. Do NOT regress the browser-kernel preview.

**Files:**
- Modify: `apps/web/src/lib/run-serve.ts` (capability-gated detached path; `loopbackPorts` + `pid` on the result)
- Modify: `apps/web/src/lib/run-serve.test.ts` (fake gains `getCapabilities`; new VM-path tests)
- Modify: `apps/web/src/lib/studio.ts` (`subscribeRuntime` handles `resource.warning` → system-log hint)
- Modify: `apps/web/src/components/PreviewPanel.tsx` (kill-before-rerun for the VM pid; kill the tracked pid on Stop too)

**Interfaces:**
- Consumes: `Runtime.getCapabilities`/`subscribe`/`exec`/`kill` (contract); `resource.warning` (existing contract event, reused per Task 5 — no new contract member).
- Produces: `runServeCommand(runtime, shell, commandLine): Promise<RunServeResult>` where `RunServeResult` gains `loopbackPorts: number[]` and optional `pid?: number`. The VM path resolves on `port.opened` (ok), a loopback-bind `resource.warning` (ok:false + hint, port parsed back out of `resource: "port:" + port`), process-exit-before-a-port (ok:false + stderr), or a 45s timeout (ok:false).

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/lib/run-serve.test.ts`, extend the `fake` helper so its `runtime` also answers `getCapabilities` (default browser: `realOs:false`) and give the shell/runtime an `exec`:

Replace the `fake` helper with:

```ts
function fake(
  execImpl: (emit: (e: RuntimeEvent) => void) => Promise<{ code: number; stdout: string; stderr: string }>,
  opts: { realOs?: boolean; runtimeExec?: (emit: (e: RuntimeEvent) => void) => Promise<any> } = {},
) {
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const emit = (e: RuntimeEvent): void => listeners.forEach((l) => l(e));
  const runtime = {
    subscribe(l: (e: RuntimeEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getCapabilities: async () => ({ realOs: opts.realOs ?? false }) as any,
    exec: (line: string) => (opts.runtimeExec ?? (() => Promise.reject(new Error("no runtimeExec"))))(emit),
    kill: async () => {},
  };
  const shell = { cwd: "/", exec: () => execImpl(emit) };
  return { runtime, shell, listeners };
}
```

The existing browser-path tests keep passing (they never set `realOs`, so the registering path runs; `getCapabilities` now exists). Update those tests' assertions that use `toEqual`/`toMatchObject` on the full result to tolerate the new `loopbackPorts: []` field (they use `openedPorts`/`ok`/`code`/`stderr` already, which is unaffected — the `toMatchObject` in "reports a failing command" still matches with the extra field).

Add the VM-path tests:

```ts
const fakeHandle = (pid: number) => ({
  pid,
  stdout: { text: async () => "" },
  stderr: { text: async () => "boom-stderr" },
  stdin: { write() {}, end() {} },
  wait: () => new Promise<never>(() => {}), // never exits (a live server)
  kill: async () => {},
});

describe("runServeCommand (VM / realOs path)", () => {
  it("spawns detached and resolves when port.opened arrives (not by reading openPorts synchronously)", async () => {
    let execCalled = false;
    const { runtime, shell } = fake(() => Promise.reject(new Error("shell.exec must not be used on the VM path")), {
      realOs: true,
      runtimeExec: (emit) => {
        execCalled = true;
        setTimeout(() => emit({ type: "port.opened", port: 8000, url: "/__port__/8000/" }), 5);
        return Promise.resolve(fakeHandle(8000));
      },
    });
    const r = await runServeCommand(runtime as any, shell as any, "python3 -m http.server 8000 --bind 0.0.0.0");
    expect(execCalled).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.openedPorts).toEqual([8000]);
    expect(r.pid).toBe(8000);
  });

  it("a loopback-only bind resolves ok:false with the loopback port", async () => {
    const { runtime, shell } = fake(() => Promise.reject(new Error("unused")), {
      realOs: true,
      runtimeExec: (emit) => {
        setTimeout(() => emit({ type: "resource.warning", resource: "port:8001", detail: "loopback-only" }), 5);
        return Promise.resolve(fakeHandle(8001));
      },
    });
    const r = await runServeCommand(runtime as any, shell as any, "python3 -m http.server 8001 --bind 127.0.0.1");
    expect(r.ok).toBe(false);
    expect(r.loopbackPorts).toEqual([8001]);
  });

  it("a server that exits before opening a port fails with its stderr", async () => {
    const { runtime, shell } = fake(() => Promise.reject(new Error("unused")), {
      realOs: true,
      runtimeExec: () =>
        Promise.resolve({
          ...fakeHandle(42),
          wait: async () => ({ code: 1, signal: null }),
          stderr: { text: async () => "Address already in use" },
        }),
    });
    const r = await runServeCommand(runtime as any, shell as any, "python3 -m http.server 8000 --bind 0.0.0.0");
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("Address already in use");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/yzl/Erdou && pnpm vitest run apps/web/src/lib/run-serve.test.ts`
Expected: FAIL — the VM-path tests fail (no detached branch yet) and `r.loopbackPorts` is undefined.

- [ ] **Step 3: Implement the capability-gated serve in `run-serve.ts`**

Replace `apps/web/src/lib/run-serve.ts` in full:

```ts
import type { Runtime, RuntimeEvent } from "@erdou/runtime-contract";
import type { RpcShellSession } from "./kernel.js";

export interface RunServeResult {
  ok: boolean;
  /** Ports that opened during this run, in open order (captured from the event
   *  subscription, never by diffing a ports list afterwards). */
  openedPorts: number[];
  /** Ports the server bound loopback-only (127.0.0.1) — reachable via the guest
   *  loopback, NOT previewable. Non-empty ⇒ show a "bind 0.0.0.0" hint. */
  loopbackPorts: number[];
  /** The detached server's pid (real-OS path only), so the caller can stop it
   *  before re-serving — a real guest socket stays bound until the process dies. */
  pid?: number;
  /** Present when the command exited. */
  code?: number;
  stdout?: string;
  stderr?: string;
}

type ServeRuntime = Pick<Runtime, "subscribe" | "getCapabilities" | "exec">;

/** python `-m http.server` cold-start (~16s) + bind + the guestd watcher poll. */
const VM_SERVE_TIMEOUT_MS = 45_000;

/**
 * Run a (possibly serving) command. Capability-gated:
 *  - realOs (VM): a real server BLOCKS, so start it DETACHED via `runtime.exec`
 *    (which resolves on process START, never awaiting exit) and settle on the
 *    FIRST of `port.opened` (ok), a loopback-bind `resource.warning` (ok:false
 *    + hint), a process exit before any port (ok:false + stderr), or a timeout.
 *  - otherwise (browser): the simulated kernel's serve returns after
 *    registering, so run it through the shell and settle on exit/port.
 * Never rejects — failures come back as `ok: false`.
 */
export function runServeCommand(
  runtime: ServeRuntime,
  shell: RpcShellSession,
  commandLine: string,
): Promise<RunServeResult> {
  return runtime.getCapabilities().then((caps) =>
    caps.realOs ? runServeDetached(runtime, commandLine) : runServeRegistering(runtime, shell, commandLine),
  );
}

function runServeDetached(runtime: ServeRuntime, commandLine: string): Promise<RunServeResult> {
  return new Promise((resolve) => {
    const openedPorts: number[] = [];
    const loopbackPorts: number[] = [];
    let settled = false;
    let pid: number | undefined;
    const settle = (r: RunServeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(r);
    };
    const unsub = runtime.subscribe((e: RuntimeEvent) => {
      if (e.type === "port.opened") {
        openedPorts.push(e.port);
        settle({ ok: true, openedPorts: [...openedPorts], loopbackPorts: [...loopbackPorts], pid });
      } else if (e.type === "resource.warning" && e.resource.startsWith("port:")) {
        // A loopback-only bind: VmRuntime emits the existing `resource.warning`
        // event (Task 5) rather than a new contract member; recover the port
        // number from `resource` ("port:<n>").
        const port = Number(e.resource.slice("port:".length));
        loopbackPorts.push(port);
        settle({ ok: false, openedPorts: [...openedPorts], loopbackPorts: [...loopbackPorts], pid });
      }
    });
    const timer = setTimeout(
      () =>
        settle({
          ok: false,
          openedPorts: [...openedPorts],
          loopbackPorts: [...loopbackPorts],
          pid,
          stderr: `no port opened within ${VM_SERVE_TIMEOUT_MS / 1000}s (does the server bind 0.0.0.0?)`,
        }),
      VM_SERVE_TIMEOUT_MS,
    );
    // Start detached: resolves on process START; we NEVER await its exit.
    runtime.exec(commandLine).then(
      (handle) => {
        pid = handle.pid;
        // If it exits BEFORE opening a port (e.g. a crash / EADDRINUSE), surface it.
        void handle.wait().then(async (status) => {
          if (settled) return;
          const stderr = await handle.stderr.text();
          settle({ ok: false, openedPorts: [...openedPorts], loopbackPorts: [...loopbackPorts], pid, code: status.code, stderr });
        });
      },
      (err: unknown) =>
        settle({ ok: false, openedPorts: [], loopbackPorts: [], code: -1, stderr: err instanceof Error ? err.message : String(err) }),
    );
  });
}

function runServeRegistering(runtime: ServeRuntime, shell: RpcShellSession, commandLine: string): Promise<RunServeResult> {
  return new Promise((resolve) => {
    const openedPorts: number[] = [];
    let settled = false;
    let exited = false;
    const unsub = runtime.subscribe((e: RuntimeEvent) => {
      if (e.type !== "port.opened") return;
      openedPorts.push(e.port);
      if (settled || exited) return;
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: true, openedPorts, loopbackPorts: [] });
        }
      }, 0);
    });
    shell.exec(commandLine).then(
      async (r) => {
        exited = true;
        if (r.code === 0 && openedPorts.length === 0) {
          await new Promise((tick) => setTimeout(tick, 0));
        }
        unsub();
        if (settled) return;
        settled = true;
        resolve({ ok: r.code === 0, openedPorts, loopbackPorts: [], code: r.code, stdout: r.stdout, stderr: r.stderr });
      },
      (err: unknown) => {
        exited = true;
        unsub();
        if (settled) return;
        settled = true;
        resolve({ ok: false, openedPorts, loopbackPorts: [], code: -1, stderr: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}
```

- [ ] **Step 4: Handle the loopback `resource.warning` in Studio; kill the tracked server pid on rerun AND on Stop in PreviewPanel**

In `apps/web/src/lib/studio.ts`, in `subscribeRuntime`, add a branch after the `port.closed` branch for the EXISTING `resource.warning` contract event (Task 5 reuses it for the loopback-bind hint — no new contract member):

```ts
      } else if (e.type === "resource.warning") {
        this.logSystem("system", e.detail);
        this.notify();
      }
```

In `apps/web/src/components/PreviewPanel.tsx`:

Add a pid ref near the other refs at the top of the component. (The loopback-bind hint itself is already surfaced via the Studio system log added above, so PreviewPanel needs no dedicated banner state this round — simpler, and the system log is already visible in the UI.)

```ts
  /** The VM's detached server pid from the last run (real guest socket), so the
   *  next run — or an explicit Stop — can kill it: a real socket stays bound
   *  until the process dies (unlike the browser kernel's virtual-port unregister). */
  const servePid = useRef<number | null>(null);
```

In `runCommand`, capture the pid from the result. Replace the success/failure handling inside `runCommand` so it also reads `result.pid`:

```ts
      const result = await runServeCommand(studio.runtime, studio.shell, commandLine);
      servePid.current = result.pid ?? null;
      if (!result.ok) {
        setErrors([result.stderr?.trim() || result.stdout?.trim() || `exited with code ${result.code}`]);
        setOutput(null);
      } else {
        setErrors([]);
        setOutput(result.stdout?.trim() || null);
        const first = result.openedPorts[0];
        if (first !== undefined) setSelectedPort(first);
        else if (selectedPort === null) setSelectedPort(studio.openPorts[0]?.port ?? null);
      }
      ranOnce.current = true;
      return { ok: result.ok, opened: [...result.openedPorts] };
```

In `doRun`, kill the previous detached server before the close-then-serve, so a live re-run can rebind the port:

```ts
  async function doRun(action: () => Promise<{ ok: boolean; opened: number[] }>): Promise<void> {
    busy.current = true;
    try {
      if (servePid.current !== null) {
        await studio.runtime.kill(servePid.current).catch(() => {});
        servePid.current = null;
      }
      for (const p of openedPorts.current) await studio.closePort(p);
      openedPorts.current = [];
      const result = await action();
      openedPorts.current = result.opened;
      lastRunFsVersion.current = studio.fsVersion;
      if (result.ok) setNonce((n) => n + 1);
    } finally {
      busy.current = false;
    }
  }
```

The existing `stop(port)` function (invoked when the user clicks a port chip's × button) today only calls `studio.closePort` — pure bookkeeping. On the VM path this leaves the real guest server bound and running after Stop (a leak/desync: the guestd watcher only emits on a state *transition*, so nothing self-heals). Replace it so it also kills the tracked pid (browser-safe: `servePid` stays `null` on the browser kernel, so `kill` is never called there):

```ts
  function stop(port: number): void {
    if (servePid.current !== null) {
      void studio.runtime.kill(servePid.current).catch(() => {});
      servePid.current = null;
    }
    void studio.closePort(port);
  }
```

**Limitation (kill-before-rerun and Stop):** killing the tracked pid only frees the guest socket when that pid IS the server. `guestd` execs commands via `sh -c`, so a single simple serve command (e.g. `python3 -m http.server 8000 --bind 0.0.0.0`) tail-call-execs under busybox ash and the tracked pid becomes the server itself. A compound or wrapper command (`FLASK_APP=app.py flask run`, `npm start`, `a && b`) instead leaves the tracked pid as the shell/wrapper process, so killing it will NOT free the socket. Out of scope to fix this round — documented as a known gap.

**Note:** `SpawnOptions.detached` (`packages/runtime-contract/src/process.ts`) remains an unimplemented no-op this round — no runtime reads the field. `runtime.exec` already resolves on process START (before the command exits), which is what supplies the "detached" semantics `runServeDetached` relies on; passing `detached: true` would do nothing today.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/yzl/Erdou && pnpm vitest run apps/web/src/lib/run-serve.test.ts && pnpm --filter @erdou/web typecheck`
Expected: PASS — both browser-path and VM-path tests green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/run-serve.ts apps/web/src/lib/run-serve.test.ts apps/web/src/lib/studio.ts apps/web/src/components/PreviewPanel.tsx
git commit -m "feat(web): capability-gated VM serve (detached + await port.opened), loopback hint, kill-before-rerun"
```

---

### Task 7: Gated app e2e — a real server in the VM previews in the panel

Mirror the existing `app-vm.e2e.test.ts` + `scripts/app-vm-e2e/run.mjs`: in headless Chromium, switch to the VM kernel, write a marker `index.html` into the guest workspace via the xterm PTY, serve it with `python3 -m http.server 8000 --bind 0.0.0.0` from the Preview panel, and assert the preview iframe renders the guest's served content (SW reverse-proxy → `dispatch` → guest round-trip). Gated on the asset + `ERDOU_VM_E2E=1` + system Chromium. Reuse the existing driver's signal-safe cleanup + dev-server-process-group patterns.

**Files:**
- Create: `apps/web/src/app-vm-preview.e2e.test.ts` (gated vitest wrapper)
- Create: `apps/web/scripts/app-vm-preview-e2e/run.mjs` (the headless-Chromium driver)

**Interfaces:**
- Consumes: the running app (VM kernel toggle, Terminal xterm PTY, Preview panel `.run-input`/Run/`.port-chip`/`.preview-frame`), the preview SW → `VmRuntime.dispatch` path.
- Produces: an `execFileSync`-driven driver that prints `RESULT ALL_PASS` iff the guest-served content renders in the preview iframe.

- [ ] **Step 1: Write the failing gated wrapper test**

Create `apps/web/src/app-vm-preview.e2e.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assetsPresent = existsSync(join(here, "..", "..", "..", "packages", "runtime-vm", "assets", "state.zst"));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const RUN = assetsPresent && process.env.ERDOU_VM_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("app + VM kernel PREVIEW e2e (gated)", () => {
  it("previews a real guest HTTP server in the Preview panel", () => {
    const out = execFileSync("node", [join(here, "..", "scripts", "app-vm-preview-e2e", "run.mjs")], {
      encoding: "utf8",
      timeout: 200_000, // < the it() timeout, so the inner one governs with a clean error
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 210_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/yzl/Erdou && ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm-preview.e2e.test.ts`
Expected: FAIL — `run.mjs` does not exist (`ENOENT`). (If the asset is absent the suite skips; re-bake first.)

- [ ] **Step 3: Write the driver `run.mjs`**

Create `apps/web/scripts/app-vm-preview-e2e/run.mjs`:

```js
// R12 Task 7: gated app PREVIEW e2e driver. Drives the REAL apps/web (Vite dev)
// in headless Chromium: switches to the Linux VM kernel, writes a marker
// index.html into the guest via the xterm PTY, serves it with a real
// `python3 -m http.server --bind 0.0.0.0` from the Preview panel, and asserts
// the preview iframe (SW reverse-proxy → VmRuntime.dispatch → guest) renders
// the marker. Signal-safe cleanup + dev-server process group mirror
// scripts/app-vm-e2e/run.mjs.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts/app-vm-preview-e2e
const webRoot = join(here, "..", ".."); // apps/web
const repoRoot = join(webRoot, "..", ".."); // repo root

const require = createRequire(join(webRoot, "package.json"));
const { chromium } = require("playwright-core");

const MARKER = "erdou-preview-marker-" + Math.random().toString(36).slice(2, 8);

let devServer;
let browser;
let cleanedUp = false;

function killDevServerGroup(signal) {
  if (!devServer) return;
  try {
    if (devServer.pid) process.kill(-devServer.pid, signal);
    else devServer.kill(signal);
  } catch {
    try { devServer.kill(signal); } catch { /* already gone */ }
  }
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  killDevServerGroup("SIGTERM");
  const killTimer = setTimeout(() => killDevServerGroup("SIGKILL"), 2000);
  devServer?.once("exit", () => clearTimeout(killTimer));
  if (browser) await browser.close().catch(() => {});
  clearTimeout(killTimer);
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    console.log(`[app-vm-preview-e2e] received ${sig}; cleaning up`);
    await cleanup();
    process.exit(1);
  });
}

const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
};

function waitForServer(url, getLog, timeoutMs = 15_000) {
  const t0 = Date.now();
  return (async function poll() {
    while (Date.now() - t0 < timeoutMs) {
      try { const r = await fetch(url); if (r.ok) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`dev server not reachable at ${url} within ${timeoutMs}ms\n${getLog()}`);
  })();
}

async function main() {
  execFileSync(process.execPath, [join(webRoot, "scripts", "link-vm-assets.mjs")], { stdio: "inherit" });

  devServer = spawn("pnpm", ["--filter", "@erdou/web", "dev"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let devLog = "";
  let resolveUrl, rejectUrl;
  let baseUrl;
  const urlWait = new Promise((res, rej) => { resolveUrl = res; rejectUrl = rej; });
  const onData = (d) => {
    const s = d.toString();
    devLog += s;
    process.stdout.write(`[vite] ${s}`);
    if (!baseUrl) {
      const m = /Local:\s+(https?:\/\/[^\s]+)/.exec(devLog);
      if (m) { baseUrl = m[1].replace(/\/$/, ""); resolveUrl(baseUrl); }
    }
  };
  devServer.stdout.on("data", onData);
  devServer.stderr.on("data", (d) => { devLog += d.toString(); process.stdout.write(`[vite:err] ${d}`); });
  devServer.on("exit", (code) => { if (!baseUrl) rejectUrl(new Error(`dev server exited before a URL (code ${code})\n${devLog}`)); });
  const urlTimer = setTimeout(() => rejectUrl(new Error(`timeout waiting for dev server URL\n${devLog}`)), 30_000);

  try {
    baseUrl = await urlWait;
    clearTimeout(urlTimer);
    await waitForServer(baseUrl + "/", () => devLog);

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium-browser",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") console.log(`[page:error] ${m.text()}`); });

    // Pre-seed a model config so the Settings scrim never blocks the toggle.
    await page.addInitScript(() => {
      localStorage.setItem(
        "erdou:model",
        JSON.stringify({ provider: "openai-compatible", baseUrl: "/llm/v1", apiKey: "e2e-test-key", model: "gpt-4o-mini" }),
      );
    });

    const kernelBtnSel = 'button[aria-label="Kernel"]';
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 2; i++) {
      if ((await page.locator("vite-error-overlay").count()) === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForSelector(kernelBtnSel, { timeout: 20_000 });

    // 1) Switch to the Linux VM kernel.
    await page.click(kernelBtnSel);
    await page.locator(".ui-select-pop .ui-select-opt", { hasText: "Linux VM" }).click();
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Kernel"] .ui-select-label')?.textContent === "Linux VM",
      undefined,
      { timeout: 40_000 },
    );
    pass("switch-to-vm", true);

    // 2) Write a marker index.html into the guest workspace via the xterm PTY.
    await page.locator("button.tab", { hasText: "Terminal" }).click();
    await page.waitForSelector(".xterm", { timeout: 10_000 });
    await page.click(".xterm");
    const xtermText = () => page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
    const waitForXterm = async (needle, timeoutMs, sinceLen = 0) => {
      const t1 = Date.now();
      let buf = "";
      while (Date.now() - t1 < timeoutMs) {
        buf = await xtermText();
        if (buf.slice(sinceLen).includes(needle)) return buf.slice(sinceLen);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`timeout waiting for "${needle}" in xterm:\n${buf}`);
    };
    await waitForXterm("$", 15_000); // first shell prompt (pty opened post-boot)
    const baseline = (await xtermText()).length;
    await page.keyboard.type(`printf '${MARKER}' > index.html`, { delay: 15 });
    await page.keyboard.press("Enter");
    // Confirm the write by cat-ing it back.
    await page.keyboard.type("cat index.html", { delay: 15 });
    await page.keyboard.press("Enter");
    await waitForXterm(MARKER, 10_000, baseline);
    pass("guest-index-written", true);

    // 3) Serve it from the Preview panel and view it.
    await page.locator("button.tab", { hasText: "Preview" }).click();
    await page.fill(".run-input", "python3 -m http.server 8000 --bind 0.0.0.0");
    await page.locator("button.btn.primary", { hasText: "Run" }).click();
    // port 8000 shows up once the guestd watcher sees the (cold-starting) bind.
    await page.waitForSelector(".port-chip", { timeout: 60_000 });
    pass("port-8000-opened", (await page.locator(".port-chip", { hasText: "port 8000" }).count()) > 0);

    // The panel auto-selects the first opened port; the iframe mounts at /__preview__/8000/.
    await page.waitForSelector(".preview-frame", { timeout: 15_000 });
    const previewText = async () => {
      const frame = page.frames().find((f) => f.url().includes("/__preview__/8000/"));
      if (!frame) return "";
      return await frame.evaluate(() => document.body?.textContent ?? "").catch(() => "");
    };
    let text = "";
    const deadline = Date.now() + 60_000; // SW → dispatch → guest round-trip (cold python)
    while (Date.now() < deadline) {
      text = await previewText();
      if (text.includes(MARKER)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    pass("preview-renders-guest-content", text.includes(MARKER), `body=${JSON.stringify(text.slice(0, 120))}`);
  } finally {
    await cleanup();
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);
  console.log(`RESULT ${allOk ? "ALL_PASS" : "SOME_FAIL"} (${results.filter((r) => r.ok).length}/${results.length} checks)`);
  return allOk ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.log(`DRIVER_ERROR ${e?.stack || e}`);
  exitCode = 1;
}
process.exit(exitCode);
```

- [ ] **Step 4: Run the gated e2e to verify it passes**

Run: `cd /home/yzl/Erdou && ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm-preview.e2e.test.ts`
Expected: PASS — the driver prints `RESULT ALL_PASS` (switch-to-vm, guest-index-written, port-8000-opened, preview-renders-guest-content all PASS).

- [ ] **Step 5: Verify the hermetic default still skips it**

Run: `cd /home/yzl/Erdou && pnpm vitest run apps/web/src/app-vm-preview.e2e.test.ts`
Expected: the suite reports SKIPPED (no `ERDOU_VM_E2E`) — this verifies the skip.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app-vm-preview.e2e.test.ts apps/web/scripts/app-vm-preview-e2e/run.mjs
git commit -m "test(web): gated app e2e — real VM guest server previews in the panel via the SW reverse-proxy"
```

---

### Task 8: Final gates, README, memory

Document the networking/preview surface in the package README and run the full gate set (hermetic + gated) to confirm zero regression.

**Files:**
- Modify: `packages/runtime-vm/README.md` (networking/preview section)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: an updated README + a green full gate set.

- [ ] **Step 1: Add the networking/preview section to `README.md`**

In `packages/runtime-vm/README.md`, add a new section after the "Filesystem & PTY" section (before "Gated test suites"):

````markdown
## Networking & live preview (Round 12)

The baked state is **networked**: the bake brings up a virtio NIC and DHCPs `eth0` to `192.168.86.100` *before* `save_state`, so a restore boots with a live, addressed interface and zero per-boot network setup. This required a **re-bake** — adding `net_device` only at restore time crashes v86's per-device `set_state`, and the frozen kernel only creates `eth0` when the NIC is present at boot.

Restore MUST pass both v86 options (both are set in `v86-host.ts`):

- `net_device: { relay_url: "fetch", type: "virtio" }` — v86's in-JS `FetchNetworkAdapter` (a NAT, `router_ip=192.168.86.1`, `vm_ip=192.168.86.100`).
- `preserve_mac_from_state_image: true` — **critical.** Without it, the restored adapter never learns the guest MAC and every `connect`/`tcp_probe` hangs forever.

**Live preview.** `VmRuntime.dispatch(port, req)` reverse-proxies an HTTP request into a real guest server via `V86Host.networkAdapter()`: it `tcp_probe`s the port (a closed/loopback-only bind → a fast `502`, never a hang), opens a per-request `connect(port)`, writes the request as HTTP/1.1 bytes (`http-codec.ts`), accumulates the response, and finishes on Content-Length / chunked-terminator / a 600ms idle timer / `close` / a 15s hard cap. **Servers must bind `0.0.0.0`** — a `127.0.0.1` bind is on the guest loopback (not eth0) and is unreachable through the NAT.

**Port detection.** A daemon thread in `guestd.py` polls `/proc/net/tcp(6)` for LISTEN sockets, classifies each as reachable (`0.0.0.0`/eth0 IP) vs loopback-only, and pushes `"L"` port-event frames over hvc0. `VmRuntime` turns them into `port.opened` / `port.closed`, plus the existing `resource.warning` contract event for a loopback-only bind (a "bind 0.0.0.0" hint — no new contract event). Because the watcher lives in `guestd.py`, changing it requires a re-bake.

**Re-bake + version bump.** After any change to the bake or `guestd.py`:

```
rm -f packages/runtime-vm/assets/state.bin
pnpm --filter @erdou/runtime-vm bake
```

Then **bump `version` in `apps/web/src/lib/vm-assets.ts`** so IndexedDB-cached clients re-fetch the new state. The `state.zst`/kernel/bios binaries stay gitignored — never commit them.

**Deferred to a later round:** the npm/pip network-egress gateway (spec §7) and WISP — `networkEgress` is still `"none"`. This round is preview-only; the fetch-NAT is used solely for the host→guest dispatch reverse-proxy.
````

- [ ] **Step 2: Run the full hermetic gate set**

Run: `cd /home/yzl/Erdou && pnpm test && pnpm typecheck && pnpm lint:deps && pnpm build`
Expected: all green; the gated VM suites (Node conformance, package browser e2e, app PTY e2e, app preview e2e) report as skipped by default; no layering violations; the app builds.

- [ ] **Step 3: Run the gated Node conformance (with the new dispatch/port tests)**

Run: `cd /home/yzl/Erdou && rm -f packages/runtime-vm/assets/state.bin && ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts`
Expected: PASS — the original 25 plus the new eth0 / networkAdapter / dispatch / port-opened / port-closed / loopback tests are all green against the networked state.

- [ ] **Step 4: Run the gated app preview e2e**

Run: `cd /home/yzl/Erdou && ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm-preview.e2e.test.ts`
Expected: `RESULT ALL_PASS`.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-vm/README.md
git commit -m "docs(vm): document Round 12 networking + live-preview (re-bake, preserve_mac, 0.0.0.0, dispatch, port watcher)"
```

---

## Self-Review

**1. Spec coverage (§6 preview + the port-watcher async idiom).**
- §6 host→guest HTTP preview: Task 1 (networked state + `networkAdapter()`), Task 2 (HTTP codec), Task 3 (`dispatch` reverse-proxy) — the SW → `preview-bridge` → `dispatch` → guest round-trip is exercised end-to-end by Task 7. The existing `preview-bridge.ts`/`preview-sw.js` need no change (they already call `runtime.dispatch`); this round makes that call reach a real guest.
- Port-watcher async idiom: Task 4 (guestd `/proc/net/tcp` watcher → `onPortEvent`), Task 5 (`port.opened`/`port.closed` plus a loopback-bind `resource.warning` on the runtime bus), Task 6 (app awaits `port.opened` instead of a synchronous ports-list read). `port.opened` is guest-activity-forwarded — bounded by when the server actually binds, not by when the API call resolves — which is exactly the async carve-out `events.ts`'s docstring already permits for a VM-backed runtime forwarding guest activity; python's ~16s cold-start is the reason callers poll generously, not a contract violation.
- 0.0.0.0-vs-loopback failure mode: Task 4 classification → Task 5 (existing `resource.warning` event, no new contract member) → Task 6 hint (Studio system-log only this round) → Task 8 README. Covered.
- Global Constraints: re-bake gitignored (Tasks 1, 4), version bump (Tasks 1, 4, README), hermetic default + gated suites (every gated test uses `describe.skipIf(!RUN)`), layering unchanged (no runtime package imports anything new; apps/web already imports runtime-vm), deferred egress/WISP noted (Task 8, capabilities untouched).

**2. Placeholder scan.** No "TBD"/"add error handling"/"similar to Task N"/"handle edge cases". Every code step carries complete code (codec, dispatch, parser, guestd watcher, run-serve, driver, README). Every command has an expected result. No references to undefined symbols.

**3. Type consistency across tasks.**
- `NetworkAdapter`/`TcpConn` shape T1 → T3: defined in `v86-host.ts` (T1) with `tcp_probe(port): Promise<boolean>`, `connect(port): TcpConn`, `TcpConn.on(event, cb)` overloads + `write(bytes)`; consumed verbatim by `dispatch` (T3, `net.tcp_probe`, `net.connect`, `conn.on("connect"|"data"|"close")`, `conn.write`).
- `http-codec` T2 → T3: `serializeHttpRequest(req): Uint8Array`, `parseHttpResponse(bytes): HttpResponse`, `responseComplete(bytes): boolean` — imported and called exactly by `dispatch`.
- `onPortEvent` T4 → T5: `GuestdClient.onPortEvent(cb: (e: { port: number; listening: boolean; loopback: boolean }) => void): void`; `VmRuntime.onGuestPortEvent` consumes the identical shape. `FrameType.PORT_EVENT = "L"` used by both guestd.py (send) and guestd-client (receive). `parseListeningPorts` (TS) and `_parse_listening` (Python) mirror the same algorithm/constants (`00000000`, `0100007F`, `6456A8C0`).
- `port.opened` flow T5 → T6 → T7: `{ type: "port.opened"; port; url: "/__port__/<port>/" }` emitted by T5, awaited by `runServeDetached` (T6), asserted by the driver's `.port-chip`/`/__preview__/8000/` iframe (T7). `RunServeResult.loopbackPorts`/`pid` added in T6 and consumed by PreviewPanel + tests. The loopback-bind hint reuses the EXISTING `resource.warning` contract event (T5) — handled in Studio (system-log) + run-serve (T6); no new contract variant.

**4. Known risks to flag for plan review.**
- **The loopback-bind hint reuses the EXISTING `resource.warning` contract event** (`packages/runtime-contract/src/events.ts`) instead of adding a new `port.loopback` variant — no contract change this round. `VmRuntime` emits `resource.warning { resource: "port:" + port; detail }`; `run-serve.ts` recovers the port number by parsing `resource`, and Studio's `subscribeRuntime` logs `e.detail` directly. `BrowserRuntime` never emits it, so no browser-runtime change is needed.
- **`responseComplete` was added to `http-codec` beyond the brief's "two functions."** It is pure, unit-tested, and belongs with the parser (DRY: dispatch's read-loop completion detector reuses the codec's header/length logic instead of duplicating it). If the reviewer prefers the strict two-function boundary, inline it into `dispatch` instead.
- **The TS `parseListeningPorts` duplicates the Python `_parse_listening`.** Per the brief, guestd.py parses+classifies and sends JSON `{port, listening, loopback}`, so the TS parser is a *tested reference mirror* (like `preview-bridge.ts` ↔ `preview-sw.js`), not live code. Alternative: ship raw `/proc/net/tcp` lines over the `"L"` frame and parse once in TS (single source of truth, more bytes on the wire). Flagged for a decision.
- **`realOs` is the serve-path discriminator** (browser=false, VM=true) — NOT `nativeProcesses` (which is `true` for both). Verified against `browser-runtime.ts` (`realOs: false`) and `capabilities.ts` (`realOs: true`). If a future non-VM real-OS runtime appears, revisit.
- **"Detached via `runtime.exec`, not `runtime.spawn`."** The brief said "via `runtime.spawn`"; the plan uses `runtime.exec(commandLine)` because a serve command is a command-line string (VmRuntime.exec is the `sh -c` path) and — crucially — `exec`/`spawn` both resolve on process START (not exit), which IS the "detached" primitive here (the contrast is with `shell.exec`/`createExecShell`, which awaits `wait()` and would hang). Swap to `spawn({cmd:"sh",args:["-c",line]})` if the reviewer wants the literal API.
- **Kill-before-rerun (PreviewPanel) is beyond the brief's literal Task 6 test.** Without it, a VM live re-run hits a still-bound guest socket → EADDRINUSE (visible failure, not a hang). Included to avoid a real regression; can be cut if deferred.
- **Two re-bakes** (Task 1 networking, Task 4 guestd watcher) because `guestd.py` rides frozen in `state.zst`. Correct but ~2 min of bake time total; the final version string (`alpine-3.24.1-r12-net-watch`) is what ships.
- **Cold-start timing.** python `-m http.server` ~16s cold-start drives the generous polls (dispatch 40s, port-event 40s, e2e 60s, VM serve 45s). If CI is slower, these are the knobs to raise.
- **guestd watcher poll interval is 500ms** — fine given python's 16s cold-start dominates; lower it only if snappier detection is needed (weigh hvc0 traffic).
