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

  it("unknown erdou subcommand prints usage and exits 2", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const p = await rt.exec("erdou bogus");
    expect((await p.wait()).code).toBe(2);
  });
});
