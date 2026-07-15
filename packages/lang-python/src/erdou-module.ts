import type { ExecContext, HttpHandler, HttpRequest, HttpResponse } from "@erdou/runtime-contract";
import type { Pyodide, PyProxy, PyCallable } from "./pyodide.js";
import { buildEnviron, collectResponse } from "./wsgi.js";

/**
 * Python that installs the importable `erdou` module and the JS↔Python WSGI
 * call helper. Prepended to the runner so it executes in Pyodide's `globals`
 * namespace on every script run:
 *
 *  - `erdou.serve(app, port=8000)` (a Python shim, so the default/keyword arg
 *    are handled in Python) forwards to the JS callable `__erdou_serve`, which
 *    the executor binds to the current `ExecContext.serve`.
 *  - `__erdou_call_wsgi(app, js_environ, js_body)` runs one WSGI request→response
 *    inside Python (cleaner than driving `start_response`/iteration from JS): it
 *    materialises `environ` from the JS object, attaches `wsgi.input`
 *    (a BytesIO of the request body) and `wsgi.errors`, invokes the app, drains
 *    the iterable to bytes, and returns `[status, headers, body_bytes]`. Any
 *    exception is turned into a 500 with the traceback in the body (fail-fast).
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

def __erdou_call_wsgi(app, js_environ, js_body):
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
        chunks = []
        try:
            for chunk in result:
                if chunk:
                    chunks.append(__erdou_to_bytes(chunk))
        finally:
            _close = getattr(result, 'close', None)
            if _close is not None:
                _close()
        body = b''.join(chunks)
        return [
            _captured.get('status', '500 Internal Server Error'),
            _captured.get('headers', []),
            body,
        ]
    except BaseException:
        _msg = ('WSGI application error:\\n' + __erdou_tb.format_exc()).encode('utf-8')
        return ['500 Internal Server Error', [['Content-Type', 'text/plain; charset=utf-8']], _msg]

def __erdou_serve_py(app, port=8000):
    __erdou_serve(port, app)

__erdou_mod = __erdou_types.ModuleType('erdou')
__erdou_mod.serve = __erdou_serve_py
__erdou_sys.modules['erdou'] = __erdou_mod
`;

function errorResponse(message: string): HttpResponse {
  return {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: new TextEncoder().encode(message),
  };
}

/**
 * Build the persistent HTTP handler that services requests for a served WSGI
 * `app`. Closes over the (copied, long-lived) `app` PyProxy and the persistent
 * Pyodide instance, so it keeps working after the script process exits.
 */
function makeWsgiHandler(py: Pyodide, app: PyCallable): HttpHandler {
  // Resolved once at serve time; `__erdou_call_wsgi` lives in Pyodide's globals
  // for the life of the instance, so the same handle is reused per request.
  const callWsgi = py.globals.get("__erdou_call_wsgi") as PyCallable;

  return async (req: HttpRequest): Promise<HttpResponse> => {
    let resultProxy: PyProxy | undefined;
    try {
      const environ = buildEnviron(req);
      resultProxy = callWsgi(app, environ, req.body) as PyProxy;
      const [status, headers, body] = resultProxy.toJs() as [string, [string, string][], Uint8Array];
      return collectResponse(status, headers, [body]);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      return errorResponse(`erdou WSGI bridge error:\n${detail}`);
    } finally {
      resultProxy?.destroy();
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
 */
export function createServeBinding(py: Pyodide, ctx: ExecContext): (port: number, appProxy: PyProxy) => void {
  return (port, appProxy) => {
    const app = appProxy.copy() as PyCallable;
    ctx.serve(port, makeWsgiHandler(py, app));
  };
}
