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
  // Framing headers describe the WIRE encoding, which the parse just consumed:
  // chunked bodies are de-chunked above, and a body shorter than Content-Length
  // is clamped (subarray). Keeping them would let a consumer re-frame a body
  // that no longer matches — e.g. the preview SW's
  // `new Response(body, { headers })` would declare a Content-Length the body
  // can't honor or a chunked encoding the body no longer has. Keys are already
  // lowercased by parseHeaderLines, so these deletes are case-insensitively
  // complete.
  delete headers["content-length"];
  delete headers["transfer-encoding"];
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
