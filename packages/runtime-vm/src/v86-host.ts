import { V86 } from "v86";
import type { GuestChannel } from "./guestd-client.js";
import type { Fs9p } from "./fs-bridge.js";
import { installEgressShim, type EgressFetch, type UpstreamFetch } from "./egress-shim.js";

/** v86's in-JS TCP stream from FetchNetworkAdapter.connect(). The handshake is
 *  async — always write from the "connect" event, never immediately. The "close"
 *  event is unreliable (may not fire on the guest FIN); never block solely on it. */
export interface TcpConn {
  on(event: "connect", cb: () => void): void;
  on(event: "data", cb: (data: Uint8Array) => void): void;
  on(event: "close", cb: () => void): void;
  write(bytes: Uint8Array): void;
  /** Drive OUR side's close so v86 releases the conn from `network_adapter.tcp_conn`.
   *  v86's `TCPConnection.prototype.close` completes an active close, OR — when the
   *  guest already FIN'd (python HTTP/1.0 responds then closes, leaving the conn in
   *  `close-wait`) — finishes the passive close (→ `last-ack` → `release()`). Without
   *  this call the conn is retained forever after a guest FIN, leaking per request. */
  close(): void;
}

/** v86's FetchNetworkAdapter (in-JS NAT). Addressing is hard-coded at
 *  construction (router_ip=192.168.86.1, vm_ip=192.168.86.100); connect/probe
 *  target the guest regardless of DHCP history. */
export interface NetworkAdapter {
  tcp_probe(port: number): Promise<boolean>;
  connect(port: number): TcpConn;
  /** Instance-property fetch the NAT relay uses for guest HTTP egress —
   *  wrapped by the pypi egress shim at boot (Round 13). */
  fetch: EgressFetch;
}

/** Pre-loaded boot assets — produced by a Node or browser loader, consumed by V86Host.
 *  Separating loading from construction lets one host boot in either environment. */
export interface V86BootInputs {
  bios: ArrayBuffer;
  vgaBios: ArrayBuffer;
  kernel: ArrayBuffer;
  state?: ArrayBuffer;
  /** Where v86.wasm is fetched from — a file URL/path (Node) or a served URL (browser).
   *  Passed to v86 verbatim; a wrong value hangs boot silently, hence the timeout. */
  wasmUrl: string;
  memoryMB: number;
}

const REQUIRED_FS9P = [
  "GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile",
  "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file",
] as const;

/** Fail-fast if a v86 upgrade renamed a method the fs-bridge depends on. */
export function assertFs9pSymbols(fs9p: unknown): void {
  const o = fs9p as Record<string, unknown> | null;
  if (!o || !Array.isArray((o as { inodes?: unknown }).inodes)) {
    throw new Error("v86 fs9p missing or has no `inodes` array — construct V86 with `filesystem: {}`");
  }
  const missing = REQUIRED_FS9P.filter((m) => typeof o[m] !== "function");
  if (missing.length) throw new Error(`v86 fs9p missing required method(s): ${missing.join(", ")} — v86 upgrade may have renamed them`);
}

// Linux fill_queue posts PAGE_SIZE (4096-byte) RX buffers, one per ring slot; v86's
// set_next_blob TRUNCATES a blob larger than one chain. 2048 leaves margin.
const VIRTIO_INPUT_CHUNK = 2048;

/** Fail-fast if a v86 upgrade moved the virtio-console internals the
 *  capacity-aware input sender depends on (FU2). */
export function assertVirtioConsoleQueue(q: unknown, queueId: number): { count_requests(): number; avail_addr: number } {
  const o = q as Record<string, unknown> | null;
  if (!o || typeof o.count_requests !== "function" || typeof o.avail_addr !== "number") {
    throw new Error(
      `v86 virtio_console.virtio.queues[${queueId}] missing count_requests/avail_addr — v86 upgrade may have changed internals`,
    );
  }
  return q as { count_requests(): number; avail_addr: number };
}

const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

