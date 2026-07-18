import type { Program } from "../process/program.js";
import { abs, decode, describeError } from "./util.js";
import { streamLines, textLines } from "./lines.js";

/**
 * `awk` — an honest busybox-style SUBSET for the browser kernel:
 *
 *   awk [-F SEP] 'PROGRAM' [FILE...]
 *
 * PROGRAM is pattern-action pairs. Patterns: BEGIN, END, /RE/, or ONE
 * comparison `expr OP expr` with OP in == != < <= > >= ~ !~ (the right side
 * of ~ / !~ must be a /RE/ or "string" literal). Actions: `{ print args }`
 * and plain `var = expr` assignments, `;`- or newline-separated; a bare
 * pattern's default action is `print $0`. Expressions: string/number
 * literals, $0/$N (any expression index), NR/FNR/NF/FS, variables,
 * + - * / % arithmetic, and concatenation by juxtaposition (which binds
 * LOOSER than arithmetic, as in awk: `1+2 "x"` is "3x"). `-F` takes a single
 * literal character or a regex (multi-char, e.g. '::' or '\t'); `FS = "..."`
 * in BEGIN works too. Input comes from the files as one NR sequence (FNR
 * resets per file) or stdin when no files are given; a BEGIN-only program
 * reads no input. RE = JavaScript RegExp semantics (≈ ERE).
 *
 * Everything else FAILS loudly with a precise "awk: unsupported ..." error —
 * printf, getline, if/while/for, functions, arrays, ++/+=, && ||, ternary,
 * field assignment, print redirection, -v, and the output-format specials
 * (OFS/ORS/OFMT/RS — output is fixed to OFS=" ", ORS="\n"). Never a
 * silently-wrong result. In particular ALL function calls error: any
 * `ident(...)` (so `length($0)`, `int(x)`, `toupper(s)`, ... can never parse
 * as concatenation with an uninitialized variable), the bare built-in names
 * (`print length`), and assignment to a built-in name. A multi-char FS regex
 * must not contain capturing groups (JS String.split would interleave the
 * captures into the fields) — write (?:...) instead.
 *
 * Deliberate simplifications (documented, not hidden): comparisons are
 * numeric when BOTH sides look numeric, string otherwise (POSIX "strnum"
 * provenance is not tracked); non-integer numbers print with ~%.6g.
 */

class AwkError extends Error {}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "re"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "nl" };

const NUM_RE = /(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_][A-Za-z_0-9]*/y;
const SINGLE_OPS = "{}();,$=<>~+-*/%";

const UNSUPPORTED_KEYWORDS = new Set([
  "if", "else", "while", "for", "do", "getline", "function", "func", "delete",
  "exit", "next", "nextfile", "return", "break", "continue", "in",
]);
const UNSUPPORTED_SPECIALS = new Set([
  "OFS", "ORS", "RS", "OFMT", "CONVFMT", "SUBSEP", "RSTART", "RLENGTH",
  "FILENAME", "ENVIRON", "ARGC", "ARGV",
]);
const SPECIALS = new Set(["NR", "FNR", "NF", "FS"]);
const CMP_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);
/** awk's built-in functions — NONE are implemented. Blacklisted as plain
 *  identifiers so bare `length` (call without parens) errors instead of
 *  reading an uninitialized variable named "length". */
