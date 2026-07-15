import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { assembleDist, bundleProject, hasBundleEntry } from "./bundle-project.js";

const text = (fs: BrowserRuntime["fs"], path: string): string => new TextDecoder().decode(fs.readFile(path));

describe("assembleDist", () => {
  it("writes the HTML shell, app.js, and app.css when css is present", () => {
    const fs = new BrowserRuntime().fs;
    assembleDist(fs, { js: "console.log('hi')", css: "body{color:red}" });

    expect(text(fs, "/dist/app.js")).toBe("console.log('hi')");
    expect(text(fs, "/dist/app.css")).toBe("body{color:red}");
    const html = text(fs, "/dist/index.html");
    expect(html).toContain('<link rel="stylesheet" href="app.css">');
    expect(html).toContain('<script type="module" src="app.js">');
    expect(html).toContain('<div id="root"></div>');
  });

  it("omits the css link and app.css file when there is no css", () => {
    const fs = new BrowserRuntime().fs;
    assembleDist(fs, { js: "console.log('hi')", css: "" });

    expect(fs.exists("/dist/app.css")).toBe(false);
    expect(text(fs, "/dist/index.html")).not.toContain("app.css");
  });

  it("copies a non-source asset into /dist, preserving nested paths", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/data.json", '{"a":1}');
    fs.mkdir("/public", { recursive: true });
    fs.writeFile("/public/logo.svg", "<svg></svg>");

    assembleDist(fs, { js: "", css: "" });

    expect(text(fs, "/dist/data.json")).toBe('{"a":1}');
    expect(text(fs, "/dist/public/logo.svg")).toBe("<svg></svg>");
  });

  it("skips source files (.ts/.tsx/.js/.jsx) and the root index.html when copying", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/index.html", "<!doctype html><html><body>original</body></html>");
    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/src/main.tsx", "export {}");
    fs.writeFile("/helper.js", "export const x = 1;");

    assembleDist(fs, { js: "bundled-output", css: "" });

    expect(fs.exists("/dist/src")).toBe(false);
    expect(fs.exists("/dist/helper.js")).toBe(false);
    // /dist/index.html exists, but it's the generated shell, not a copy of the source file.
    expect(text(fs, "/dist/index.html")).toContain("app.js");
    expect(text(fs, "/dist/index.html")).not.toContain("original");
  });

  it("skips node_modules, .git, and an existing /dist when copying (rebuild-safe)", () => {
    const fs = new BrowserRuntime().fs;
    fs.mkdir("/node_modules/foo", { recursive: true });
    fs.writeFile("/node_modules/foo/pkg.json", "{}");
    fs.mkdir("/.git", { recursive: true });
    fs.writeFile("/.git/HEAD", "ref: refs/heads/main");

    assembleDist(fs, { js: "v1", css: "" }); // first build creates /dist
    assembleDist(fs, { js: "v2", css: "" }); // second build must not recurse into its own output

    expect(fs.exists("/dist/node_modules")).toBe(false);
    expect(fs.exists("/dist/.git")).toBe(false);
    expect(fs.exists("/dist/dist")).toBe(false);
    expect(text(fs, "/dist/app.js")).toBe("v2");
  });

  it("purges a stale /dist so a source asset removed between builds no longer lingers", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/data.json", '{"a":1}');

    assembleDist(fs, { js: "v1", css: "" });
    expect(text(fs, "/dist/data.json")).toBe('{"a":1}');

    fs.rm("/data.json");
    assembleDist(fs, { js: "v2", css: "" });

    expect(fs.exists("/dist/data.json")).toBe(false);
    expect(text(fs, "/dist/app.js")).toBe("v2");
  });
});

describe("bundleProject", () => {
  it("fails fast with a clear error and writes nothing when no entry is found", async () => {
    const fs = new BrowserRuntime().fs;
    const result = await bundleProject(fs);
    expect(result).toEqual({
      ok: false,
      errors: ["No entry found (e.g. /src/main.tsx or an index.html module)."],
      entry: null,
    });
    expect(fs.exists("/dist")).toBe(false);
  });
});

describe("hasBundleEntry", () => {
  it("is false with no entry and true once a conventional entry file exists", () => {
    const fs = new BrowserRuntime().fs;
    expect(hasBundleEntry(fs)).toBe(false);

    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/src/main.tsx", "export {}");
    expect(hasBundleEntry(fs)).toBe(true);
  });
});
