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

  it("applies backslash escapes inside double quotes", () => {
    expect(tokenize('echo "say \\"hi\\""')[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: 'say "hi"' }],
    });
    expect(tokenize('echo "cost \\$5"')[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: "cost $5" }],
    });
    expect(tokenize('echo "a\\\\b"')[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: "a\\b" }],
    });
  });

  it("keeps a double-quoted backslash literal before an ordinary character", () => {
    expect(tokenize('echo "a\\b"')[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: "a\\b" }],
    });
  });

  it("escapes word delimiters outside quotes", () => {
    expect(tokenize("echo a\\ b").filter((t) => t.type === "word")).toEqual([
      { type: "word", parts: [{ t: "lit", v: "echo" }] },
      { type: "word", parts: [{ t: "lit", v: "a b" }] },
    ]);
    expect(tokenize("echo \\$HOME")[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: "$HOME" }],
    });
    // An escaped star is literal, so the word must not be marked as a glob.
    expect(tokenize("echo \\*")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "*" }] });
  });

  it("treats a backslash before a newline as a line continuation", () => {
    expect(tokenize("echo a\\\nb")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "ab" }] });
    expect(tokenize("echo a \\\n b").filter((t) => t.type === "word")).toHaveLength(3);
  });

  it("keeps a backslash literal inside single quotes", () => {
    expect(tokenize("echo 'a\\\"b'")[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: 'a\\"b' }],
    });
  });

  it("rejects a backslash with nothing left to escape", () => {
    expect(() => tokenize("echo a\\")).toThrow("trailing backslash");
    expect(() => tokenize('echo "a\\')).toThrow('unterminated "');
  });

  it("rejects unsupported parameter expansion instead of expanding it to empty", () => {
    expect(() => tokenize("echo ${NOPE:-fallback}")).toThrow(
      "unsupported parameter expansion: ${NOPE:-fallback}",
    );
    expect(() => tokenize("echo ${P##*/}")).toThrow("unsupported parameter expansion: ${P##*/}");
    expect(() => tokenize("echo ${#X}")).toThrow("unsupported parameter expansion: ${#X}");
    expect(() => tokenize('echo "${X/a/b}"')).toThrow("unsupported parameter expansion: ${X/a/b}");
  });

  it("rejects command substitution instead of emitting it literally", () => {
    expect(() => tokenize("echo $(pwd)")).toThrow("command substitution is not supported: $(...)");
    expect(() => tokenize('echo "x $(pwd)"')).toThrow("command substitution is not supported");
    expect(() => tokenize("echo `pwd`")).toThrow("command substitution is not supported: `...`");
    expect(() => tokenize('echo "`pwd`"')).toThrow("command substitution is not supported: `...`");
    expect(() => tokenize("echo $((1+2))")).toThrow("arithmetic expansion is not supported");
  });

  it("rejects $'...' ANSI-C quoting", () => {
    expect(() => tokenize("echo $'a\\nb'")).toThrow("ANSI-C quoting is not supported: $'...'");
  });

  it("treats $' inside double quotes as ordinary text", () => {
    // ANSI-C quoting only exists unquoted; bash prints `$'x'` for this line, so
    // rejecting it here would refuse a command that is perfectly well-defined.
    expect(tokenize(`echo "$'x'"`)[1]).toEqual({
      type: "word",
      parts: [
        { t: "lit", v: "$" },
        { t: "lit", v: "'x'" },
      ],
    });
  });

  it("parses $? as the exit-status parameter", () => {
    expect(tokenize("echo $?")[1]).toEqual({ type: "word", parts: [{ t: "var", name: "?" }] });
    expect(tokenize('echo "code=$?"')[1]).toEqual({
      type: "word",
      parts: [
        { t: "lit", v: "code=" },
        { t: "var", name: "?" },
      ],
    });
  });

  it("rejects special parameters instead of emitting them as a literal $", () => {
    expect(() => tokenize("echo $$")).toThrow("special parameter is not supported: $$");
    expect(() => tokenize("echo $!")).toThrow("special parameter is not supported: $!");
    expect(() => tokenize("echo $@")).toThrow("special parameter is not supported: $@");
    expect(() => tokenize("echo $*")).toThrow("special parameter is not supported: $*");
    expect(() => tokenize("echo $#")).toThrow("special parameter is not supported: $#");
    expect(() => tokenize("echo $-")).toThrow("special parameter is not supported: $-");
    expect(() => tokenize('echo "$#"')).toThrow("special parameter is not supported: $#");
  });

  it("rejects positional parameters instead of expanding them to empty", () => {
    expect(() => tokenize("echo $0")).toThrow("positional parameter is not supported: $0");
    expect(() => tokenize("echo $1")).toThrow("positional parameter is not supported: $1");
    expect(() => tokenize("echo $12")).toThrow("positional parameter is not supported: $1");
    expect(() => tokenize('echo "$9"')).toThrow("positional parameter is not supported: $9");
  });

  it("rejects ${?} and ${1} — braces do not make a special parameter supported", () => {
    expect(() => tokenize("echo ${?}")).toThrow("unsupported parameter expansion: ${?}");
    expect(() => tokenize("echo ${1}")).toThrow("unsupported parameter expansion: ${1}");
  });

  it("still emits a lone $ as a literal", () => {
    expect(tokenize("echo $")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "$" }] });
  });
});