const BUILTIN_FUNCS = new Set([
  "length", "substr", "index", "split", "sub", "gsub", "match", "sprintf",
  "int", "sqrt", "exp", "log", "sin", "cos", "atan2", "rand", "srand",
  "toupper", "tolower", "system",
]);

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let prev: Token | undefined;
  const push = (tok: Token): void => {
    toks.push(tok);
    prev = tok;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      push({ t: "nl" });
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      i++;
      let v = "";
      for (;;) {
        if (i >= src.length) throw new AwkError("awk: unterminated string literal");
        const ch = src[i]!;
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === "\n") throw new AwkError("awk: unterminated string literal (newline inside string)");
        if (ch === "\\") {
          const n = src[i + 1];
          if (n === undefined) throw new AwkError("awk: unterminated string literal");
          if (n === "n") v += "\n";
          else if (n === "t") v += "\t";
          else if (n === "r") v += "\r";
          else if (n === '"') v += '"';
          else if (n === "\\") v += "\\";
          else if (n === "/") v += "/";
          else throw new AwkError(`awk: unsupported escape '\\${n}' in string (supported: \\n \\t \\r \\" \\\\ \\/)`);
          i += 2;
        } else {
          v += ch;
          i++;
        }
      }
      push({ t: "str", v });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src)!;
      push({ t: "num", v: Number(m[0]) });
      i = NUM_RE.lastIndex;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(src)!;
      push({ t: "ident", v: m[0] });
      i = IDENT_RE.lastIndex;
      continue;
    }
    if (c === "/") {
      // `/` after an operand is division; anywhere else it starts a regex.
      const afterOperand =
        prev !== undefined &&
        (prev.t === "num" || prev.t === "str" || prev.t === "re" || prev.t === "ident" ||
          (prev.t === "op" && prev.v === ")"));
      if (!afterOperand) {
        i++;
        let v = "";
        for (;;) {
          if (i >= src.length) throw new AwkError("awk: unterminated regex literal");
          const ch = src[i]!;
          if (ch === "\n") throw new AwkError("awk: unterminated regex literal (newline inside regex)");
          if (ch === "\\") {
            const n = src[i + 1];
            if (n === undefined) throw new AwkError("awk: unterminated regex literal");
            v += "\\" + n;
            i += 2;
            continue;
          }
          if (ch === "/") {
            i++;
            break;
          }
          v += ch;
          i++;
        }
        push({ t: "re", v });
        continue;
      }
      // else fall through: division operator below
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "!~") {
      push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (["&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "^=", ">>"].includes(two)) {
      throw new AwkError(`awk: unsupported operator '${two}'`);
    }
    if (SINGLE_OPS.includes(c)) {
      push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "[" || c === "]") throw new AwkError("awk: unsupported: arrays (a[i])");
    if (c === "!") throw new AwkError("awk: unsupported operator '!' (only != and !~ are supported)");
    if (c === "^") throw new AwkError("awk: unsupported operator '^' (exponentiation)");
    if (c === "?" || c === ":") throw new AwkError("awk: unsupported operator '?:' (ternary)");
    if (c === "&") throw new AwkError("awk: unsupported operator '&'");
    if (c === "|") throw new AwkError("awk: unsupported operator '|' (pipes and getline)");
    throw new AwkError(`awk: unexpected character '${c}' in program`);
  }
  return toks;
}

function describeToken(t: Token | undefined): string {
  if (t === undefined) return "end of program";
  switch (t.t) {
    case "num":
      return `number ${t.v}`;
    case "str":
      return `string "${t.v}"`;
    case "re":
      return `/${t.v}/`;
    case "ident":
    case "op":
      return `'${t.v}'`;
    case "nl":
      return "end of line";
  }
}

