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

function parseHeaderLines(headText: string): {
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
} {
  const lines = headText.split("\r\n");
  const statusLine = lines[0] ?? "";
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  if (!m) throw new Error(`parseHttpResponse: bad status line ${JSON.stringify(statusLine)}`);
  const headers: Record<string, string> = {};
  // Set-Cookie is the one legally-repeated response header — a single-valued
  // map would drop all but the last. Keep each raw value out of band so the
  // preview cookie jar sees every cookie the server set.
  const setCookies: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "set-cookie") {
      setCookies.push(value);
      continue;
    }
    headers[key] = value;
  }
  return { status: Number(m[1]), headers, setCookies };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Index of the first CRLF, or -1. */
function findCrlf(b: Uint8Array): number {
  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] === CR && b[i + 1] === LF) return i;
  }
  return -1;
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
 *  `Connection: close` (per-request connections), synthesizes a Host header if
 *  the caller supplied none, and sets `Content-Length` AUTHORITATIVELY from the
 *  body it actually appends.
 *
 *  The Content-Length is derived from `req.body`, NOT trusted from the caller's
 *  headers, because `Content-Length` is a forbidden header name the browser
 *  hides from a Service Worker — the preview SW forwards the request body but
 *  can never see (and so never carries) its Content-Length. Without this, a
 *  POST/PUT with a JSON body reached the guest server with no way to frame the
 *  body, so it read an empty body or blocked waiting for bytes it thought were
 *  coming (a hung request; a no-body POST was unaffected). Any incoming
 *  `content-length`/`transfer-encoding` is dropped so a stale value from the
 *  caller can never contradict the body we send. */
export function serializeHttpRequest(req: HttpRequest): Uint8Array {
  const method = req.method.toUpperCase();
  const body = req.body ?? new Uint8Array();
  const entries = Object.entries(req.headers);
  const hasHost = entries.some(([k]) => k.toLowerCase() === "host");
  const lines = [`${method} ${req.url} HTTP/1.1`];
  if (!hasHost) lines.push("Host: erdou.local");
  for (const [k, v] of entries) {
    const lk = k.toLowerCase();
    // `connection` and the body-framing headers are set by us below, from the
    // actual body — never forwarded from the caller.
    if (lk === "connection" || lk === "content-length" || lk === "transfer-encoding") continue;
    lines.push(`${k}: ${v}`);
  }
  if (body.length > 0) lines.push(`Content-Length: ${body.length}`);
  lines.push("Connection: close");
  const head = new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n");
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** Parse raw HTTP response bytes into a contract HttpResponse. */
export function parseHttpResponse(bytes: Uint8Array): HttpResponse {
  const sep = headerEnd(bytes);
  if (sep === -1) throw new Error("parseHttpResponse: no header/body separator (CRLFCRLF)");
  const { status, headers, setCookies } = parseHeaderLines(latin1(bytes.subarray(0, sep)));
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
  return setCookies.length > 0 ? { status, headers, body, setCookies } : { status, headers, body };
}

/** A parsed response HEAD — status line + headers — available before (any of)
 *  the body has arrived. `framing` reports how the wire body is delimited so a
 *  caller can stream it; the framing headers themselves are stripped from
 *  `headers` (same rule as `parseHttpResponse`: the returned headers must
 *  never let a consumer re-frame the body). `bodyOffset` indexes the first
 *  body byte in the bytes that were parsed. */
export interface ParsedHead {
  status: number;
  headers: Record<string, string>;
  bodyOffset: number;
  framing: "content-length" | "chunked" | "close";
  /** Raw `Set-Cookie` values (see HttpResponse.setCookies). */
  setCookies: string[];
}

/** Incrementally parse a response head out of accumulated bytes. Returns null
 *  while the CRLFCRLF header terminator has not arrived yet; throws on a
 *  malformed status line (same rule as `parseHttpResponse`). */
export function parseHead(bytes: Uint8Array): ParsedHead | null {
  const sep = headerEnd(bytes);
  if (sep === -1) return null;
  const { status, headers, setCookies } = parseHeaderLines(latin1(bytes.subarray(0, sep)));
  const te = (headers["transfer-encoding"] ?? "").toLowerCase();
  const framing =
    headers["content-length"] !== undefined ? "content-length" : te.includes("chunked") ? "chunked" : "close";
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  return { status, headers, bodyOffset: sep + 4, framing, setCookies };
}

/**
 * Incremental Transfer-Encoding: chunked decoder for STREAMED bodies (the SSE
 * dispatch path) — `dechunk` above stays the one-shot variant for buffered
 * parses. Feed wire bytes as they arrive; each `push` returns the data chunks
 * it decoded (possibly none). `finished` flips at the 0-size terminator
 * (trailers are ignored; bytes after the terminator are dropped). Malformed
 * framing throws — fail-fast: the caller must surface it as a stream error,
 * never as a silently truncated body.
 */
export class ChunkedDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  /** Data bytes still owed by the current chunk. */
  private need = 0;
  /** CRLF bytes to skip after the current chunk's data. */
  private skip = 0;
  private done = false;

  get finished(): boolean {
    return this.done;
  }

  push(data: Uint8Array): Uint8Array[] {
    if (this.done) return [];
    this.buf = this.buf.length === 0 ? data.slice() : concat([this.buf, data]);
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buf.length);
        this.buf = this.buf.subarray(n);
        this.skip -= n;
        if (this.skip > 0) return out; // buffer exhausted mid-CRLF
        continue;
      }
      if (this.need > 0) {
        if (this.buf.length === 0) return out;
        const n = Math.min(this.need, this.buf.length);
        out.push(this.buf.slice(0, n));
        this.buf = this.buf.subarray(n);
        this.need -= n;
        if (this.need === 0) this.skip = 2; // the CRLF that closes the chunk data
        continue;
      }
      // At a chunk-size line.
      const eol = findCrlf(this.buf);
      if (eol === -1) return out; // size line not complete yet
      const line = latin1(this.buf.subarray(0, eol));
      const size = parseInt((line.split(";")[0] ?? "").trim(), 16);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error(`ChunkedDecoder: malformed chunk-size line ${JSON.stringify(line)}`);
      }
      this.buf = this.buf.subarray(eol + 2);
      if (size === 0) {
        this.done = true;
        this.buf = new Uint8Array(0);
        return out;
      }
      this.need = size;
    }
  }
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
