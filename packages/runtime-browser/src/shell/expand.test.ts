import { describe, it, expect } from "vitest";
import { expandWord } from "./expand.js";
import { tokenize } from "./tokenizer.js";
import type { Word } from "./ast.js";
import { Vfs } from "../vfs/vfs.js";

const w = (...parts: Word["parts"]): Word => ({ parts });

/** The nth word of a command line. Quoting only survives as far as the token
 *  parts, so the escaped-metacharacter cases have to be checked across this
 *  seam and not just on hand-built parts. */
const wordAt = (src: string, n: number): Word => {
  const word = tokenize(src).filter((t) => t.type === "word")[n];
  if (word === undefined || word.type !== "word") throw new Error(`no word ${n} in: ${src}`);
  return { parts: word.parts };
};

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

  it("does not glob a metacharacter that arrived quoted or escaped", () => {
    // `\*d*` and `"*"d*` are a literal star followed by a glob. The parts are
    // concatenated into one pattern here, so without escaping the quoted star
    // the globber saw `*d*` and `echo \*d*` answered `d.txt` — wrong argv,
    // exit 0. bash matches `*d.txt` and nothing else.
    const g = new Vfs({ clock: () => 0 });
    g.writeFile("/d.txt", "1");
    g.writeFile("/*d.txt", "1");
    expect(expandWord(w({ t: "lit", v: "*" }, { t: "glob", v: "d*" }), {}, g, "/")).toEqual([
      "*d.txt",
    ]);
    // No literal-star file: POSIX hands back the pattern, and it must come back
    // unescaped rather than leaking the backslash this module added.
    const noStar = new Vfs({ clock: () => 0 });
    noStar.writeFile("/d.txt", "1");
    expect(expandWord(w({ t: "lit", v: "*" }, { t: "glob", v: "d*" }), {}, noStar, "/")).toEqual([
      "*d*",
    ]);
    // Trailing escaped star: `*\*` matches only names that end in a star.
    const trailing = new Vfs({ clock: () => 0 });
    trailing.writeFile("/x*", "1");
    trailing.writeFile("/x", "1");
    expect(expandWord(w({ t: "glob", v: "*" }, { t: "lit", v: "*" }), {}, trailing, "/")).toEqual([
      "x*",
    ]);
  });

  it("keeps a source-escaped or quoted star literal all the way to argv", () => {
    // The reviewer's repro, with `d.txt` present: bash prints `*d*` for both.
    const g = new Vfs({ clock: () => 0 });
    g.writeFile("/d.txt", "1");
    expect(expandWord(wordAt("echo \\*d*", 1), {}, g, "/")).toEqual(["*d*"]);
    expect(expandWord(wordAt('echo "*"d*', 1), {}, g, "/")).toEqual(["*d*"]);
  });

  it("never globs a metacharacter that arrived from a $VAR or $(...) value", () => {
    // Deliberate divergence (docs/architecture.md): POSIX globs an unquoted
    // expansion's value, but var/sub parts carry no quoted flag, so quoted and
    // unquoted expand identically here — and quoted must not glob.
    const g = new Vfs({ clock: () => 0 });
    g.writeFile("/a.txt", "1");
    g.writeFile("/b.txt", "1");
    // Alone: the value comes back literal (bash would list a.txt b.txt).
    expect(expandWord(w({ t: "var", name: "P" }), { P: "*.txt" }, g, "/")).toEqual(["*.txt"]);
    expect(expandWord(w({ t: "sub", v: "*.txt" }), {}, g, "/")).toEqual(["*.txt"]);
    // Next to a literal glob part — which used to flip the whole word into
    // globbing, stars and all — only the glob part's metacharacters match.
    g.writeFile("/*.txt", "1"); // a file literally named "*.txt"
    expect(
      expandWord(w({ t: "var", name: "P" }, { t: "glob", v: "*" }), { P: "*." }, g, "/"),
    ).toEqual(["*.txt"]);
    expect(expandWord(w({ t: "sub", v: "*." }, { t: "glob", v: "*" }), {}, g, "/")).toEqual([
      "*.txt",
    ]);
    // The literal glob still globs: `ls $DIR/*.txt`.
    g.mkdir("/d");
    g.writeFile("/d/x.txt", "1");
    expect(
      expandWord(w({ t: "var", name: "DIR" }, { t: "glob", v: "/*.txt" }), { DIR: "/d" }, g, "/"),
    ).toEqual(["/d/x.txt"]);
  });

  it("treats a backslash in the pattern as a filename character, not an escape", () => {
    // The escaping above is internal to this module: a backslash that came from
    // the word itself (`a\\b*`, or a variable's value) must still match a file
    // whose name contains a backslash, not vanish and match `ab*`.
    const g = new Vfs({ clock: () => 0 });
    g.writeFile("/a\\b.txt", "1");
    g.writeFile("/ab.txt", "1");
    expect(expandWord(w({ t: "glob", v: "a\\b*" }), {}, g, "/")).toEqual(["a\\b.txt"]);
    const varWord = w({ t: "var", name: "P" }, { t: "glob", v: "*" });
    expect(expandWord(varWord, { P: "a\\b" }, g, "/")).toEqual(["a\\b.txt"]);
    // A path segment with no unescaped metacharacter is looked up by name
    // instead of matched, so the escaping has to come back off first.
    g.mkdir("/a\\b");
    g.writeFile("/a\\b/x.txt", "1");
    const dirWord = w({ t: "lit", v: "a\\b/" }, { t: "glob", v: "x*" });
    expect(expandWord(dirWord, {}, g, "/")).toEqual(["a\\b/x.txt"]);
  });
});
