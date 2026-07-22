import { describe, it, expect } from "vitest";
import { PreviewCookieJar, parseSetCookie, defaultPath, pathMatches } from "./preview-cookies.js";

const T0 = 1_000_000; // fixed clock base (ms)

describe("defaultPath / pathMatches", () => {
  it("default-path strips the last segment", () => {
    expect(defaultPath("/api/guess")).toBe("/api");
    expect(defaultPath("/guess")).toBe("/");
    expect(defaultPath("/")).toBe("/");
    expect(defaultPath("/a/b/c?q=1")).toBe("/a/b");
  });

  it("path-match: prefix on a boundary, exact, or trailing slash", () => {
    expect(pathMatches("/", "/anything")).toBe(true);
    expect(pathMatches("/api", "/api")).toBe(true);
    expect(pathMatches("/api", "/api/guess")).toBe(true);
    expect(pathMatches("/api", "/apiary")).toBe(false); // not a path boundary
    expect(pathMatches("/api/", "/api/x")).toBe(true);
  });
});

describe("parseSetCookie", () => {
  it("name=value with default path", () => {
    expect(parseSetCookie("sid=abc", "/api/guess", T0)).toEqual({
      name: "sid",
      value: "abc",
      path: "/api",
      expiresAt: null,
    });
  });

  it("explicit Path and Max-Age (Max-Age → expiry from now)", () => {
    expect(parseSetCookie("a=1; Path=/; Max-Age=60", "/x", T0)).toEqual({
      name: "a",
      value: "1",
      path: "/",
      expiresAt: T0 + 60_000,
    });
  });

  it("Max-Age wins over Expires", () => {
    const c = parseSetCookie("a=1; Expires=Wed, 09 Jun 2100 10:18:14 GMT; Max-Age=10", "/", T0);
    expect(c?.expiresAt).toBe(T0 + 10_000);
  });

  it("rejects a nameless cookie", () => {
    expect(parseSetCookie("=x", "/", T0)).toBeNull();
    expect(parseSetCookie("nonsense", "/", T0)).toBeNull();
  });
});

describe("PreviewCookieJar", () => {
  const jar = (now = () => T0) => new PreviewCookieJar(now);

  it("stores a cookie and re-emits it as a Cookie header for a matching path", () => {
    const j = jar();
    j.store(5000, "/", ["sid=abc; Path=/"]);
    expect(j.header(5000, "/api/guess")).toBe("sid=abc");
  });

  it("keeps multiple cookies (the collapse bug this fixes)", () => {
    const j = jar();
    j.store(5000, "/", ["target=42; Path=/", "attempts=1; Path=/"]);
    expect(j.header(5000, "/api/guess")).toBe("target=42; attempts=1");
  });

  it("same name+path overwrites (attempts increments across guesses)", () => {
    const j = jar();
    j.store(5000, "/", ["attempts=1; Path=/"]);
    j.store(5000, "/", ["attempts=2; Path=/"]);
    expect(j.header(5000, "/api/guess")).toBe("attempts=2");
  });

  it("Max-Age=0 deletes the cookie", () => {
    const j = jar();
    j.store(5000, "/", ["sid=abc; Path=/"]);
    j.store(5000, "/", ["sid=; Path=/; Max-Age=0"]);
    expect(j.header(5000, "/api")).toBeNull();
  });

  it("prunes an expired cookie at read time", () => {
    let t = T0;
    const j = jar(() => t);
    j.store(5000, "/", ["s=1; Path=/; Max-Age=1"]); // expires at T0+1000
    expect(j.header(5000, "/")).toBe("s=1");
    t = T0 + 2000;
    expect(j.header(5000, "/")).toBeNull();
  });

  it("isolates cookies per guest port", () => {
    const j = jar();
    j.store(5000, "/", ["a=1; Path=/"]);
    j.store(8000, "/", ["b=2; Path=/"]);
    expect(j.header(5000, "/")).toBe("a=1");
    expect(j.header(8000, "/")).toBe("b=2");
  });

  it("only emits cookies whose path matches, longest path first", () => {
    const j = jar();
    j.store(5000, "/", ["root=1; Path=/", "scoped=2; Path=/api"]);
    expect(j.header(5000, "/other")).toBe("root=1"); // /api-scoped one excluded
    expect(j.header(5000, "/api/guess")).toBe("scoped=2; root=1"); // longest path first
  });

  it("clear() forgets everything (kernel switch)", () => {
    const j = jar();
    j.store(5000, "/", ["a=1; Path=/"]);
    j.clear();
    expect(j.header(5000, "/")).toBeNull();
  });
});
