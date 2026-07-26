import type { ExecContext, HttpHandler, HttpRequest, HttpResponse, WritableByteStream } from "@erdou/runtime-contract";
import type { Pyodide, PyProxy, PyCallable } from "./pyodide.js";
import { buildEnviron, collectResponse } from "./wsgi.js";

/**
 * Python that installs the importable `erdou` module and the JS↔Python WSGI
 * call primitives. Prepended to the runner so it executes in Pyodide's
 * `globals` namespace on every script run:
 *
 *  - `erdou.serve(app, port=8000)` (a Python shim, so the default/keyword arg
 *    are handled in Python) forwards to the JS callable `__erdou_serve`, which
 *    the executor binds to the current `ExecContext.serve`.
 *  - `__erdou_wsgi_start(app, js_environ, js_body)` begins one WSGI exchange
 *    inside Python: it materialises `environ` from the JS object, attaches
 *    `wsgi.input` (a BytesIO of the request body) and `wsgi.errors`, invokes
 *    the app, and — for a generator app that defers `start_response` to its
 *    first iteration (PEP 3333) — pulls until the head is known. Returns
 *    `[status, headers, first_chunk, exhausted, token]`; `token` keys the
 *    still-live iterable in a Python-side registry so the body can be pulled
 *    incrementally (the SSE streaming path) or drained (everything else).
 *  - `__erdou_wsgi_next(token)` pulls the next non-empty body chunk: bytes;
 *    or `None` when exhausted (the iterable's PEP 3333 `close()` has run and
 *    the registry entry is gone); or a one-element `[error_bytes]` list when
 *    the app raised mid-body (also closed + deregistered).
 *  - `__erdou_wsgi_close(token)` releases an abandoned stream (client gone):
 *    PEP 3333 `close()` + registry removal. Idempotent via the registry.
 *
 *  Any failure before the head is returned becomes a 500 with the traceback in
 *  the body (fail-fast), exactly like the old single-shot `__erdou_call_wsgi`.
 */
export const ERDOU_SETUP = `
import sys as __erdou_sys, types as __erdou_types, io as __erdou_io, traceback as __erdou_tb

def __erdou_to_bytes(b):
    if b is None:
        return b''
    if isinstance(b, (bytes, bytearray)):
        return bytes(b)
    _to_py = getattr(b, 'to_py', None)
    if _to_py is not None:
        return bytes(_to_py())
    return bytes(b)

__erdou_wsgi_streams = {}
__erdou_wsgi_seq = [0]

def __erdou_wsgi_error_body():
    return ('WSGI application error:\\n' + __erdou_tb.format_exc()).encode('utf-8')

def __erdou_wsgi_start(app, js_environ, js_body):
    result = None
    try:
        environ = js_environ.to_py() if hasattr(js_environ, 'to_py') else dict(js_environ)
        environ['wsgi.input'] = __erdou_io.BytesIO(__erdou_to_bytes(js_body))
        environ['wsgi.errors'] = __erdou_sys.stderr
        _captured = {}
        def start_response(status, response_headers, exc_info=None):
            _captured['status'] = status
            _captured['headers'] = [[str(k), str(v)] for (k, v) in response_headers]
            return lambda data=b'': None
        result = app(environ, start_response)
        it = iter(result)
        first = b''
        exhausted = False
        # PEP 3333 lets a generator app defer start_response until its first
        # iteration: pull (skipping empty chunks, like the old drain) until the
        # head is known or the body ends, so the head can be answered before
        # the rest of the body is produced.
        while 'status' not in _captured:
            try:
                chunk = next(it)
            except StopIteration:
                exhausted = True
                break
            data = __erdou_to_bytes(chunk)
            if data:
                first = data
                break
        token = None
        if exhausted:
            _close = getattr(result, 'close', None)
            if _close is not None:
                _close()
        else:
            __erdou_wsgi_seq[0] += 1
            token = __erdou_wsgi_seq[0]
            __erdou_wsgi_streams[token] = (result, it)
        return [
            _captured.get('status', '500 Internal Server Error'),
            _captured.get('headers', []),
            first,
            exhausted,
            token,
        ]
    except BaseException:
        if result is not None:
            try:
                _close = getattr(result, 'close', None)
                if _close is not None:
                    _close()
            except BaseException:
                pass
        _msg = __erdou_wsgi_error_body()
        return ['500 Internal Server Error', [['Content-Type', 'text/plain; charset=utf-8']], _msg, True, None]

def __erdou_wsgi_next(token):
    entry = __erdou_wsgi_streams.get(token)
    if entry is None:
        return None
    result, it = entry
    try:
        while True:
            try:
                chunk = next(it)
            except StopIteration:
                break
            data = __erdou_to_bytes(chunk)
            if data:
                return data
        del __erdou_wsgi_streams[token]
        _close = getattr(result, 'close', None)
        if _close is not None:
            _close()
        return None
    except BaseException:
        if __erdou_wsgi_streams.pop(token, None) is not None:
            try:
                _close = getattr(result, 'close', None)
                if _close is not None:
                    _close()
            except BaseException:
                pass
        return [__erdou_wsgi_error_body()]

def __erdou_wsgi_close(token):
    entry = __erdou_wsgi_streams.pop(token, None)
    if entry is None:
        return
    result, _it = entry
    _close = getattr(result, 'close', None)
    if _close is not None:
        _close()

def __erdou_serve_py(app, port=8000):
    __erdou_serve(port, app)

__erdou_mod = __erdou_types.ModuleType('erdou')
__erdou_mod.serve = __erdou_serve_py
__erdou_sys.modules['erdou'] = __erdou_mod
`;

