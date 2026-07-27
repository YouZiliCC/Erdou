import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "../browser-runtime.js";

describe("erdou serve", () => {
  it("registers a static handler that serves files", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/index.html", "<h1>hi</h1>");
    const p = await rt.exec("erdou serve /site 8080");
    expect((await p.wait()).code).toBe(0);
    const res = await rt.dispatch(8080, { method: "GET", url: "/index.html", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toContain("hi");
  });

  it("--spa falls back to index.html for unknown routes", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/index.html", "<h1>app</h1>");
    await (await rt.exec("erdou serve /site 8080 --spa")).wait();
    const res = await rt.dispatch(8080, { method: "GET", url: "/some/route", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toContain("app");
  });

  it("404s for a missing file without --spa", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/index.html", "<h1>hi</h1>");
    await (await rt.exec("erdou serve /site 8080")).wait();
    const res = await rt.dispatch(8080, {
      method: "GET",
      url: "/missing.txt",
      headers: {},
      body: new Uint8Array(),
    });
    expect(res.status).toBe(404);
  });

  it("sets content-type by extension for .css and .js", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/index.html", "<h1>hi</h1>");
    rt.fs.writeFile("/site/app.css", "body{color:red}");
    rt.fs.writeFile("/site/app.js", "console.log(1)");
    await (await rt.exec("erdou serve /site 8080")).wait();

    const css = await rt.dispatch(8080, { method: "GET", url: "/app.css", headers: {}, body: new Uint8Array() });
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");

    const js = await rt.dispatch(8080, { method: "GET", url: "/app.js", headers: {}, body: new Uint8Array() });
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
  });

  it("strips a /__port__/<n> prefix and a query string from the request URL", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/index.html", "<h1>hi</h1>");
    await (await rt.exec("erdou serve /site 8080")).wait();
    const res = await rt.dispatch(8080, {
      method: "GET",
      url: "/__port__/8080/index.html?x=1",
      headers: {},
      body: new Uint8Array(),
    });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toContain("hi");
  });

  it("404s a path that tries to escape the served directory", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/index.html", "<h1>hi</h1>");
    rt.fs.writeFile("/secret.txt", "top secret");
    await (await rt.exec("erdou serve /site 8080")).wait();
    const res = await rt.dispatch(8080, {
      method: "GET",
      url: "/../secret.txt",
      headers: {},
      body: new Uint8Array(),
    });
    expect(res.status).toBe(404);
  });

  it("percent-decodes the request path (spaces and non-ASCII names)", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/my file.txt", "spaced");
    rt.fs.writeFile("/site/图片.txt", "cjk");
    await (await rt.exec("erdou serve /site 8080")).wait();

    const spaced = await rt.dispatch(8080, {
      method: "GET",
      url: "/my%20file.txt",
      headers: {},
      body: new Uint8Array(),
    });
    expect(spaced.status).toBe(200);
    expect(new TextDecoder().decode(spaced.body)).toBe("spaced");

    const cjk = await rt.dispatch(8080, {
      method: "GET",
      url: "/%E5%9B%BE%E7%89%87.txt",
      headers: {},
      body: new Uint8Array(),
    });
    expect(cjk.status).toBe(200);
    expect(new TextDecoder().decode(cjk.body)).toBe("cjk");
  });

  it("400s a malformed percent-escape instead of falling back to the raw path", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site", { recursive: true });
    rt.fs.writeFile("/site/index.html", "<h1>hi</h1>");
    rt.fs.writeFile("/site/%zz.txt", "raw");
    await (await rt.exec("erdou serve /site 8080")).wait();

    const res = await rt.dispatch(8080, { method: "GET", url: "/%zz.txt", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(400);
    expect(new TextDecoder().decode(res.body)).toContain("malformed percent-encoding in path '/%zz.txt'");
  });

  // The redirect Location must be RELATIVE. The production caller
  // (apps/web/public/preview-sw.js) strips `/__preview__/<owner>/<primary>` and
  // any `/__port__/<n>` before dispatch, so an origin-absolute `/docs/` would
  // resolve against the Studio origin and walk out of the preview scope. The
  // `<owner>` segment (the Studio page that owns the preview) is why this can
  // never be rebuilt runtime-side: only the browser knows it.
  it("302s a directory URL to a relative trailing-slash form", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site/docs", { recursive: true });
    rt.fs.writeFile("/site/index.html", "ROOT");
    rt.fs.writeFile("/site/docs/index.html", "DOCS");
    await (await rt.exec("erdou serve /site 8080")).wait();

    // What the SW dispatches for a browser request to
    // `/__preview__/<owner>/8080/docs`.
    const redirect = await rt.dispatch(8080, { method: "GET", url: "/docs", headers: {}, body: new Uint8Array() });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("./docs/");
    // Resolved by the browser against the URL it actually requested.
    expect(new URL("./docs/", "https://studio.test/__preview__/tab-a/8080/docs").pathname).toBe("/__preview__/tab-a/8080/docs/");

    const followed = await rt.dispatch(8080, { method: "GET", url: "/docs/", headers: {}, body: new Uint8Array() });
    expect(followed.status).toBe(200);
    expect(new TextDecoder().decode(followed.body)).toBe("DOCS");
  });

  it("the directory redirect is relative to a NESTED directory URL too", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site/a/b", { recursive: true });
    rt.fs.writeFile("/site/a/b/index.html", "B");
    await (await rt.exec("erdou serve /site 8080")).wait();

    const res = await rt.dispatch(8080, { method: "GET", url: "/a/b", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("./b/");
    expect(new URL("./b/", "https://studio.test/__preview__/tab-a/8080/a/b").pathname).toBe("/__preview__/tab-a/8080/a/b/");
  });

  it("--spa redirects a directory URL instead of serving the root index", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site/docs", { recursive: true });
    rt.fs.writeFile("/site/index.html", "ROOT");
    rt.fs.writeFile("/site/docs/index.html", "DOCS");
    await (await rt.exec("erdou serve /site 8080 --spa")).wait();

    const res = await rt.dispatch(8080, { method: "GET", url: "/docs", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("./docs/");
    expect(new TextDecoder().decode(res.body)).not.toContain("ROOT");
  });

  it("the directory redirect keeps the query string", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site/docs", { recursive: true });
    rt.fs.writeFile("/site/docs/index.html", "DOCS");
    await (await rt.exec("erdou serve /site 8080")).wait();

    const res = await rt.dispatch(8080, { method: "GET", url: "/docs?x=1", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("./docs/?x=1");
  });

  // A direct `/__port__/<n>/…` dispatch (the URL the port registry advertises)
  // bypasses the SW's stripping; the relative Location must work there as well.
  it("the directory redirect stays under a /__port__ prefix when one reaches the handler", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site/docs", { recursive: true });
    rt.fs.writeFile("/site/docs/index.html", "DOCS");
    await (await rt.exec("erdou serve /site 8080")).wait();

    const res = await rt.dispatch(8080, {
      method: "GET",
      url: "/__port__/8080/docs?x=1",
      headers: {},
      body: new Uint8Array(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("./docs/?x=1");
    expect(new URL("./docs/?x=1", "https://studio.test/__port__/8080/docs").pathname).toBe("/__port__/8080/docs/");
  });

  // The one shape that could loop: a DIRECTORY named `index.html`. `/docs/`
  // resolves to `docs/index.html`, which is a directory — redirecting would
  // bounce the browser forever, so fail fast and name the path.
  it("500s instead of looping when the resolved index.html is itself a directory", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    rt.fs.mkdir("/site/docs/index.html", { recursive: true });
    await (await rt.exec("erdou serve /site 8080")).wait();

    const redirect = await rt.dispatch(8080, { method: "GET", url: "/docs", headers: {}, body: new Uint8Array() });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("./docs/");

    const followed = await rt.dispatch(8080, { method: "GET", url: "/docs/", headers: {}, body: new Uint8Array() });
    expect(followed.status).toBe(500);
    expect(new TextDecoder().decode(followed.body)).toContain("/site/docs/index.html");
  });

  it("unknown erdou subcommand prints usage and exits 2", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const p = await rt.exec("erdou bogus");
    expect((await p.wait()).code).toBe(2);
  });
});
