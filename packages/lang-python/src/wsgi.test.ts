import { describe, it, expect } from "vitest";
import { buildEnviron, collectResponse } from "./wsgi.js";

describe("buildEnviron (pure WSGI marshalling)", () => {
  it("builds a WSGI environ from an HttpRequest", () => {
    const env = buildEnviron({
      method: "POST",
      url: "/a/b?x=1",
      headers: { "content-type": "application/json", host: "h" },
      body: new TextEncoder().encode("{}"),
    });
    expect(env.REQUEST_METHOD).toBe("POST");
    expect(env.PATH_INFO).toBe("/a/b");
    expect(env.QUERY_STRING).toBe("x=1");
    expect(env.CONTENT_TYPE).toBe("application/json");
    expect(env.HTTP_HOST).toBe("h");
  });

  it("has an empty QUERY_STRING when the url has no query", () => {
    const env = buildEnviron({ method: "GET", url: "/", headers: {}, body: new Uint8Array() });
    expect(env.PATH_INFO).toBe("/");
    expect(env.QUERY_STRING).toBe("");
    expect(env.REQUEST_METHOD).toBe("GET");
  });

  it("maps arbitrary headers to HTTP_* (uppercased, dashes to underscores) and keeps CONTENT_* separate", () => {
    const env = buildEnviron({
      method: "GET",
      url: "/x",
      headers: { "X-Custom-Header": "v", "content-length": "5", accept: "text/html" },
      body: new TextEncoder().encode("hello"),
    });
    expect(env.HTTP_X_CUSTOM_HEADER).toBe("v");
    expect(env.HTTP_ACCEPT).toBe("text/html");
    expect(env.CONTENT_LENGTH).toBe("5");
    // content-length must not also leak into HTTP_*
    expect(env.HTTP_CONTENT_LENGTH).toBeUndefined();
    expect(env["wsgi.url_scheme"]).toBe("http");
  });

  it("derives CONTENT_LENGTH from the body when no header is present", () => {
    const env = buildEnviron({ method: "POST", url: "/p", headers: {}, body: new TextEncoder().encode("abcd") });
    expect(env.CONTENT_LENGTH).toBe("4");
  });
});

describe("collectResponse (pure WSGI marshalling)", () => {
  it("collects a WSGI response into HttpResponse", () => {
    const res = collectResponse(
      "201 Created",
      [
        ["Content-Type", "text/plain"],
        ["X-A", "b"],
      ],
      [new TextEncoder().encode("ok")],
    );
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.headers["x-a"]).toBe("b");
    expect(new TextDecoder().decode(res.body)).toBe("ok");
  });

  it("concatenates multiple body chunks in order", () => {
    const res = collectResponse(
      "200 OK",
      [],
      [new TextEncoder().encode("foo"), new TextEncoder().encode("bar"), new Uint8Array(), new TextEncoder().encode("baz")],
    );
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe("foobarbaz");
  });
});