/** Where Pyodide's stdout/stderr should land — an `ExecContext` satisfies it. */
export interface OutputTarget {
  stdout: WritableByteStream;
  stderr: WritableByteStream;
}

// Pyodide exposes no getter for its current output routing, so remember the
// last target set per instance: a served request can land in the middle of a
// `runPythonAsync`, and it has to put back the routing it interrupted.
const routed = new WeakMap<Pyodide, OutputTarget>();

/**
 * Point Pyodide's INSTANCE-WIDE stdout/stderr at `target`, returning a restore
 * for whatever routing it replaced. Every re-point must go through here: the
 * served WSGI handler runs outside any run and re-points per request, so a
 * python/pip run whose routing it clobbered would otherwise lose the rest of
 * its output into the served app's streams.
 *
 * Writes reach the stream only while it is open. A served app keeps writing
 * long after the launching process exited — a plain `print()`, or `wsgi.errors`
 * which ERDOU_SETUP binds to `sys.stderr` — and writing to a closed pipe throws
 * EBADF, which `__erdou_wsgi_start`'s `except BaseException` would turn into a
 * 500 + traceback for every such request. That output is a log line, not the
 * response: drop it once there is no stream left to reach. The user is told
 * this will happen, once, at serve time (see `createServeBinding`) — a drop
 * nobody is warned about is the failure mode this codebase refuses.
 */
export function routeOutput(py: Pyodide, target: OutputTarget): () => void {
  const previous = routed.get(py);
  routed.set(py, target);
  py.setStdout({ batched: (t) => writeIfOpen(target.stdout, t) });
  py.setStderr({ batched: (t) => writeIfOpen(target.stderr, t) });
  return () => {
    if (previous) {
      routeOutput(py, previous);
      return;
    }
    // Nothing was routed before this call, so there is no owner to hand the
    // instance back to. Leaving `target` installed would send whatever Python
    // writes next — a stray thread, a later request's callback — into a run
    // that is no longer listening; unset instead, so the next writer has to
    // route first.
    routed.delete(py);
    py.setStdout({ batched: () => {} });
    py.setStderr({ batched: () => {} });
  };
}

