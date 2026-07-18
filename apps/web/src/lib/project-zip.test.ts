import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { Vfs } from "@erdou/runtime-browser";
import { buildProjectZip, formatByteSize } from "./project-zip.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("buildProjectZip", () => {
  it("packages nested paths and binary bytes, round-tripping through unzipSync", () => {
    const fs = new Vfs();
    fs.mkdir("/src/deep", { recursive: true });
    fs.writeFile("/README.md", "# hello");
    fs.writeFile("/src/deep/app.py", "print('hi')");
    const binary = new Uint8Array([0, 1, 2, 254, 255, 128]);
    fs.writeFile("/logo.bin", binary);

    const zip = buildProjectZip(fs, { kernelKind: "browser" });
    expect(zip.fileCount).toBe(3);
    expect(zip.byteSize).toBe(zip.bytes.length);
    expect(zip.byteSize).toBeGreaterThan(0);

    const files = unzipSync(zip.bytes);
    expect(Object.keys(files).sort()).toEqual(["README.md", "logo.bin", "src/deep/app.py"]);
    expect(dec.decode(files["README.md"])).toBe("# hello");
    expect(dec.decode(files["src/deep/app.py"])).toBe("print('hi')");
    expect(files["logo.bin"]).toEqual(binary);
  });

  it("NEVER lets .erdou (the API-key-bearing config) into the archive, at any depth", () => {
    // .erdou/config.json carries the user's model API key in the clear —
    // an export that included it would leak the credential the moment the
    // user shares the zip. This is a hard security invariant.
    const fs = new Vfs();
    fs.writeFile("/app.py", "code");
    fs.mkdir("/.erdou", { recursive: true });
    fs.writeFile("/.erdou/config.json", JSON.stringify({ model: { apiKey: "sk-SECRET" } }));
    fs.mkdir("/sub/.erdou", { recursive: true });
    fs.writeFile("/sub/.erdou/config.json", "nested secret");

    const zip = buildProjectZip(fs, { kernelKind: "browser" });
    const files = unzipSync(zip.bytes);
    expect(Object.keys(files)).toEqual(["app.py"]);
    // Belt and suspenders: the raw archive bytes carry no path or key trace.
    const raw = dec.decode(zip.bytes);
    expect(raw).not.toContain(".erdou");
    expect(raw).not.toContain("config.json");
  });

  it("excludes node_modules at any depth, includes .git", () => {
    const fs = new Vfs();
    fs.writeFile("/index.js", "x");
    fs.mkdir("/node_modules/pkg", { recursive: true });
    fs.writeFile("/node_modules/pkg/index.js", "dep");
    fs.mkdir("/packages/a/node_modules", { recursive: true });
    fs.writeFile("/packages/a/node_modules/dep.js", "dep");
    fs.writeFile("/packages/a/main.js", "kept");
    fs.mkdir("/.git/objects", { recursive: true });
    fs.writeFile("/.git/HEAD", "ref: refs/heads/main");
    fs.writeFile("/.git/objects/ab", enc.encode("blob"));

    const files = unzipSync(buildProjectZip(fs, { kernelKind: "browser" }).bytes);
    expect(Object.keys(files).sort()).toEqual([".git/HEAD", ".git/objects/ab", "index.js", "packages/a/main.js"]);
  });

  it("on the vm kernel, skips the image-owned VM_PRESERVE_DIRS at root but not nested dirs of the same name", () => {
    const fs = new Vfs();
    fs.writeFile("/app.py", "user code");
    // Image-owned root dirs: skeleton stub + baked config.
    fs.mkdir("/bin", { recursive: true });
    fs.writeFile("/bin/sh", "system");
    fs.mkdir("/etc", { recursive: true });
    fs.writeFile("/etc/pip.conf", "baked egress config");
    fs.mkdir("/root", { recursive: true });
    fs.writeFile("/root/.npmrc", "baked");
    // A PROJECT dir that happens to be named like a preserved one, below root.
    fs.mkdir("/src/bin", { recursive: true });
    fs.writeFile("/src/bin/cli.js", "project file");

    const files = unzipSync(buildProjectZip(fs, { kernelKind: "vm" }).bytes);
    expect(Object.keys(files).sort()).toEqual(["app.py", "src/bin/cli.js"]);
  });

  it("on the browser kernel, root dirs named like VM image dirs are ordinary project content", () => {
    const fs = new Vfs();
    fs.mkdir("/etc", { recursive: true });
    fs.writeFile("/etc/config.yaml", "user project file");
    const files = unzipSync(buildProjectZip(fs, { kernelKind: "browser" }).bytes);
    expect(Object.keys(files)).toEqual(["etc/config.yaml"]);
  });

  it("throws a precise error on an empty workspace instead of producing an empty zip", () => {
    const fs = new Vfs();
    expect(() => buildProjectZip(fs, { kernelKind: "browser" })).toThrow(/Nothing to export/);
    // Excluded-only content is still "empty".
    fs.mkdir("/node_modules", { recursive: true });
    fs.writeFile("/node_modules/dep.js", "x");
    fs.mkdir("/.erdou", { recursive: true });
    fs.writeFile("/.erdou/config.json", "{}");
    expect(() => buildProjectZip(fs, { kernelKind: "browser" })).toThrow(/Nothing to export/);
  });
});

describe("formatByteSize", () => {
  it("formats B / KB / MB", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2.0 KB");
    expect(formatByteSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