export class V86Host {
  // v86 ships a .d.ts, but it's incomplete/inaccurate (e.g. restore_state is typed
  // ArrayBuffer when the runtime wants a typed-array view) — `any` is the honest boundary.
  private emulator: any;
  readonly fs9p!: Fs9p; // set after boot (declared for the type; assigned in boot)

  /** Seam for tests — override to inject a fake emulator. */
  protected makeEmulator(opts: Record<string, unknown>): any {
    return new V86(opts);
  }

  async boot(inputs: V86BootInputs, opts: { bootTimeoutMs?: number } = {}): Promise<void> {
    // VmRuntime re-boots the SAME host after shutdown(): lift the destroy latch and
    // drop cached senders — their closures hold the previous guest's unflushed pending,
    // which must not leak into the new guest's consoles.
    this.destroyed = false;
    this.inputSenders.clear();
    const opt: Record<string, unknown> = {
      wasm_path: inputs.wasmUrl,
      bios: { buffer: inputs.bios },
      vga_bios: { buffer: inputs.vgaBios },
      bzimage: { buffer: inputs.kernel },
      memory_size: inputs.memoryMB * 1024 * 1024,
      filesystem: {},
      virtio_console: true,
      // Networking (Round 12): a virtio NIC + v86's in-JS fetch-NAT. The NIC MUST
      // be present in the baked state (adding it only at restore crashes v86's
      // per-device set_state). preserve_mac_from_state_image re-teaches the freshly
      // constructed adapter the guest MAC on restore — WITHOUT it every
      // connect/tcp_probe hangs forever (verified spike).
      net_device: { relay_url: "fetch", type: "virtio" },
      preserve_mac_from_state_image: true,
      autostart: false,
      disable_keyboard: true,
      disable_speaker: true,
      disable_mouse: true,
      cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
    };
    if (inputs.state) opt.initial_state = { buffer: inputs.state };
    this.emulator = this.makeEmulator(opt);
    // Package egress (Round 13): wrap the NAT's fetch with the pypi shim —
    // https upgrade in non-https contexts + simple-API link rewrite (pypi.org
    // 403s plain http and links https wheels the NAT can't relay). Install now
    // for the no-restore path; test fakes that model no NIC have nothing to wrap.
    this.installEgress();

    const timeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(
          `v86 did not become ready in ${timeoutMs}ms — the wasm/asset load likely failed silently ` +
          `(check wasmUrl=${inputs.wasmUrl}); v86 retries a bad wasm URL forever without throwing.`,
        )),
        timeoutMs,
      );
      this.emulator.add_listener("emulator-ready", () => { clearTimeout(timer); resolve(); });
    });
    // Re-install after restore: restoring from initial_state RECONSTRUCTS
    // network_adapter, so the pre-ready wrap above targets a dead object and the
    // live adapter's fetch is bare (pip 403s; npm masks it via 301). Idempotent
    // (marker guard), so the no-restore path where the object is unchanged is a
    // no-op. Found by the Round-13 net-e2e acceptance suite.
    this.installEgress();
    assertFs9pSymbols(this.emulator.fs9p);
    (this as { fs9p: Fs9p }).fs9p = this.emulator.fs9p as Fs9p;
  }

  run(): void { this.emulator.run(); }

  /** Wrap the live NAT adapter's fetch with the pypi egress shim (idempotent). */
  private installEgress(): void {
    const net = this.emulator.network_adapter as { fetch?: UpstreamFetch } | undefined;
    if (net && typeof net.fetch === "function") installEgressShim(net as { fetch: UpstreamFetch });
  }

  private readonly inputSenders = new Map<number, (b: Uint8Array) => void>();
  private readonly flushTimers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;

  /** Capacity-aware, coalescing sender for virtio-console input (FU2). v86's
   *  "-input-bytes" handler consumes ONE guest RX-ring slot (of 16) per bus.send
   *  regardless of payload size and SILENTLY DROPS input when the ring is empty;
   *  a burst of per-keystroke sends with no emulated-CPU slice in between (a busy
   *  browser tab flushing queued key events) loses every byte past the 16th —
   *  the first-command garble/drop. Coalesce pending bytes into bounded chunks
   *  and send only while the ring has free slots; otherwise retry on a short
   *  timer (v86 ignores the guest's RX replenish kick — no event to hook).
   *  Cached per port so a re-opened pty keeps one FIFO (byte order preserved). */
  private inputSender(port: 0 | 1 | 2 | 3): (b: Uint8Array) => void {
    const existing = this.inputSenders.get(port);
    if (existing) return existing;
    const queueId = port === 0 ? 0 : 2 * port + 2;
    const event = `virtio-console${port}-input-bytes`;
    let pending = new Uint8Array(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      timer = undefined;
      if (this.destroyed) return; // never re-arm (or touch the emulator) after teardown
      const q = assertVirtioConsoleQueue(
        this.emulator.v86?.cpu?.devices?.virtio_console?.virtio?.queues?.[queueId], queueId);
      while (pending.length && q.avail_addr && q.count_requests() > 0) {
        const chunk = pending.subarray(0, VIRTIO_INPUT_CHUNK);
        pending = pending.subarray(chunk.length);
        this.emulator.bus.send(event, chunk);
      }
      if (pending.length) {
        const t = setTimeout(() => { this.flushTimers.delete(t); flush(); }, 2);
        timer = t;
        this.flushTimers.add(t);
      }
    };
    const send = (b: Uint8Array): void => {
      // Dead host: drop, don't buffer — buffered bytes could resurface in a
      // later boot through a stale sender reference.
      if (this.destroyed || b.length === 0) return;
      const merged = new Uint8Array(pending.length + b.length);
      merged.set(pending, 0);
      merged.set(b, pending.length);
      pending = merged;
      if (!timer) flush();
    };
    this.inputSenders.set(port, send);
    return send;
  }

  channel(): GuestChannel {
    return {
      send: this.inputSender(0),
      subscribe: (cb: (bytes: Uint8Array) => void) => this.emulator.add_listener("virtio-console0-output-bytes", cb),
    };
  }

  terminal(port: 1 | 2 | 3): { send(b: Uint8Array): void; subscribe(cb: (b: Uint8Array) => void): () => void; resize(c: number, r: number): void } {
    const event = `virtio-console${port}-output-bytes`;
    return {
      send: this.inputSender(port),
      // Returns an unsubscribe fn — v86's bus pairs add_listener/remove_listener;
      // callers MUST detach so a reused port (1-3) doesn't deliver a disposed
      // session's data into a new one (I4).
      subscribe: (cb) => {
        this.emulator.add_listener(event, cb);
        return () => this.emulator.remove_listener(event, cb);
      },
      resize: (cols, rows) => this.emulator.bus.send(`virtio-console${port}-resize`, [cols, rows]),
    };
  }

  serial(): { send(s: string): void; onByte(cb: (b: number) => void): void } {
    return {
      send: (s: string) => this.emulator.serial0_send(s),
      onByte: (cb: (b: number) => void) => this.emulator.add_listener("serial0-output-byte", cb),
    };
  }

  /** v86's in-JS network adapter, for VmRuntime.dispatch's reverse-proxy into a
   *  real guest server. Available after boot(). */
  networkAdapter(): NetworkAdapter {
    return this.emulator.network_adapter as NetworkAdapter;
  }

  async saveState(): Promise<Uint8Array> {
    return new Uint8Array(await this.emulator.save_state());
  }

  async restoreState(buf: Uint8Array): Promise<void> {
    // Pass the view, not buf.buffer — v86 does `new Uint8Array(state)` and a
    // subarray/oversized backing buffer would append trailing garbage.
    await this.emulator.restore_state(buf);
  }

  async destroy(): Promise<void> {
    this.destroyed = true; // an in-flight flush() must not re-arm past this point
    for (const t of this.flushTimers) clearTimeout(t);
    this.flushTimers.clear();
    if (this.emulator) await this.emulator.destroy();
  }
}
