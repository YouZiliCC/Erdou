import { describe, it, expect } from "vitest";
import { expandWord } from "./expand.js";
import type { Word } from "./ast.js";
import { Vfs } from "../vfs/vfs.js";

const w = (...parts: Word["parts"]): Word => ({ parts });

describe("expandWord", () => {
  const vfs = new Vfs({ clock: () => 0 });

  it("substitutes variables, unknown ones becoming empty", () => {
    expect(expandWord(w({ t: "var", name: "UNSET" }), {}, vfs, "/")).toEqual([""]);
    expect(
      expandWord(w({ t: "var", name: "HOME" }, { t: "lit", v: "/x" }), { HOME: "/root" }, vfs, "/"),
    ).toEqual(["/root/x"]);
  });

  it("expands globs against the filesystem", () => {
    const g = new Vfs({ clock: () => 0 });
    g.writeFile("/a.ts", "1");
    g.writeFile("/b.js", "1");
    expect(expandWord(w({ t: "glob", v: "*.ts" }), {}, g, "/")).toEqual(["a.ts"]);
  });

  it("returns the literal pattern when a glob matches nothing", () => {
    expect(expandWord(w({ t: "glob", v: "*.zzz" }), {}, vfs, "/")).toEqual(["*.zzz"]);
  });
});
