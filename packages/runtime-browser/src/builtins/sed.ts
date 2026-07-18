import type { FileSystemApi } from "@erdou/runtime-contract";
import type { Program } from "../process/program.js";
import { abs, decode, describeError } from "./util.js";
import { streamLines, textLines } from "./lines.js";

/**
 * `sed` — an honest busybox-style SUBSET for the browser kernel:
 *
 *   sed [-n] [-i] [-e SCRIPT]... [SCRIPT] [FILE...]
 *
 * Commands: `s/RE/REPL/[gip]` (any delimiter after `s`), `p`, `d` — each with
 * an optional address prefix `N`, `$`, `/RE/`, or a numeric range `N,M` /
 * `N,$`. REPL supports `&`, `\1`-`\9` backrefs, and `\n` `\t` escapes. `-i`
 * edits files in place via the VFS; the script comes from `-e` (repeatable)
 * or the first operand; stdin is read when no files are given.
 *
 * RE = JavaScript RegExp semantics — close enough to ERE for the agent's use
 * (notably `+ ? | () {}` work unescaped, unlike BRE). Anything outside the
 * subset (other commands, regex address ranges, s flags beyond g/i/p, `!`
 * negation, unknown replacement escapes, GNU options) FAILS loudly with a
 * precise "sed: unsupported ..." error — never a silently-wrong result.
 *
 * Output normalization: lines are re-emitted with "\n", so an input whose
 * final line lacks a trailing newline gains one (see lines.ts). Multiple
 * files without -i form ONE stream (line numbers continue, `$` = last line
 * of the last file); with -i each file is its own stream, like real sed.
 */

class SedError extends Error {}

type SedAddress =
  | { kind: "line"; n: number }
  | { kind: "last" }
  | { kind: "re"; re: RegExp }
  | { kind: "range"; from: number; to: number | "$" };

/** A compiled replacement: literal runs, `&` (whole match), `\N` backrefs. */
type ReplPart =
  | { kind: "lit"; text: string }
  | { kind: "whole" }
  | { kind: "ref"; n: number };

type SedCommand =
  | { kind: "p"; addr: SedAddress | null }
  | { kind: "d"; addr: SedAddress | null }
  | { kind: "s"; addr: SedAddress | null; re: RegExp; repl: ReplPart[]; printOnSub: boolean };