// `isClosed` is the concrete pipe's (runtime-browser `PipeStream`), not part of
// the `WritableByteStream` contract — read it structurally and treat a stream
// that does not report closedness as open, so a genuine write failure still
// surfaces instead of being swallowed by a blanket try/catch.
function writeIfOpen(stream: WritableByteStream, text: string): void {
  if ((stream as { isClosed?: boolean }).isClosed === true) return;
  stream.write(text);
}

function errorResponse(message: string): HttpResponse {
  return {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: new TextEncoder().encode(message),
  };
}

/** Media-type check for the streaming engage rule: `text/event-stream` ONLY
 *  (parameters like `; charset=utf-8` ignored). Everything else buffers. */
function isEventStream(contentType: string | undefined): boolean {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "text/event-stream";
}

/**
 * Build the persistent HTTP handler that services requests for a served WSGI
 * `app`. Closes over the (copied, long-lived) `app` PyProxy and the persistent
 * Pyodide instance, so it keeps working after the script process exits.
 *
 * Streaming: a `text/event-stream` head resolves at head-time with a
 * single-use `stream` (see `HttpResponse.stream`); each pull is ONE
 * synchronous Pyodide call into the app's iterator — so this suits
 * yield-driven streams, while a producer that `time.sleep()`s between yields
 * blocks the main thread for that sleep on every pull (paced SSE servers
 * belong on the VM kernel). Every other response drains to completion,
 * byte-identical to the old single-shot bridge.
 *
 * `output` is captured at serve time and re-established around every call into
 * Python, because the routing Pyodide happens to carry when a request arrives
 * belongs to some unrelated (often already-exited) run.
 */
function makeWsgiHandler(py: Pyodide, app: PyCallable, output: OutputTarget): HttpHandler {
  // Resolved once at serve time; the `__erdou_wsgi_*` primitives live in
  // Pyodide's globals for the life of the instance, so the same handles are
  // reused per request.
  const wsgiStart = py.globals.get("__erdou_wsgi_start") as PyCallable;
  const wsgiNext = py.globals.get("__erdou_wsgi_next") as PyCallable;
  const wsgiClose = py.globals.get("__erdou_wsgi_close") as PyCallable;

  // Wraps every call INTO Python (head, body pull, close). Without it a view's
  // `print()` writes into whichever run last touched this instance: the exited
  // launching process (EBADF → a 500 for a request that actually succeeded), or
  // a python/pip run in flight (its output silently interleaved with the app's).
  const inPython = <T>(call: () => T): T => {
    const restore = routeOutput(py, output);
    try {
      return call();
    } finally {
      restore();
    }
  };

  // Pull the next non-empty body chunk out of Python. Three outcomes,
  // mirroring `__erdou_wsgi_next`: a bytes chunk; null = exhausted (closed on
  // the Python side); or `{error}` = the app raised mid-body (also closed).
  const pullNext = (token: number): Uint8Array | { error: Uint8Array } | null => {
    const r = inPython(() => wsgiNext(token)) as PyProxy | undefined | null;
    if (r == null) return null;
    try {
      const v = r.toJs() as Uint8Array | [Uint8Array];
      return v instanceof Uint8Array ? v : { error: v[0] };
    } finally {
      r.destroy();
    }
  };

  function streamBody(first: Uint8Array, token: number): AsyncIterable<Uint8Array> {
    // Release the Python side — PEP 3333 close() runs in `__erdou_wsgi_close`.
    // The token registry makes this idempotent (normal exhaustion already
    // deregistered), and the local flag keeps double calls cheap.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        inPython(() => wsgiClose(token));
      } catch {
        // The client is gone — there is no one left to report a close error to.
      }
    };
    async function* gen(): AsyncGenerator<Uint8Array> {
      try {
        if (first.length > 0) yield first;
        for (;;) {
          const c = pullNext(token);
          if (c === null) return;
          if (c instanceof Uint8Array) {
            yield c;
            continue;
          }
          // Mid-stream failure after the head went out: error the stream (the
          // consumer sees a real network error) — fail fast, never a silently
          // truncated "success".
          throw new Error(new TextDecoder().decode(c.error));
        }
      } finally {
        release();
      }
    }
    const g = gen();
    // Hand-rolled iterator around the generator: a `return()` BEFORE the first
    // `next()` (client cancels instantly) completes a never-started generator
    // WITHOUT running its finally — so release explicitly on that path too.
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => g.next(),
          async return(): Promise<IteratorResult<Uint8Array>> {
            const r = await g.return(undefined);
            release();
            return r;
          },
        };
      },
    };
  }

  return async (req: HttpRequest): Promise<HttpResponse> => {
    let startProxy: PyProxy | undefined;
    try {
      const environ = buildEnviron(req);
      startProxy = inPython(() => wsgiStart(app, environ, req.body)) as PyProxy;
      const [status, headers, first, exhausted, token] = startProxy.toJs() as [
        string,
        [string, string][],
        Uint8Array,
        boolean,
        number | null | undefined,
      ];
      const head = collectResponse(status, headers, []);
      const live = !exhausted && token != null;

      if (live && isEventStream(head.headers["content-type"])) {
        return { ...head, stream: streamBody(first, token) };
      }

      // Buffered (every non-SSE response): drain to completion.
      const chunks: Uint8Array[] = first.length > 0 ? [first] : [];
      if (live) {
        for (;;) {
          const c = pullNext(token);
          if (c === null) break;
          if (c instanceof Uint8Array) {
            chunks.push(c);
            continue;
          }
          // The app raised mid-body and nothing was sent yet: same 500 +
          // traceback body the old single-shot drain produced.
          return collectResponse(
            "500 Internal Server Error",
            [["Content-Type", "text/plain; charset=utf-8"]],
            [c.error],
          );
        }
      }
      return collectResponse(status, headers, chunks);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      return errorResponse(`erdou WSGI bridge error:\n${detail}`);
    } finally {
      startProxy?.destroy();
    }
  };
}

