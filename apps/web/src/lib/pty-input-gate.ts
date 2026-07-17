/**
 * Gate for PtyTerminal keystrokes during the [mount → openPty() settles] window.
 * xterm fires onData immediately, but the PtySession doesn't exist yet — without
 * a gate those keystrokes are silently dropped (xterm buffers nothing). Queue
 * chunks until open(sink) attaches the live session, then flush in order and
 * forward directly; close() (openPty rejected, or unmount) drops the queue and
 * ignores everything after.
 */
export interface PtyInputGate {
  input(bytes: Uint8Array): void;
  open(sink: (bytes: Uint8Array) => void): void;
  close(): void;
}

export function makePtyInputGate(): PtyInputGate {
  let sink: ((bytes: Uint8Array) => void) | undefined;
  let closed = false;
  const queue: Uint8Array[] = [];
  return {
    input(bytes) {
      if (closed) return;
      if (sink) sink(bytes);
      else queue.push(bytes);
    },
    open(s) {
      if (closed) return;
      sink = s;
      for (const b of queue) s(b);
      queue.length = 0;
    },
    close() {
      closed = true;
      sink = undefined;
      queue.length = 0;
    },
  };
}