function compileRegex(src: string, flags: string, what: string): RegExp {
  try {
    return new RegExp(src, flags);
  } catch (err) {
    throw new SedError(`sed: invalid ${what} '${src}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Character-walking parser for a sed script — commands separated by `;` or
 *  newlines. A proper tokenizer, not a regex over the whole script: delimiter
 *  and escape handling inside `s` bodies is positional. */
class SedScriptParser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): SedCommand[] {
    const cmds: SedCommand[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.i >= this.src.length) return cmds;
      cmds.push(this.parseCommand());
    }
  }

  private skipSeparators(): void {
    while (this.i < this.src.length && /[;\s]/.test(this.src[this.i]!)) this.i++;
  }

  private skipBlanks(): void {
    while (this.src[this.i] === " " || this.src[this.i] === "\t") this.i++;
  }

  private parseCommand(): SedCommand {
    const addr = this.parseAddress();
    this.skipBlanks();
    const ch = this.src[this.i];
    if (ch === undefined) throw new SedError("sed: address without a command");
    if (ch === "p" || ch === "d") {
      this.i++;
      this.expectCommandEnd(ch);
      return { kind: ch, addr };
    }
    if (ch === "s") {
      this.i++;
      return this.parseSubstitute(addr);
    }
    throw new SedError(`sed: unsupported command '${ch}' (supported: s, p, d)`);
  }

  private parseAddress(): SedAddress | null {
    const ch = this.src[this.i];
    if (ch === undefined) return null;
    if (ch === "$") {
      this.i++;
      this.skipBlanks();
      if (this.src[this.i] === ",") {
        throw new SedError("sed: unsupported address range starting at '$'");
      }
      return { kind: "last" };
    }
    if (ch >= "0" && ch <= "9") {
      const from = this.parseLineNumber();
      this.skipBlanks();
      if (this.src[this.i] !== ",") return { kind: "line", n: from };
      this.i++; // ','
      this.skipBlanks();
      const second = this.src[this.i];
      if (second === "$") {
        this.i++;
        return { kind: "range", from, to: "$" };
      }
      if (second !== undefined && second >= "0" && second <= "9") {
        return { kind: "range", from, to: this.parseLineNumber() };
      }
      throw new SedError(
        `sed: unsupported range end '${second ?? "<end of script>"}' (only N,M and N,$ ranges are supported)`,
      );
    }
    if (ch === "/") {
      this.i++;
      const reSrc = this.scanRegexPart("/", "address regex");
      if (reSrc === "") throw new SedError("sed: empty address regex // (last-regex recall is unsupported)");
      const re = compileRegex(reSrc, "", "address regex");
      this.skipBlanks();
      if (this.src[this.i] === ",") {
        throw new SedError("sed: unsupported: regex address ranges (/RE/,...) — only N,M and N,$ are supported");
      }
      return { kind: "re", re };
    }
    return null;
  }

  private parseLineNumber(): number {
    let n = 0;
    while (this.i < this.src.length && this.src[this.i]! >= "0" && this.src[this.i]! <= "9") {
      n = n * 10 + (this.src.charCodeAt(this.i) - 48);
      this.i++;
    }
    if (n === 0) throw new SedError("sed: invalid line address 0 (lines are numbered from 1)");
    return n;
  }

  /** Scan a regex body up to the next unescaped `delim`. `\<delim>` becomes a
   *  LITERAL delimiter (kept regex-escaped when the delimiter is punctuation,
   *  so `s|a\|b|x|` means a literal '|', not alternation); every other escape
   *  passes through to the RegExp compiler untouched. */
  private scanRegexPart(delim: string, what: string): string {
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === "\\") {
        const next = this.src[this.i + 1];
        if (next === undefined) throw new SedError(`sed: trailing backslash in ${what}`);
        if (next === delim) out += /[A-Za-z0-9]/.test(delim) ? delim : "\\" + delim;
        else out += "\\" + next;
        this.i += 2;
      } else if (c === delim) {
        this.i++;
        return out;
      } else {
        out += c;
        this.i++;
      }
    }
    throw new SedError(`sed: unterminated ${what} (missing closing '${delim}')`);
  }

  private parseSubstitute(addr: SedAddress | null): SedCommand {
    const delim = this.src[this.i];
    if (delim === undefined) throw new SedError("sed: unterminated s command (missing delimiter)");
    if (delim === "\\" || delim === "\n") {
      throw new SedError(`sed: unsupported s delimiter ${JSON.stringify(delim)}`);
    }
    this.i++;
    const reSrc = this.scanRegexPart(delim, "s command regex");
    if (reSrc === "") throw new SedError("sed: empty s regex (last-regex recall is unsupported)");
    const repl = this.scanReplacement(delim);
    let global = false;
    let ignoreCase = false;
    let printOnSub = false;
    while (this.i < this.src.length && !/[;\s]/.test(this.src[this.i]!)) {
      const f = this.src[this.i]!;
      if (f === "g") global = true;
      else if (f === "i") ignoreCase = true;
      else if (f === "p") printOnSub = true;
      else throw new SedError(`sed: unsupported s flag '${f}' (supported: g, i, p)`);
      this.i++;
    }
    const re = compileRegex(reSrc, (global ? "g" : "") + (ignoreCase ? "i" : ""), "s command regex");
    // Validate backrefs at parse time: `re|` matches the empty string and its
    // exec result has one slot per capture group.
    const groupCount = new RegExp(reSrc + "|").exec("")!.length - 1;
    for (const part of repl) {
      if (part.kind === "ref" && part.n > groupCount) {
        throw new SedError(
          `sed: invalid backreference \\${part.n} (the regex has ${groupCount} capture group${groupCount === 1 ? "" : "s"})`,
        );
      }
    }
    return { kind: "s", addr, re, repl, printOnSub };
  }

  private scanReplacement(delim: string): ReplPart[] {
    const parts: ReplPart[] = [];
    let lit = "";
    const flushLit = (): void => {
      if (lit !== "") {
        parts.push({ kind: "lit", text: lit });
        lit = "";
      }
    };
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === delim) {
        this.i++;
        flushLit();
        return parts;
      }
      if (c === "\\") {
        const next = this.src[this.i + 1];
        if (next === undefined) throw new SedError("sed: trailing backslash in replacement");
        if (next === delim) lit += delim;
        else if (next === "n") lit += "\n";
        else if (next === "t") lit += "\t";
        else if (next === "\\") lit += "\\";
        else if (next === "&") lit += "&";
        else if (next >= "1" && next <= "9") {
          flushLit();
          parts.push({ kind: "ref", n: next.charCodeAt(0) - 48 });
        } else {
          throw new SedError(`sed: unsupported escape '\\${next}' in replacement (supported: \\1-\\9, \\n, \\t, \\\\, \\&)`);
        }
        this.i += 2;
      } else if (c === "&") {
        flushLit();
        parts.push({ kind: "whole" });
        this.i++;
      } else {
        lit += c;
        this.i++;
      }
    }
    throw new SedError(`sed: unterminated s command (missing closing '${delim}')`);
  }

  private expectCommandEnd(cmd: string): void {
    const c = this.src[this.i];
    if (c !== undefined && c !== ";" && !/\s/.test(c)) {
      throw new SedError(`sed: unsupported trailing characters after '${cmd}': '${this.src.slice(this.i)}'`);
    }
  }
}

/** Addresses match against the CURRENT pattern space (an earlier `s` in the
 *  same cycle can change what a later `/RE/` sees — real sed semantics). */
function addrMatch(addr: SedAddress | null, lineNo: number, isLast: boolean, space: string): boolean {
  if (addr === null) return true;
  switch (addr.kind) {
    case "line":
      return lineNo === addr.n;
    case "last":
      return isLast;
    case "re":
      return addr.re.test(space);
    case "range":
      if (addr.to === "$") return lineNo >= addr.from;
      // An empty range (M < N) still matches line N, like GNU sed.
      return lineNo === addr.from || (lineNo > addr.from && lineNo <= addr.to);
  }
}

function renderRepl(parts: ReplPart[], m: RegExpExecArray): string {
  let out = "";
  for (const p of parts) {
    if (p.kind === "lit") out += p.text;
    else if (p.kind === "whole") out += m[0];
    else out += m[p.n] ?? ""; // unmatched optional group -> empty, like sed
  }
  return out;
}

function substitute(cmd: { re: RegExp; repl: ReplPart[] }, space: string): { result: string; hit: boolean } {
  const re = cmd.re;
  re.lastIndex = 0;
  let result = "";
  let last = 0;
  let hit = false;
  let prevEnd = -1; // end offset of the previous EMITTED match; -1 = none yet
  for (;;) {
    const m = re.exec(space);
    if (m === null) break;
    // POSIX/GNU rule: under /g a null match immediately at the end of the
    // previous match is suppressed — `s/a*/X/g` on "baaad" is XbXdX, not
    // XbXXdX. Only reachable after a NON-null previous match: a null match
    // bumps lastIndex past itself, so the next match starts beyond its end.
    // The skipped char flows through via the next slice(last, m.index).
    if (m[0] === "" && m.index === prevEnd) {
      re.lastIndex = m.index + 1;
      continue;
    }
    hit = true;
    result += space.slice(last, m.index) + renderRepl(cmd.repl, m);
    last = m.index + m[0].length;
    prevEnd = last;
    if (!re.global) break;
    // Zero-width match: advance one char so `s/x*/-/g` terminates (the skipped
    // char is picked up by the next slice(last, m.index)).
    if (m[0] === "") re.lastIndex = m.index + 1;
  }
  result += space.slice(last);
  return { result, hit };
}

function execLine(
  cmds: SedCommand[],
  line: string,
  lineNo: number,
  isLast: boolean,
  autoPrint: boolean,
  out: (s: string) => void,
): void {
  let space = line;
  for (const cmd of cmds) {
    if (!addrMatch(cmd.addr, lineNo, isLast, space)) continue;
    if (cmd.kind === "d") return; // delete: end this cycle, no auto-print
    if (cmd.kind === "p") {
      out(space + "\n");
      continue;
    }
    const sub = substitute(cmd, space);
    space = sub.result;
    if (sub.hit && cmd.printOnSub) out(space + "\n");
  }
  if (autoPrint) out(space + "\n");
}

/** Run the script over a line stream with one-line lookahead so `$` (last
 *  line) is known without buffering the input. */
async function runSed(
  cmds: SedCommand[],
  lines: AsyncIterable<string> | Iterable<string>,
  autoPrint: boolean,
  out: (s: string) => void,
): Promise<void> {
  let lineNo = 0;
  let pending: string | null = null;
  for await (const line of lines) {
    if (pending !== null) execLine(cmds, pending, ++lineNo, false, autoPrint, out);
    pending = line;
  }
  if (pending !== null) execLine(cmds, pending, ++lineNo, true, autoPrint, out);
}

/** All operand files as ONE lazy line stream — a read failure surfaces when
 *  the stream reaches that file (fail fast; no partial-continue). */
async function* filesLines(fs: FileSystemApi, cwd: string, files: string[]): AsyncGenerator<string, void, undefined> {
  for (const f of files) yield* textLines(decode(fs.readFile(abs(cwd, f))));
}

export const sed: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  let suppress = false;
  let inPlace = false;
  const scripts: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n") suppress = true;
    else if (a === "-i") inPlace = true;
    else if (a === "-e") {
      const script = args[++i];
      if (script === undefined) {
        ctx.stderr.write("sed: option -e requires a script argument\n");
        return 1;
      }
      scripts.push(script);
    } else if (a === "--") {
      i++;
      break;
    } else if (a.startsWith("-") && a.length > 1) {
      ctx.stderr.write(`sed: unsupported option '${a}' (supported: -n, -i, -e SCRIPT)\n`);
      return 1;
    } else break;
  }
  const operands = args.slice(i);
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) {
      ctx.stderr.write("sed: missing script (usage: sed [-n] [-i] [-e SCRIPT]... [SCRIPT] [FILE...])\n");
      return 1;
    }
    scripts.push(script);
  }
  try {
    const cmds = scripts.flatMap((s) => new SedScriptParser(s).parse());
    for (const f of operands) {
      if (f === "-") throw new SedError("sed: unsupported operand '-' (stdin is read when no files are given)");
    }
    if (inPlace) {
      if (operands.length === 0) throw new SedError("sed: -i requires at least one file operand");
      for (const f of operands) {
        const path = abs(ctx.cwd, f);
        const parts: string[] = [];
        await runSed(cmds, textLines(decode(ctx.fs.readFile(path))), !suppress, (s) => parts.push(s));
        ctx.fs.writeFile(path, parts.join(""));
      }
      return 0;
    }
    const input = operands.length === 0 ? streamLines(ctx.stdin) : filesLines(ctx.fs, ctx.cwd, operands);
    await runSed(cmds, input, !suppress, (s) => ctx.stdout.write(s));
    return 0;
  } catch (err) {
    ctx.stderr.write((err instanceof SedError ? err.message : describeError(err)) + "\n");
    return 1;
  }
};
