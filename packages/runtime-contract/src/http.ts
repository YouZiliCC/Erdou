/**
 * Generic HTTP request/response shapes for the in-browser virtual HTTP
 * server. These are plain data — no agent semantics — so any executor
 * (a built-in, a language runtime, a WASI host…) can register a handler
 * against a virtual port without depending on anything above this contract.
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /**
   * Optional streamed body. When present:
   *  - `body` MUST be an empty Uint8Array and is ignored — consumers read the
   *    body by iterating `stream` instead.
   *  - The response resolves at HEAD-time: status + headers are known, body
   *    chunks arrive as the producer yields them.
   *  - The iterable is SINGLE-USE: iterate it exactly once, to completion or
   *    to an early `return()`. Iterating to completion means the full body has
   *    been received.
   *  - An early iterator `return()` means "the client is gone" — the producer
   *    must stop yielding and release its resources (connections, handles).
   *
   * Absent on every buffered response (the overwhelmingly common case). As a
   * kernel policy (not contract surface), Erdou's producers engage streaming
   * only for `content-type: text/event-stream` responses; everything else is
   * delivered buffered, exactly as before this field existed.
   */
  stream?: AsyncIterable<Uint8Array>;
}

/** A program's handler for requests dispatched to the port it serves. */
export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

/**
 * A live WebSocket connection produced by `Runtime.upgrade` (see runtime.ts).
 * Plain data + single-subscriber callbacks — the same idiom as `HttpHandler`,
 * no streams/EventTarget machinery.
 *
 *  - `send`/`onMessage` carry a TEXT frame as `string` and a BINARY frame as
 *    `Uint8Array`.
 *  - `onMessage`/`onClose` register ONE subscriber each (a later call replaces
 *    the earlier one); messages that arrive before the first `onMessage` call
 *    are buffered and delivered on registration, so no frame is lost between
 *    the upgrade resolving and the consumer attaching.
 *  - `onClose` fires EXACTLY ONCE, whichever side ends the connection: a clean
 *    close handshake reports the peer's code/reason; an abnormal drop (TCP cut,
 *    protocol violation, runtime shutdown) reports code 1006 with a reason
 *    naming the cause.
 *  - `close()` starts the closing handshake; further `send` calls throw.
 */
export interface WsConnection {
  /** The subprotocol the server selected, or `""` when none was negotiated. */
  readonly protocol: string;
  send(data: string | Uint8Array): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  close(code?: number, reason?: string): void;
}
