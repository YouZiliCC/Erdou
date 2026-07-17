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

  it("strips content-length: the materialized body is the framing", () => {
    const res = parseHttpResponse(bytes("HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello"));
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("text/plain"); // non-framing headers survive
    expect(dec.decode(res.body)).toBe("hello");
  });

  it("strips transfer-encoding after de-chunking (the returned body has no chunk framing to describe)", () => {
    const res = parseHttpResponse(bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"));
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(dec.decode(res.body)).toBe("hello");
  });

  it("T3a: a body truncated below Content-Length is clamped AND carries no contradicting content-length header", () => {
    // Guest died / idle-completion fired mid-body: only 5 of 100 bytes arrived.
    const res = parseHttpResponse(bytes("HTTP/1.0 200 OK\r\nContent-Length: 100\r\n\r\nhello"));
    expect(res.status).toBe(200);
    expect(dec.decode(res.body)).toBe("hello"); // clamped, not padded
    expect(res.headers["content-length"]).toBeUndefined(); // framing can no longer lie
  });

  it("strips framing headers regardless of wire-case (CONTENT-LENGTH / Transfer-ENCODING)", () => {
    const res = parseHttpResponse(bytes("HTTP/1.0 200 OK\r\nCONTENT-LENGTH: 2\r\n\r\nokEXTRA"));
    expect(res.headers["content-length"]).toBeUndefined();
    expect(dec.decode(res.body)).toBe("ok"); // the value was still honored for clamping
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