/**
 * The JS callable bound into Pyodide as `__erdou_serve`. Python invokes it from
 * `erdou.serve(app, port)` while the script runs (so `ctx.serve` — and the
 * synchronous `port.opened` it emits — happens during the run, and the preview
 * panel sees the port immediately).
 *
 * CRITICAL — PyProxy lifetime: `appProxy` is the argument proxy Pyodide created
 * for the call; it is auto-destroyed when this function returns. We take an
 * owned `.copy()` and close the handler over it, so the WSGI `app` stays valid
 * for every future request — well past the script's exit and the executor's
 * `syncBack`/teardown (which never touches it). The copy is intentionally never
 * destroyed: the server lives for the life of the Pyodide instance.
 *
 * The launching run's streams are captured here too and re-established per
 * request (see `makeWsgiHandler`): Pyodide's output routing is instance-wide,
 * so a served app that never bound its own would print into whatever run last
 * touched the instance.
 *
 * Those streams close when the script exits — which on the browser kernel is
 * immediately after `erdou.serve` returns — and `routeOutput` then drops every
 * line the app prints while handling requests. Say so HERE, on the launching
 * run's stderr while it is still open: silently discarding a view's `print()`
 * for the rest of the session, with nothing anywhere to explain where it went,
 * is worse than the one advisory line.
 */
export function createServeBinding(py: Pyodide, ctx: ExecContext): (port: number, appProxy: PyProxy) => void {
  return (port, appProxy) => {
    const app = appProxy.copy() as PyCallable;
    ctx.serve(port, makeWsgiHandler(py, app, ctx));
    ctx.stderr.write(
      `erdou.serve: note: port ${port} keeps serving after this script exits, but its stdout/stderr close with the ` +
        `script — anything the app prints while handling later requests (print(), wsgi.errors) is not captured. ` +
        `Write to a file under the workspace if you need those logs.\n`,
    );
  };
}
