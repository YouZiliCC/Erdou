// Hermetic tests for the bake pipeline's pure APKINDEX parsing/resolution
// helpers (scripts/lib/apk.mjs — plain JS so bake-image.mjs can import it
// without tsx; vitest only collects src/**, hence this file lives here).
// Locks the S2 resolver fixes: `~` version-constraint splitting (a `foo~x.y`
// dep used to be silently dropped from the closure) and main-before-community
// precedence when indexes are merged (apk repo-order semantics).
import { describe, it, expect } from "vitest";
// @ts-ignore — untyped plain-JS bake helper (scripts/, outside the TS program)
import { parseApkIndexText, resolve } from "../scripts/lib/apk.mjs";

const block = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${k}:${v}`).join("\n");
const index = (...blocks: Record<string, string>[]) => blocks.map(block).join("\n\n") + "\n\n";

describe("parseApkIndexText", () => {
  it("parses name/version/apk and stamps the repo origin", () => {
    const pkgs = parseApkIndexText(index({ P: "python3", V: "3.14.5-r0" }), "community");
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ name: "python3", version: "3.14.5-r0", repo: "community", apk: "python3-3.14.5-r0.apk" });
  });

  it("splits ~ version constraints in depends (python3~3.14 must not be dropped)", () => {
    const pkgs = parseApkIndexText(index({ P: "py3-pip", V: "26.1.2-r0", D: "python3~3.14 so:libpython3.14.so.1.0" }), "main");
    expect(pkgs[0].depends).toContain("python3");
  });

  it("splits =/</>/~ constraints in provides", () => {
    const pkgs = parseApkIndexText(index({ P: "py3-pip", V: "26.1.2-r0", p: "cmd:pip~26 py-pip=26.1.2-r0" }), "main");
    expect(pkgs[0].provides).toEqual(["cmd:pip", "py-pip"]);
  });
});

describe("resolve", () => {
  it("resolves a ~-constrained dep into the closure (previously reported missing)", () => {
    const pkgs = parseApkIndexText(index(
      { P: "py3-pip", V: "26.1.2-r0", D: "python3~3.14" },
      { P: "python3", V: "3.14.5-r0" },
    ), "main");
    const { order, missing } = resolve(pkgs, ["py3-pip"]);
    expect(missing).toEqual([]);
    expect(order.map((p: { name: string }) => p.name)).toEqual(["python3", "py3-pip"]);
  });

  it("gives the first repo precedence for duplicate names (main listed before community)", () => {
    const merged = [
      ...parseApkIndexText(index({ P: "foo", V: "1.0-r0" }), "main"),
      ...parseApkIndexText(index({ P: "foo", V: "2.0-r0" }), "community"),
    ];
    const { order } = resolve(merged, ["foo"]);
    expect(order).toHaveLength(1);
    expect(order[0]).toMatchObject({ version: "1.0-r0", repo: "main" });
  });

  it("a real package name beats another package's provides alias regardless of order", () => {
    const pkgs = parseApkIndexText(index(
      { P: "alias-holder", V: "1.0-r0", p: "target" },
      { P: "target", V: "2.0-r0" },
    ), "main");
    const { order } = resolve(pkgs, ["target"]);
    expect(order.map((p: { name: string }) => p.name)).toEqual(["target"]);
  });

  it("reports unknown deps in missing but filters so:libc/absolute-path pseudo-deps", () => {
    const pkgs = parseApkIndexText(index({ P: "app", V: "1.0-r0", D: "so:libc.musl-x86.so.1 /bin/sh nosuchpkg" }), "main");
    const { missing } = resolve(pkgs, ["app"]);
    expect(missing).toEqual(["nosuchpkg"]);
  });
});
