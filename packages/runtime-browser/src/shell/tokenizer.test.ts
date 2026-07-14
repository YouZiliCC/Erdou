import { describe, it, expect } from "vitest";
import { tokenize } from "./tokenizer.js";

describe("tokenize", () => {
  it("splits words, respecting single and double quotes", () => {
    const tokens = tokenize(`echo "a b" 'c'`);
    const words = tokens.filter((t) => t.type === "word");
    expect(words).toHaveLength(3);
    expect(tokens[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "a b" }] });
    expect(tokens[2]).toEqual({ type: "word", parts: [{ t: "lit", v: "c" }] });
  });

  it("recognizes pipeline and list operators", () => {
    const tokens = tokenize("a | b && c");
    expect(tokens.filter((t) => t.type === "op").map((t) => (t as any).value)).toEqual(["|", "&&"]);
  });

  it("recognizes fd-prefixed and plain redirects", () => {
    const tokens = tokenize("x > f 2> e");
    expect(tokens.filter((t) => t.type === "redirect")).toEqual([
      { type: "redirect", fd: 1, op: ">" },
      { type: "redirect", fd: 2, op: ">" },
    ]);
  });

  it("parses $VAR and ${VAR}", () => {
    expect(tokenize("$HOME")[0]).toEqual({ type: "word", parts: [{ t: "var", name: "HOME" }] });
    expect(tokenize("${X}")[0]).toEqual({ type: "word", parts: [{ t: "var", name: "X" }] });
  });

  it("marks unquoted glob words", () => {
    expect(tokenize("*.ts")[0]).toEqual({ type: "word", parts: [{ t: "glob", v: "*.ts" }] });
  });

  it("throws EINVAL on an unterminated quote", () => {
    expect(() => tokenize('echo "abc')).toThrow(/EINVAL/);
  });
});
