export interface PtyChannel {
  send(bytes: Uint8Array): void;
  /** Returns an unsubscribe function — callers MUST detach on dispose/failure so a
   *  reused port doesn't deliver a stale session's data to a new one (I4). */
  subscribe(cb: (bytes: Uint8Array) => void): () => void;
  resize(cols: number, rows: number): void;
}

export interface PtySession {
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  resize(cols: number, rows: number): void;
  dispose(): Promise<void>;
}

const READY = new TextEncoder().encode("PTYBRIDGE_READY");

/** Wrap a PtyChannel as a streaming PtySession. CRITICAL ORDERING (Spike F): it
 *  SUBSCRIBES to the channel synchronously FIRST, then calls `launch()` (which
 *  sends the guest the pty-open request) — otherwise the guest's PTYBRIDGE_READY
 *  banner is emitted before any listener exists and is lost forever (v86 buffers
 *  nothing), hanging boot. Resolves once BOTH the banner is seen AND launch()
 *  yields the bridge pid; rejects on a deadline (fail-fast parity with boot).
 *  Pre-ready writes and pre-onData data are buffered, not dropped. dispose() kills
 *  the bridge by pid. */
export function openPtySession(
  channel: PtyChannel,
  launch: () => Promise<{ pid: number }>,
  kill: (pid: number) => Promise<void>,
  opts: { deadlineMs?: number } = {},
): Promise<PtySession> {
  return new Promise((resolve, reject) => {
    let ready = false, settled = false;
    let banner = new Uint8Array(0);
    let pid: number | undefined;
    const preReady: Uint8Array[] = [];     // write()s issued before READY
    const buffered: Uint8Array[] = [];     // data arriving before onData is registered
    let dataCb: ((d: Uint8Array) => void) | undefined;
    const deadlineMs = opts.deadlineMs ?? 15_000;
    let unsubscribe: () => void = () => {}; // assigned synchronously below, before any async settle path can run

    const deadline = setTimeout(() => {
      if (settled) return; settled = true;
      unsubscribe(); // detach — a failed/timed-out session must not keep receiving channel data
      // Reap the bridge process if launch() already resolved with a pid
      if (pid !== undefined) {
        void kill(pid).catch(() => {});
      }
      reject(new Error(`pty bridge did not announce PTYBRIDGE_READY within ${deadlineMs}ms`));
    }, deadlineMs);

    const emitData = (d: Uint8Array) => { if (dataCb) dataCb(d); else buffered.push(d); };
    const maybeResolve = () => {
      if (settled || !ready || pid === undefined) return;
      settled = true; clearTimeout(deadline); resolve(session);
    };

    const session: PtySession = {
      write: (d) => { if (ready) channel.send(d); else preReady.push(d); },
      onData: (cb) => { dataCb = cb; for (const b of buffered) cb(b); buffered.length = 0; }, // flush pre-onData buffer
      resize: (cols, rows) => channel.resize(cols, rows),
      dispose: async () => {
        unsubscribe(); // detach so a reused port doesn't cross-talk into this disposed session
        if (pid !== undefined) await kill(pid).catch(() => {});
      },
    };

    // 1) SUBSCRIBE FIRST — before launch(), so we cannot miss the READY banner.
    unsubscribe = channel.subscribe((bytes) => {
      if (ready) { emitData(bytes); return; }
      const merged = new Uint8Array(banner.length + bytes.length);
      merged.set(banner, 0); merged.set(bytes, banner.length);
      const idx = indexOf(merged, READY);
      if (idx === -1) { banner = merged; return; }
      ready = true;
      for (const w of preReady) channel.send(w); preReady.length = 0;
      const after = merged.subarray(idx + READY.length);
      const nl = after.indexOf(0x0a);
      const rest = nl === -1 ? new Uint8Array(0) : after.subarray(nl + 1);
      if (rest.length) emitData(rest.slice());   // held until onData registers (I3)
      maybeResolve();
    });

    // 2) THEN launch the guest bridge (sends the PTY_OPEN frame).
    launch().then(
      (c) => { pid = c.pid; maybeResolve(); },
      (err) => { if (!settled) { settled = true; clearTimeout(deadline); reject(err); } },
    );
  });
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