function compileRe(src: string, what: string): RegExp {
  try {
    return new RegExp(src);
  } catch (err) {
    throw new AwkError(`awk: invalid ${what} /${src}/: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ------------------------------------------------------------------- parser

type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "var"; name: string }
  | { k: "special"; name: "NR" | "FNR" | "NF" | "FS" }
  | { k: "field"; idx: Expr }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "%"; l: Expr; r: Expr }
  | { k: "neg"; e: Expr }
  | { k: "concat"; parts: Expr[] };

type AwkPattern =
  | { k: "re"; re: RegExp }
  | { k: "cmp"; op: string; l: Expr; r: Expr }
  | { k: "match"; negate: boolean; l: Expr; re: RegExp };

type Stmt =
  | { k: "print"; args: Expr[] } // args empty = print $0
  | { k: "assign"; name: string; e: Expr }
  | { k: "assignFS"; e: Expr };

interface AwkRule {
  where: "begin" | "end" | "main";
  pattern: AwkPattern | null; // null = every record (or BEGIN/END, per `where`)
  action: Stmt[] | null; // null = default `print $0`; never null for begin/end
}

class AwkParser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  parse(): AwkRule[] {
    const rules: AwkRule[] = [];
    this.skipSeps();
    while (this.peek() !== undefined) {
      rules.push(this.parseRule());
      this.skipSeps();
    }
    return rules;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token | undefined {
    return this.toks[this.pos++];
  }
  private atOp(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === "op" && t.v === v;
  }
  private skipSeps(): void {
    for (;;) {
      const t = this.peek();
      if (t !== undefined && (t.t === "nl" || (t.t === "op" && t.v === ";"))) this.pos++;
      else return;
    }
  }
  private atStmtEnd(): boolean {
    const t = this.peek();
    return t === undefined || t.t === "nl" || (t.t === "op" && (t.v === ";" || t.v === "}"));
  }

  private parseRule(): AwkRule {
    const tok = this.peek()!;
    if (tok.t === "ident" && (tok.v === "BEGIN" || tok.v === "END")) {
      this.pos++;
      if (!this.atOp("{")) throw new AwkError(`awk: ${tok.v} requires a { action } block`);
      return { where: tok.v === "BEGIN" ? "begin" : "end", pattern: null, action: this.parseAction() };
    }
    if (this.atOp("{")) return { where: "main", pattern: null, action: this.parseAction() };
    const pattern = this.parsePattern();
    const action = this.atOp("{") ? this.parseAction() : null;
    return { where: "main", pattern, action };
  }

  private parsePattern(): AwkPattern {
    const tok = this.peek()!;
    if (tok.t === "re") {
      this.pos++;
      return { k: "re", re: compileRe(tok.v, "pattern regex") };
    }
    const l = this.parseExpr();
    const opTok = this.peek();
    if (opTok === undefined || opTok.t !== "op" || (!CMP_OPS.has(opTok.v) && opTok.v !== "~" && opTok.v !== "!~")) {
      throw new AwkError(
        `awk: unsupported pattern — expected BEGIN, END, /regex/, or a comparison, got ${describeToken(opTok)} (bare-expression patterns are unsupported)`,
      );
    }
    this.pos++;
    if (opTok.v === "~" || opTok.v === "!~") {
      return { k: "match", negate: opTok.v === "!~", l, re: this.parseMatchRhs() };
    }
    return { k: "cmp", op: opTok.v, l, r: this.parseExpr() };
  }

  private parseMatchRhs(): RegExp {
    const t = this.peek();
    if (t !== undefined && t.t === "re") {
      this.pos++;
      return compileRe(t.v, "match regex");
    }
    if (t !== undefined && t.t === "str") {
      this.pos++;
      return compileRe(t.v, "match regex");
    }
    throw new AwkError('awk: ~ and !~ require a /regex/ or "string" literal on the right-hand side');
  }

  private parseAction(): Stmt[] {
    this.pos++; // '{'
    const stmts: Stmt[] = [];
    for (;;) {
      // ';' and newlines separate statements inside an action.
      while (this.peek() !== undefined && (this.peek()!.t === "nl" || this.atOp(";"))) this.pos++;
      if (this.atOp("}")) {
        this.pos++;
        return stmts;
      }
      if (this.peek() === undefined) throw new AwkError("awk: unterminated action (missing '}')");
      stmts.push(this.parseStmt());
    }
  }

  private parseStmt(): Stmt {
    const tok = this.peek()!;
    if (tok.t === "ident") {
      if (tok.v === "print") {
        this.pos++;
        return this.parsePrint();
      }
      if (tok.v === "printf") throw new AwkError("awk: unsupported: printf (only print is supported)");
      if (UNSUPPORTED_KEYWORDS.has(tok.v)) throw new AwkError(`awk: unsupported keyword '${tok.v}'`);
      this.pos++;
      if (this.atOp("=")) {
        this.pos++;
        const name = tok.v;
        if (name === "NR" || name === "NF" || name === "FNR") {
          throw new AwkError(`awk: unsupported: assignment to ${name} (read-only here)`);
        }
        if (UNSUPPORTED_SPECIALS.has(name)) {
          throw new AwkError(`awk: unsupported special variable '${name}' (output format is fixed: OFS=" ", ORS="\\n")`);
        }
        if (BUILTIN_FUNCS.has(name)) {
          // Real awk: syntax error (function names are not assignable).
          throw new AwkError(`awk: unsupported: assignment to built-in function name '${name}'`);
        }
        const e = this.parseExpr();
        if (!this.atStmtEnd()) {
          throw new AwkError(`awk: unexpected ${describeToken(this.peek())} after assignment to '${name}'`);
        }
        return name === "FS" ? { k: "assignFS", e } : { k: "assign", name, e };
      }
      if (this.atOp("(")) {
        throw new AwkError(`awk: unsupported: function call '${tok.v}(...)' (no functions in this subset)`);
      }
      throw new AwkError(
        `awk: unsupported statement at '${tok.v}' (only 'print' and variable assignment are supported)`,
      );
    }
    if (tok.t === "op" && tok.v === "$") {
      throw new AwkError(
        "awk: unsupported statement starting with '$' (fields cannot be assigned; only 'print' and variable assignment are supported)",
      );
    }
    throw new AwkError(
      `awk: unsupported statement at ${describeToken(tok)} (only 'print' and variable assignment are supported)`,
    );
  }

  private parsePrint(): Stmt {
    if (this.atStmtEnd()) return { k: "print", args: [] };
    const args = [this.parseExpr()];
    while (this.atOp(",")) {
      this.pos++;
      args.push(this.parseExpr());
    }
    if (this.atOp(">") || this.atOp(">=")) {
      throw new AwkError("awk: unsupported: print redirection (print ... > file)");
    }
    if (!this.atStmtEnd()) {
      throw new AwkError(`awk: unexpected ${describeToken(this.peek())} after print arguments`);
    }
    return { k: "print", args };
  }

  // Expression grammar, loosest to tightest: concatenation (juxtaposition) →
  // + - → * / % → unary - → $field / literals / (…). Matches awk: `1+2 "x"`
  // concatenates the SUM with "x".
  private parseExpr(): Expr {
    const parts = [this.parseAdditive()];
    while (this.startsOperand()) parts.push(this.parseAdditive());
    return parts.length === 1 ? parts[0]! : { k: "concat", parts };
  }

  private startsOperand(): boolean {
    const t = this.peek();
    if (t === undefined) return false;
    if (t.t === "num" || t.t === "str") return true;
    if (t.t === "ident") {
      return !UNSUPPORTED_KEYWORDS.has(t.v) && t.v !== "print" && t.v !== "printf" && t.v !== "BEGIN" && t.v !== "END";
    }
    return t.t === "op" && (t.v === "$" || t.v === "(");
  }

  private parseAdditive(): Expr {
    let l = this.parseMultiplicative();
    while (this.atOp("+") || this.atOp("-")) {
      const op = (this.next() as { t: "op"; v: "+" | "-" }).v;
      l = { k: "bin", op, l, r: this.parseMultiplicative() };
    }
    return l;
  }

  private parseMultiplicative(): Expr {
    let l = this.parseUnary();
    while (this.atOp("*") || this.atOp("/") || this.atOp("%")) {
      const op = (this.next() as { t: "op"; v: "*" | "/" | "%" }).v;
      l = { k: "bin", op, l, r: this.parseUnary() };
    }
    return l;
  }

  private parseUnary(): Expr {
    if (this.atOp("-")) {
      this.pos++;
      return { k: "neg", e: this.parseUnary() };
    }
    if (this.atOp("+")) {
      // Unary plus: numeric coercion, expressed as 0 + x.
      this.pos++;
      return { k: "bin", op: "+", l: { k: "num", v: 0 }, r: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (t === undefined) throw new AwkError("awk: unexpected end of program in expression");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "re") {
      throw new AwkError("awk: unsupported: /regex/ inside an expression (regexes only appear as patterns and after ~ / !~)");
    }
    if (t.t === "ident") {
      if (UNSUPPORTED_KEYWORDS.has(t.v)) throw new AwkError(`awk: unsupported keyword '${t.v}'`);
      if (t.v === "print" || t.v === "printf" || t.v === "BEGIN" || t.v === "END") {
        throw new AwkError(`awk: unexpected keyword '${t.v}' in expression`);
      }
      // An identifier followed by '(' is a function call — no functions exist
      // in this subset, so it must ERROR, never parse as concatenation of an
      // uninitialized variable with a parenthesized expression (that would
      // make `length($0)` silently print $0). This also rejects `x (expr)`
      // concatenation: whitespace is not tokenized, and losing that corner is
      // far better than silently mis-executing length/int/toupper/sqrt.
      if (this.atOp("(")) {
        throw new AwkError(`awk: unsupported: function call '${t.v}(...)' (no functions in this subset)`);
      }
      if (BUILTIN_FUNCS.has(t.v)) {
        throw new AwkError(`awk: unsupported: built-in function '${t.v}' (no functions in this subset)`);
      }
      if (UNSUPPORTED_SPECIALS.has(t.v)) {
        throw new AwkError(`awk: unsupported special variable '${t.v}' (supported: NR, FNR, NF, FS)`);
      }
      if (SPECIALS.has(t.v)) return { k: "special", name: t.v as "NR" | "FNR" | "NF" | "FS" };
      return { k: "var", name: t.v };
    }
    if (t.t === "op" && t.v === "$") return { k: "field", idx: this.parsePrimary() };
    if (t.t === "op" && t.v === "(") {
      const e = this.parseExpr();
      if (!this.atOp(")")) {
        throw new AwkError(
          `awk: expected ')' but got ${describeToken(this.peek())} (comparisons are only supported as patterns)`,
        );
      }
      this.pos++;
      return e;
    }
    if (t.t === "op" && (CMP_OPS.has(t.v) || t.v === "~" || t.v === "!~")) {
      throw new AwkError(`awk: unsupported: comparison '${t.v}' inside an expression (comparisons are only supported as patterns)`);
    }
    throw new AwkError(`awk: unexpected ${describeToken(t)} in expression`);
  }
}

// -------------------------------------------------------------- interpreter

type Value = string | number;

interface AwkState {
  line: string; // $0
  fields: string[]; // $1..$NF
  nr: number;
  fnr: number;
  fsRaw: string;
  split: (line: string) => string[];
  vars: Map<string, Value>;
}

/** FS semantics: " " = awk's default (trim + split on whitespace runs); any
 *  other single char = literal separator; multi-char = a regex (so -F'\t'
 *  and -F'::' both work). Empty FS errors — char-splitting is unsupported. */
function makeSplitter(raw: string): (line: string) => string[] {
  if (raw === "") throw new AwkError("awk: unsupported: empty field separator");
  if (raw === " ") {
    return (line) => {
      const t = line.trim();
      return t === "" ? [] : t.split(/[ \t]+/);
    };
  }
  if (raw.length === 1) return (line) => (line === "" ? [] : line.split(raw));
  const re = compileRe(raw, "field separator");
  // String.prototype.split interleaves capture-group text into the field
  // list (-F'(,|;)' on "a,b" would make $2 the SEPARATOR ","), so capturing
  // groups must error, never silently shift fields. `re|` matches the empty
  // string and its exec result has one slot per capture group.
  const groupCount = new RegExp(raw + "|").exec("")!.length - 1;
  if (groupCount > 0) {
    throw new AwkError(
      `awk: unsupported: capturing group in field separator /${raw}/ (use a non-capturing group: (?:...))`,
    );
  }
  return (line) => (line === "" ? [] : line.split(re));
}

function newState(fsRaw: string): AwkState {
  return {
    line: "",
    fields: [],
    nr: 0,
    fnr: 0,
    fsRaw,
    split: makeSplitter(fsRaw),
    vars: new Map(),
  };
}

const LEADING_NUM = /^[ \t]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;
const FULL_NUM = /^[ \t]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t]*$/;

function toNum(v: Value): number {
  if (typeof v === "number") return v;
  const m = LEADING_NUM.exec(v);
  return m === null ? 0 : Number(m[0]);
}

/** awk's default OFMT is %.6g: integers print as integers, other numbers
 *  with 6 significant digits (approximated via toPrecision). */
function numToStr(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(6)));
}

function toStr(v: Value): string {
  return typeof v === "string" ? v : numToStr(v);
}

/** Numeric comparison when both sides look numeric, string otherwise. */
function cmpValues(a: Value, b: Value): number {
  const aNum = typeof a === "number" || FULL_NUM.test(a);
  const bNum = typeof b === "number" || FULL_NUM.test(b);
  if (aNum && bNum) {
    const x = toNum(a);
    const y = toNum(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toStr(a);
  const y = toStr(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function evalExpr(e: Expr, st: AwkState): Value {
  switch (e.k) {
    case "num":
      return e.v;
    case "str":
      return e.v;
    case "var":
      return st.vars.get(e.name) ?? ""; // uninitialized = "" (0 in arithmetic), like awk
    case "special":
      switch (e.name) {
        case "NR":
          return st.nr;
        case "FNR":
          return st.fnr;
        case "NF":
          return st.fields.length;
        case "FS":
          return st.fsRaw;
      }
      break;
    case "field": {
      const raw = toNum(evalExpr(e.idx, st));
      const n = Math.trunc(raw);
      if (!Number.isFinite(n) || n < 0) throw new AwkError(`awk: invalid field index ${raw}`);
      if (n === 0) return st.line;
      return st.fields[n - 1] ?? ""; // past NF = "", like awk
    }
    case "bin": {
      const l = toNum(evalExpr(e.l, st));
      const r = toNum(evalExpr(e.r, st));
      switch (e.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          if (r === 0) throw new AwkError("awk: division by zero");
          return l / r;
        case "%":
          if (r === 0) throw new AwkError("awk: division by zero in %");
          return l % r;
      }
      break;
    }
    case "neg":
      return -toNum(evalExpr(e.e, st));
    case "concat":
      return e.parts.map((p) => toStr(evalExpr(p, st))).join("");
  }
  /* c8 ignore next */
  throw new AwkError("awk: internal error: unreachable expression kind");
}

function patternMatches(p: AwkPattern, st: AwkState): boolean {
  switch (p.k) {
    case "re":
      return p.re.test(st.line);
    case "match": {
      const hit = p.re.test(toStr(evalExpr(p.l, st)));
      return p.negate ? !hit : hit;
    }
    case "cmp": {
      const c = cmpValues(evalExpr(p.l, st), evalExpr(p.r, st));
      switch (p.op) {
        case "==":
          return c === 0;
        case "!=":
          return c !== 0;
        case "<":
          return c < 0;
        case "<=":
          return c <= 0;
        case ">":
          return c > 0;
        default:
          return c >= 0; // ">="
      }
    }
  }
}

function execAction(stmts: Stmt[], st: AwkState, out: (s: string) => void): void {
  for (const s of stmts) {
    if (s.k === "print") {
      const body = s.args.length === 0 ? st.line : s.args.map((a) => toStr(evalExpr(a, st))).join(" ");
      out(body + "\n");
    } else if (s.k === "assign") {
      st.vars.set(s.name, evalExpr(s.e, st));
    } else {
      st.fsRaw = toStr(evalExpr(s.e, st));
      st.split = makeSplitter(st.fsRaw);
    }
  }
}

function consumeLine(line: string, rules: AwkRule[], st: AwkState, out: (s: string) => void): void {
  st.nr++;
  st.fnr++;
  st.line = line;
  st.fields = st.split(line);
  for (const r of rules) {
    if (r.where !== "main") continue;
    if (r.pattern !== null && !patternMatches(r.pattern, st)) continue;
    if (r.action === null) out(st.line + "\n");
    else execAction(r.action, st, out);
  }
}

export const awk: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  let fsRaw = " ";
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-F") {
      const sep = args[++i];
      if (sep === undefined) {
        ctx.stderr.write("awk: option -F requires a separator argument\n");
        return 1;
      }
      fsRaw = sep;
    } else if (a.startsWith("-F") && a.length > 2) {
      fsRaw = a.slice(2);
    } else if (a === "--") {
      i++;
      break;
    } else if (a.startsWith("-") && a.length > 1) {
      ctx.stderr.write(`awk: unsupported option '${a}' (supported: -F SEP)\n`);
      return 1;
    } else break;
  }
  const programSrc = args[i];
  if (programSrc === undefined) {
    ctx.stderr.write("awk: missing program (usage: awk [-F SEP] 'PROGRAM' [FILE...])\n");
    return 1;
  }
  const files = args.slice(i + 1);
  try {
    const rules = new AwkParser(tokenize(programSrc)).parse();
    for (const f of files) {
      if (f === "-") throw new AwkError("awk: unsupported operand '-' (stdin is read when no files are given)");
    }
    const st = newState(fsRaw);
    const out = (s: string): void => {
      ctx.stdout.write(s);
    };
    for (const r of rules) if (r.where === "begin") execAction(r.action!, st, out);
    // A BEGIN-only program reads no input (so `awk 'BEGIN{...}'` never waits
    // on stdin) — main and END rules are what require records.
    if (rules.some((r) => r.where !== "begin")) {
      if (files.length === 0) {
        for await (const line of streamLines(ctx.stdin)) consumeLine(line, rules, st, out);
      } else {
        for (const f of files) {
          st.fnr = 0;
          for (const line of textLines(decode(ctx.fs.readFile(abs(ctx.cwd, f))))) {
            consumeLine(line, rules, st, out);
          }
        }
      }
    }
    for (const r of rules) if (r.where === "end") execAction(r.action!, st, out);
    return 0;
  } catch (err) {
    ctx.stderr.write((err instanceof AwkError ? err.message : describeError(err)) + "\n");
    return 1;
  }
};
