import { describe, it, expect } from "vitest";
import { fetchToHttpRequest, httpResponseToResponse, installPreviewBridge, resolvePort } from "./preview-bridge.js";

describe("preview-bridge marshalling", () => {
  it("marshals a fetch Request to HttpRequest and back", async () => {
    const req = new Request("http://x/__preview__/8000/api?q=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const hr = await fetchToHttpRequest(req, "/api?q=1");
    expect(hr.method).toBe("POST");
    expect(hr.url).toBe("/api?q=1");
    expect(hr.headers["content-type"]).toBe("application/json");
    expect(new TextDecoder().decode(hr.body)).toBe("{}");

    const res = httpResponseToResponse({
      status: 201,
      headers: { "x-a": "b" },
      body: new TextEncoder().encode("ok"),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("b");
    expect(await res.text()).toBe("ok");
  });

  it("gives a GET request an empty body without reading it", async () => {
    const req = new Request("http://x/__preview__/8000/", { method: "GET" });
    const hr = await fetchToHttpRequest(req, "/");
    expect(hr.method).toBe("GET");
    expect(hr.url).toBe("/");
    expect(hr.body).toBeInstanceOf(Uint8Array);
    expect(hr.body.length).toBe(0);
  });

  it("preserves a POST JSON body byte-for-byte", async () => {
    const payload = JSON.stringify({ hello: "world", n: 42 });
    const req = new Request("http://x/__preview__/3000/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const hr = await fetchToHttpRequest(req, "/submit");
    expect(new TextDecoder().decode(hr.body)).toBe(payload);
  });

  it("round-trips response status and multiple headers", async () => {
    const res = httpResponseToResponse({
      status: 404,
      headers: { "content-type": "text/plain", "x-erdou": "1" },
      body: new TextEncoder().encode("Not Found"),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-erdou")).toBe("1");
    expect(await res.text()).toBe("Not Found");
  });

  it("uses a null body for null-body statuses (204) so Response does not throw", async () => {
    const res = httpResponseToResponse({ status: 204, headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("resolvePort", () => {
  it("routes a relative fetch (no /__port__/ segment) to the primary port", () => {
    expect(resolvePort("/__preview__/8080/api", 8080)).toEqual({ port: 8080, rest: "/api" });
  });

  it("an explicit /__port__/<n>/ segment right after the scope wins over the primary", () => {
    expect(resolvePort("/__preview__/8080/__port__/8000/api", 8080)).toEqual({ port: 8000, rest: "/api" });
  });

  it("preserves a nested rest past the /__port__/<n> override", () => {
    expect(resolvePort("/__preview__/8080/__port__/8000/a/b/c", 8080)).toEqual({ port: 8000, rest: "/a/b/c" });
  });

  it("normalizes an empty or trailing-slash-only rest to '/' for the primary", () => {
    expect(resolvePort("/__preview__/8080", 8080)).toEqual({ port: 8080, rest: "/" });
    expect(resolvePort("/__preview__/8080/", 8080)).toEqual({ port: 8080, rest: "/" });
  });

  it("normalizes an empty or trailing-slash-only rest to '/' for a sibling override", () => {
    expect(resolvePort("/__preview__/8080/__port__/8000", 8080)).toEqual({ port: 8000, rest: "/" });
    expect(resolvePort("/__preview__/8080/__port__/8000/", 8080)).toEqual({ port: 8000, rest: "/" });
  });
});

describe("installPreviewBridge", () => {
  it("is a guarded no-op where navigator has no serviceWorker", () => {
    // The vitest "node" env exposes `navigator` but not `serviceWorker`, so the
    // bridge must skip installation instead of throwing.
    expect(() =>
      installPreviewBridge({
        dispatch: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
      }),
    ).not.toThrow();
  });
});
