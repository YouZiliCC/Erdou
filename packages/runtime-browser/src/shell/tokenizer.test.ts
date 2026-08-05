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

  it("recognizes fd duplication, so `2>&1` is not a redirect plus a background &", () => {
    // `2>&1` used to tokenize as redirect(fd2,'>') + op('&') + word('1'), which
    // the parser rejected with "redirect without a target" — the most common
    // logging idiom there is, dead at the parse stage.
    expect(tokenize("cmd 2>&1")).toEqual([
      { type: "word", parts: [{ t: "lit", v: "cmd" }] },
      { type: "dup", fd: 2, from: 1 },
    ]);
    expect(tokenize("cmd 1>&2")[1]).toEqual({ type: "dup", fd: 1, from: 2 });
    expect(tokenize("cmd >&2")[1]).toEqual({ type: "dup", fd: 1, from: 2 });
  });

  it("keeps the pipe after a `2>&1` a pipe", () => {
    expect(tokenize("cmd 2>&1 | tail")).toEqual([
      { type: "word", parts: [{ t: "lit", v: "cmd" }] },
      { type: "dup", fd: 2, from: 1 },
      { type: "op", value: "|" },
      { type: "word", parts: [{ t: "lit", v: "tail" }] },
    ]);
  });

  it("preserves redirect order, which is what makes `> log 2>&1` differ from `2>&1 > log`", () => {
    expect(tokenize("cmd > log 2>&1").slice(1)).toEqual([
      { type: "redirect", fd: 1, op: ">" },
      { type: "word", parts: [{ t: "lit", v: "log" }] },
      { type: "dup", fd: 2, from: 1 },
    ]);
    expect(tokenize("cmd 2>&1 > log").slice(1)).toEqual([
      { type: "dup", fd: 2, from: 1 },
      { type: "redirect", fd: 1, op: ">" },
      { type: "word", parts: [{ t: "lit", v: "log" }] },
    ]);
  });

  it("marks `&>` / `&>>` as a redirect that also duplicates stderr", () => {
    expect(tokenize("cmd &> log").slice(1)).toEqual([
      { type: "redirect", fd: 1, op: ">", both: true },
      { type: "word", parts: [{ t: "lit", v: "log" }] },
    ]);
    expect(tokenize("cmd &>> log")[1]).toEqual({ type: "redirect", fd: 1, op: ">>", both: true });
    // No space needed — bash lexes `&>` as one operator.
    expect(tokenize("cmd&>log")[1]).toEqual({ type: "redirect", fd: 1, op: ">", both: true });
  });

  it("still reads a bare & as the background operator and && as the list operator", () => {
    expect(tokenize("cmd &")[1]).toEqual({ type: "op", value: "&" });
    expect(tokenize("a && b")[1]).toEqual({ type: "op", value: "&&" });
  });

  it("rejects fds above 2 instead of silently dropping the redirect", () => {
    // `Number(c) as 0|1|2` used to let `3> f` through as fd 3, which then
    // matched neither the fd-1 nor the fd-2 lookup in the interpreter: the file
    // was never written and the command still exited 0.
    expect(() => tokenize("cmd 3> f")).toThrow("only fds 0, 1 and 2 exist in this shell: 3>");
    expect(() => tokenize("cmd 33> f")).toThrow("only fds 0, 1 and 2 exist in this shell: 33>");
    expect(() => tokenize("cmd 2>&3")).toThrow("only fds 0, 1 and 2 exist in this shell: 2>&3");
  });

  it("rejects a redirect pointed the wrong way at a fd instead of ignoring it", () => {
    // `2< f` used to be found by the interpreter's `op === "<"` lookup, which
    // ignores the fd — it fed the command's STDIN.
    expect(() => tokenize("cmd 2< f")).toThrow("input redirect is only supported on fd 0: 2<");
    expect(() => tokenize("cmd 0> f")).toThrow("output redirect is not supported on fd 0: 0>");
  });

  it("rejects fd-closing and csh-style `>&file` by name", () => {
    expect(() => tokenize("cmd 2>&-")).toThrow("closing a file descriptor is not supported: 2>&-");
    expect(() => tokenize("cmd >& log")).toThrow("use `&>file`");
    expect(() => tokenize("cmd 2>>&1")).toThrow("appending duplication is not supported: 2>>&");
    expect(() => tokenize("cmd 2>&1x")).toThrow("fd duplication must be followed by a delimiter");
  });

  it("still tokenizes a word that merely starts with digits", () => {
    expect(tokenize("echo 12")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "12" }] });
    expect(tokenize("echo 2x> f")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "2x" }] });
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

  it("keeps an escaped metacharacter out of a later unescaped one's glob run", () => {
    // The escaped star must not share a part with the unescaped one: a part is
    // classified as a whole, so `\*d*` in one part globbed as `*d*` and `echo
    // \*d*` printed `d.txt` where bash prints `*d*`.
    expect(tokenize("echo \\*d*")[1]).toEqual({
      type: "word",
      parts: [
        { t: "lit", v: "*" },
        { t: "glob", v: "d*" },
      ],
    });
    expect(tokenize("echo *\\*")[1]).toEqual({
      type: "word",
      parts: [
        { t: "glob", v: "*" },
        { t: "lit", v: "*" },
      ],
    });
    expect(tokenize("echo a\\?b?")[1]).toEqual({
      type: "word",
      parts: [
        { t: "lit", v: "a" },
        { t: "lit", v: "?" },
        { t: "glob", v: "b?" },
      ],
    });
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

  it("captures $(...) as a command substitution, unquoted and inside double quotes", () => {
    expect(tokenize("echo $(pwd)")[1]).toEqual({
      type: "word",
      parts: [{ t: "cmdsub", src: "pwd" }],
    });
    expect(tokenize('echo "x $(pwd)"')[1]).toEqual({
      type: "word",
      parts: [
        { t: "lit", v: "x " },
        { t: "cmdsub", src: "pwd" },
      ],
    });
  });

  it("scans a substitution's body without being fooled by its contents", () => {
    // Nested `$(`, bare parens, quoted `)` and escapes all have to be skipped
    // rather than counted as the terminator.
    expect(tokenize("echo $(echo $(pwd))")[1]).toEqual({
      type: "word",
      parts: [{ t: "cmdsub", src: "echo $(pwd)" }],
    });
    expect(tokenize(`echo $(echo "a)b")`)[1]).toEqual({
      type: "word",
      parts: [{ t: "cmdsub", src: `echo "a)b"` }],
    });
    expect(tokenize("echo $(echo 'a)b')")[1]).toEqual({
      type: "word",
      parts: [{ t: "cmdsub", src: "echo 'a)b'" }],
    });
    expect(tokenize("echo $(echo a\\)b)")[1]).toEqual({
      type: "word",
      parts: [{ t: "cmdsub", src: "echo a\\)b" }],
    });
    // A substitution glued to literal text keeps both parts.
    expect(tokenize("echo pre$(pwd)post")[1]).toEqual({
      type: "word",
      parts: [
        { t: "lit", v: "pre" },
        { t: "cmdsub", src: "pwd" },
        { t: "lit", v: "post" },
      ],
    });
  });

  it("still refuses backticks and arithmetic expansion, and an unterminated $(", () => {
    // One spelling of command substitution is enough; backticks bring their own
    // nested-escaping rules and buy nothing.
    expect(() => tokenize("echo `pwd`")).toThrow("command substitution is not supported: `...`");
    expect(() => tokenize('echo "`pwd`"')).toThrow("command substitution is not supported: `...`");
    expect(() => tokenize("echo $((1+2))")).toThrow("arithmetic expansion is not supported");
    expect(() => tokenize("echo $(pwd")).toThrow("unterminated $(");
  });

  it("keeps $(...) literal inside single quotes", () => {
    expect(tokenize("echo '$(pwd)'")[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: "$(pwd)" }],
    });
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

  it("strips an unquoted # that starts a word as a comment to end of line", () => {
    // POSIX sh; left to readWord the `#` and everything after it silently
    // became extra argv entries (`rm build.log # old` deleted a file `old`).
    expect(tokenize("echo hi # a comment")).toEqual([
      { type: "word", parts: [{ t: "lit", v: "echo" }] },
      { type: "word", parts: [{ t: "lit", v: "hi" }] },
    ]);
    expect(tokenize("# a whole-line comment")).toEqual([]);
    // The comment ends at the newline, not at the end of the input.
    expect(tokenize("echo a #c\nb").filter((t) => t.type === "word")).toHaveLength(3);
  });

  it("keeps a mid-word, quoted or escaped # literal", () => {
    expect(tokenize("echo foo#bar")[1]).toEqual({
      type: "word",
      parts: [{ t: "lit", v: "foo#bar" }],
    });
    expect(tokenize("echo '#x'")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "#x" }] });
    expect(tokenize('echo "#x"')[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "#x" }] });
    expect(tokenize("echo \\#x")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "#x" }] });
  });

  it("still emits a lone $ as a literal", () => {
    expect(tokenize("echo $")[1]).toEqual({ type: "word", parts: [{ t: "lit", v: "$" }] });
  });
});
