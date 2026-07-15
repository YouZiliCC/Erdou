import { describe, it, expect } from "vitest";
import { fetchToHttpRequest, httpResponseToResponse, installPreviewBridge } from "./preview-bridge.js";

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
