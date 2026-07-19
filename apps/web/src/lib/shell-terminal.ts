/**
 * Line discipline for the browser kernel's terminal: a real-terminal feel on
 * top of a command-at-a-time RpcShellSession (async exec, no PTY). Pure — no
 * xterm import; the component feeds it xterm onData strings and command
 * results, and it returns the exact bytes to write plus the command to run
 * (if any). Tests hand it strings and assert on the writes.
 *
 * Model: a real cursor (Left/Right/Home/End/Ctrl+A/Ctrl+E move it; typing
 * INSERTS at it, Backspace deletes before it, Delete at it). End-of-line ops
 * keep the original byte-exact fast paths; a mid-line edit uses ONE strategy —
 * full redraw (erase every wrapped row, rewrite prompt+line, park the cursor
 * back) — chosen over surgical splicing because wrap-crossing splices are
 * where line editors historically go wrong. Pure cursor moves emit CR + a
 * vertical hop + a forward hop (no redraw). The one unreachable position —
 * xterm's deferred-wrap state after an exactly-full row — is restored by
 * re-echoing the final character rather than a CUF that would clamp one short.
 * While a command is in flight all input is buffered raw (type-ahead) and
 * replayed through the SAME key path after the output + next prompt land, so a
 * buffered Enter runs its line, buffered arrows edit it, and a buffered Ctrl+C
 * cancels it — exactly what a line-buffered real terminal does. Ctrl+C cannot
 * kill the running command (RpcShellSession has no kill); it is buffered like
 * any other key, not faked.
 *
 * Completion: Tab completes the token at the CURSOR (mid-line that may not be
 * the last token) against a SYNCHRONOUS completion source injected at
 * construction — the first whitespace-delimited token as a command name, any
 * other as a path (the source receives the whole token; for a path it returns
 * the entry names of the token's directory, "/"-suffixed for directories, and
 * the discipline matches the part after the last "/"). Bash semantics: a
 * unique match is inserted plus a trailing space (none after a directory's
 * "/" — the next Tab descends instead), multiple matches extend to their
 * longest common prefix, a Tab immediately after another Tab with no further
 * progress prints the sorted candidates in ls-style columns below the line and
 * then reprints prompt+line with the cursor restored (the same wrap-aware
 * redraw machinery as mid-line editing), and no matches stay silent — real
 * shells do too. A Tab typed while a command runs is buffered as-is with the
 * rest of the type-ahead and replayed through the same key path after the next
 * prompt, so it completes against the post-command state (cwd, programs) — the
 * honest reading of a late Tab, consistent with every other replayed key.
 *
 * Wrapping: the component supplies the live column count (getCols) and the
 * discipline simulates xterm's line wrapping — deferred wrap on an exactly-full
 * row, early wrap for a wide char at the last column — so in-line redraws
 * (history recall, backspace over a wrapped line) erase EVERY wrapped row
 * before redrawing instead of leaving stale rows behind. Char widths match
 * xterm's default Unicode-6 provider: CJK/fullwidth count 2, emoji count 1;
 * combining marks are not special-cased. Known limits: a line taller than the
 * viewport cannot be fully erased (cursor-up stops at the top row), and a
 * resize mid-edit relies on xterm's reflow re-wrapping the line to the new
 * width before the next key.
 */

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface TermUpdate {
  /** Bytes to write to the terminal (ANSI escapes included; "" for none). */
  readonly write: string;
  /** Command to exec, or null. When set, the discipline is busy until commandDone(). */
  readonly run: string | null;
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const ERASE_ROW = "\r\x1b[2K";
const ERASE_ROW_ABOVE = "\x1b[A\x1b[2K";

/** CSI escape sequences (the prompt's SGR coloring) — zero display width. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** East-Asian wide / fullwidth code points — the ranges xterm's default
 *  Unicode-6 provider renders as TWO cells. Emoji are deliberately absent
 *  (xterm v6 treats them as narrow); this is not a full wcwidth. */
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;

/** Simulate xterm's wrapping of already-CSI-stripped text in a `cols`-wide
 *  terminal: the number of rows it occupies and the final cursor column.
 *  Mirrors xterm's deferred wrap (writing the last cell of a row leaves the
 *  cursor ON that row, col === cols, until the next char) and early wrap (a
 *  wide char that would straddle the last column wraps whole, leaving a blank
 *  cell — which is why naive ceil(width/cols) under-counts). */
function layout(visible: string, cols: number): { rows: number; col: number } {
  let rows = 1;
  let col = 0;
  for (const ch of visible) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (col + w > cols) {
      rows += 1;
      col = w;
    } else {
      col += w;
    }
  }
  return { rows, col };
}

/** Visible width in cells of already-CSI-free text (same per-char widths as
 *  `layout`) — the candidate-column padding math. */
function visWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** Longest common prefix of a non-empty candidate list. */
function commonPrefix(items: string[]): string {
  let p = items[0]!;
  for (const s of items) {
    let k = 0;
    while (k < p.length && k < s.length && p[k] === s[k]) k += 1;
    p = p.slice(0, k);
  }
  return p;
}

/** Which universe a Tab completes from: the line's first token is a command
 *  name; every other token is a path. */
export type CompletionKind = "command" | "path";

/** Synchronous completion source (the browser kernel's FS is sync). `prefix`
 *  is the whole token at the cursor; the source returns the candidate
 *  UNIVERSE for it — command names, or the entry names of the prefix's
 *  directory ("/"-suffixed for directories) resolved against `cwd`. The
 *  discipline does the prefix matching itself. */
export type CompletionSource = (kind: CompletionKind, prefix: string, cwd: string) => string[];

/** The prompt: accent-ish workspace, dim cwd, green `$` — same info as the old
 *  block terminal's prompt row, in ANSI instead of spans. */
export function formatShellPrompt(workspace: string, cwd: string): string {
  return `\x1b[36m${workspace}${RESET} \x1b[2m${cwd}${RESET} \x1b[32m$${RESET} `;
}

/** Shell output uses bare \n; xterm (convertEol:false) needs \r\n. */
function toCrLf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** One output chunk, \r\n-converted and guaranteed to end in a newline so the
 *  next chunk / prompt starts at column 0. */
function outputChunk(text: string): string {
  const t = toCrLf(text);
  return t.endsWith("\r\n") ? t : t + "\r\n";
}

export class ShellLineDiscipline {
  private line = "";
  /** Cursor as a UTF-16 offset into `line`, always on a code-point boundary.
   *  `cursor === line.length` is the (fast-path) at-end state. */
  private cursor = 0;
  /** The prompt currently on screen. Fresh prompts recompute via getPrompt()
   *  (cwd persists across commands — `cd` moves the next prompt); in-line
   *  redraws (history recall) reuse this stored copy. */
  private prompt = "";
  private busy = false;
  /** Raw input received while busy; replayed through process() on commandDone. */
  private typeAhead = "";
  private readonly history: string[] = [];
  private histIndex: number | null = null;
  /** True while the LAST processed key was a Tab — the consecutive-Tab chain
   *  that turns a no-progress Tab into the candidate listing (readline's
   *  `rl_last_func == rl_complete` rule). Any other key breaks the chain. */
  private lastKeyWasTab = false;

  constructor(
    private readonly getPrompt: () => string,
    /** Live terminal width (the component passes () => term.cols) — read at
     *  every wrap-sensitive operation so resizes are picked up. */
    private readonly getCols: () => number,
    /** Live shell cwd (the component passes () => shell.cwd) — relayed to the
     *  completion source so path completion resolves relative prefixes. */
    private readonly getCwd: () => string,
    /** Completion source for Tab (see `CompletionSource`). */
    private readonly getCompletions: CompletionSource,
  ) {}

  /** Initial write on mount: a bare prompt — the whole empty state. */
  start(): string {
    this.prompt = this.getPrompt();
    return this.prompt;
  }

  /** Feed one xterm onData payload (keystroke or paste). */
  data(input: string): TermUpdate {
    if (this.busy) {
      this.typeAhead += input;
      return { write: "", run: null };
    }
    return this.process(input);
  }

  /** Feed the result of the command issued by the last `{ run }` update.
   *  Returns output + fresh prompt + replayed type-ahead (which may itself
   *  submit the next command). */
  commandDone(result: ShellResult): TermUpdate {
    if (!this.busy) throw new Error("ShellLineDiscipline.commandDone() without a running command");
    this.busy = false;
    let write = "";
    if (result.stdout.length > 0) write += outputChunk(result.stdout);
    if (result.stderr.length > 0) write += RED + outputChunk(result.stderr) + RESET;
    if (result.code !== 0) write += `${RED}exit ${result.code}${RESET}\r\n`;
    this.prompt = this.getPrompt();
    write += this.prompt;
    if (this.typeAhead.length === 0) return { write, run: null };
    const replay = this.typeAhead;
    this.typeAhead = ""; // process() re-stashes the tail if the replay submits a command
    const u = this.process(replay);
    return { write: write + u.write, run: u.run };
  }

  /** Idle-path key handling. Consumes `input` until done or until an Enter
   *  submits a command — then the unconsumed tail becomes type-ahead. */
  private process(input: string): TermUpdate {
    let write = "";
    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;
      const wasTab = this.lastKeyWasTab;
      this.lastKeyWasTab = false; // every key breaks the Tab chain; the Tab branch re-arms it
      if (ch === "\x1b") {
        const [consumed, w] = this.escape(input, i);
        i += consumed;
        write += w;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        i += 1;
        if (ch === "\r" && input[i] === "\n") i += 1; // pasted CRLF = one Enter
        // A mid-line Enter first parks the cursor after the last char (bash
        // behavior) so the "\r\n" and any output start below the whole line.
        write += this.moveCursor(this.cursor, this.line.length);
        const cmd = this.line.trim();
        this.line = "";
        this.cursor = 0;
        this.histIndex = null;
        if (cmd.length === 0) {
          // Empty Enter: just a fresh prompt, like a real shell.
          this.prompt = this.getPrompt();
          write += "\r\n" + this.prompt;
          continue;
        }
        this.history.push(cmd);
        this.busy = true;
        this.typeAhead = input.slice(i); // keys behind the Enter arrive "while busy"
        return { write: write + "\r\n", run: cmd };
      }
      if (ch === "\x7f" || ch === "\b") {
        i += 1;
        // At the prompt boundary (nothing before the cursor) there is nothing to erase.
        if (this.cursor === 0) continue;
        if (this.cursor === this.line.length) {
          // At-end fast path (the original byte-exact behavior).
          const before = this.screenLayout();
          const units = this.prevCharUnits(this.cursor);
          const deleted = this.line.slice(-units);
          this.line = this.line.slice(0, -units);
          this.cursor = this.line.length;
          if (before.rows === 1 && before.col < this.getCols()) {
            // Whole prompt+line on one row, no deferred wrap: erase in place.
            write += "\b \b".repeat(WIDE.test(deleted) ? 2 : 1);
          } else {
            // Wrapped (or exactly-full) row: xterm's BS cannot cross a wrap
            // boundary, so erase every row and redraw the shortened line.
            write +=
              ERASE_ROW + ERASE_ROW_ABOVE.repeat(before.rows - 1) + this.prompt + this.line;
          }
        } else {
          // Mid-line: delete the code point before the cursor, full redraw.
          const snap = this.snapshotForRedraw();
          const units = this.prevCharUnits(this.cursor);
          this.line = this.line.slice(0, this.cursor - units) + this.line.slice(this.cursor);
          this.cursor -= units;
          write += this.redraw(snap);
        }
        continue;
      }
      if (ch === "\x03") {
        // Ctrl+C on an idle line: cancel it — ^C (after the line, bash-style),
        // fresh prompt, line discarded.
        i += 1;
        write += this.moveCursor(this.cursor, this.line.length);
        this.line = "";
        this.cursor = 0;
        this.histIndex = null;
        this.prompt = this.getPrompt();
        write += "^C\r\n" + this.prompt;
        continue;
      }
      if (ch === "\x01") {
        i += 1; // Ctrl+A = Home
        write += this.cursorTo(0);
        continue;
      }
      if (ch === "\x05") {
        i += 1; // Ctrl+E = End
        write += this.cursorTo(this.line.length);
        continue;
      }
      if (ch === "\t") {
        i += 1;
        write += this.complete(wasTab);
        this.lastKeyWasTab = true;
        continue;
      }
      if (ch < " ") {
        i += 1; // other control chars (Ctrl+…): no binding, ignore
        continue;
      }
      // Printable: consume a whole code point (a surrogate pair arrives as two
      // UTF-16 units — a mid-line insert must never split one).
      let glyph = ch;
      if (/[\uD800-\uDBFF]/.test(ch) && i + 1 < input.length && /[\uDC00-\uDFFF]/.test(input[i + 1]!)) {
        glyph += input[i + 1]!;
      }
      i += glyph.length;
      if (this.cursor === this.line.length) {
        this.line += glyph;
        this.cursor = this.line.length;
        write += glyph; // local echo (at-end fast path)
      } else {
        const snap = this.snapshotForRedraw();
        this.line = this.line.slice(0, this.cursor) + glyph + this.line.slice(this.cursor);
        this.cursor += glyph.length;
        write += this.redraw(snap);
      }
    }
    return { write, run: null };
  }

  /** Consume one escape sequence at input[i] → [chars consumed, write].
   *  Up/Down drive history; Left/Right/Home/End move the cursor; Delete edits
   *  at it; anything else is swallowed. */
  private escape(input: string, i: number): [number, string] {
    if (input[i + 1] !== "[") return [2, ""]; // ESC + one char (alt-chords): ignore
    let j = i + 2;
    while (j < input.length && input[j]! >= "0" && input[j]! <= "?") j += 1; // CSI parameter bytes
    const seq = input.slice(i, j + 1); // includes the final byte (if present)
    const consumed = j + 1 - i;
    if (seq === "\x1b[A") return [consumed, this.historyMove(-1)];
    if (seq === "\x1b[B") return [consumed, this.historyMove(1)];
    if (seq === "\x1b[D") return [consumed, this.cursorTo(this.cursor - this.prevCharUnits(this.cursor))];
    if (seq === "\x1b[C") return [consumed, this.cursorTo(this.cursor + this.nextCharUnits(this.cursor))];
    if (seq === "\x1b[H" || seq === "\x1b[1~") return [consumed, this.cursorTo(0)];
    if (seq === "\x1b[F" || seq === "\x1b[4~") return [consumed, this.cursorTo(this.line.length)];
    if (seq === "\x1b[3~") return [consumed, this.deleteAtCursor()];
    return [consumed, ""];
  }

  /** UTF-16 units of the code point BEFORE offset `c` (0 at the start). */
  private prevCharUnits(c: number): number {
    if (c === 0) return 0;
    return c >= 2 && /[\uDC00-\uDFFF]/.test(this.line[c - 1]!) && /[\uD800-\uDBFF]/.test(this.line[c - 2]!)
      ? 2
      : 1;
  }

  /** UTF-16 units of the code point AT offset `c` (0 at the end). */
  private nextCharUnits(c: number): number {
    if (c >= this.line.length) return 0;
    return /[\uD800-\uDBFF]/.test(this.line[c]!) && c + 1 < this.line.length && /[\uDC00-\uDFFF]/.test(this.line[c + 1]!)
      ? 2
      : 1;
  }

  /** Delete key: remove the code point AT the cursor (no-op at line end). */
  private deleteAtCursor(): string {
    const units = this.nextCharUnits(this.cursor);
    if (units === 0) return "";
    const snap = this.snapshotForRedraw();
    this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + units);
    return this.redraw(snap);
  }

  /** Tab: complete the token at the cursor (its start = after the last
   *  whitespace BEFORE the cursor; text after the cursor stays put, readline
   *  style). `wasTab` = the previous key was also a Tab — the double-Tab that
   *  lists candidates when no further progress is possible. */
  private complete(wasTab: boolean): string {
    const before = this.line.slice(0, this.cursor);
    const tokenStart = /\S*$/.exec(before)!.index;
    const prefix = before.slice(tokenStart);
    const kind: CompletionKind =
      before.slice(0, tokenStart).trim().length === 0 ? "command" : "path";
    // For a path the source returns the entry NAMES of the prefix's directory,
    // so the part being matched is what follows the last "/"; for a command
    // the whole prefix matches against the returned command names.
    const base = kind === "path" ? prefix.slice(prefix.lastIndexOf("/") + 1) : prefix;
    const matches = this.getCompletions(kind, prefix, this.getCwd()).filter((n) =>
      n.startsWith(base),
    );
    if (matches.length === 0) return ""; // no matches: real shells stay silent
    if (matches.length === 1) {
      const m = matches[0]!;
      // Unique: complete it — a trailing space readies the next token, except
      // after a directory's "/" (the natural next Tab descends into it).
      return this.insert(m.slice(base.length) + (m.endsWith("/") ? "" : " "));
    }
    const ext = commonPrefix(matches).slice(base.length);
    if (ext.length > 0) return this.insert(ext);
    return wasTab ? this.listCandidates(matches) : "";
  }

  /** Insert `text` at the cursor — the same at-end echo / mid-line full-redraw
   *  split as typing, for a multi-character completion insertion. */
  private insert(text: string): string {
    if (text.length === 0) return "";
    if (this.cursor === this.line.length) {
      this.line += text;
      this.cursor = this.line.length;
      return text;
    }
    const snap = this.snapshotForRedraw();
    this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor);
    this.cursor += text.length;
    return this.redraw(snap);
  }

  /** Double-Tab listing: park the physical cursor after the (possibly wrapped)
   *  line, print the sorted candidates in ls-style columns sized to the live
   *  width, reprint prompt+line (xterm re-wraps it naturally), and hop the
   *  cursor back to its logical spot — the same wrap-aware moveCursor as
   *  mid-line editing, so a wrapped edit line round-trips exactly. */
  private listCandidates(matches: string[]): string {
    const cols = this.getCols();
    const names = [...matches].sort();
    const colWidth = Math.max(...names.map(visWidth)) + 2;
    const perRow = Math.max(1, Math.floor(cols / colWidth));
    let rows = "";
    for (let r = 0; r < names.length; r += perRow) {
      const row = names.slice(r, r + perRow);
      rows +=
        row
          .map((n, k) => (k < row.length - 1 ? n + " ".repeat(colWidth - visWidth(n)) : n))
          .join("") + "\r\n";
    }
    return (
      this.moveCursor(this.cursor, this.line.length) +
      "\r\n" +
      rows +
      this.prompt +
      this.line +
      this.moveCursor(this.line.length, this.cursor)
    );
  }

  /** Move the logical cursor to `to` (clamped), emitting the physical move. */
  private cursorTo(to: number): string {
    const clamped = Math.max(0, Math.min(this.line.length, to));
    const w = this.moveCursor(this.cursor, clamped);
    this.cursor = clamped;
    return w;
  }

  /** Physical position of logical offset `c`: 1-based row within the wrapped
   *  prompt+line, 0-based column. An exactly-full row is xterm's deferred-wrap
   *  state: mid-line it means "start of the next row" (where that next char
   *  physically sits); at line end the cursor really stays on the full row. */
  private physPos(c: number): { row: number; col: number } {
    const cols = this.getCols();
    const { rows, col } = layout((this.prompt + this.line.slice(0, c)).replace(CSI, ""), cols);
    if (col === cols && c < this.line.length) return { row: rows + 1, col: 0 };
    return { row: rows, col };
  }

  /** Emit the physical cursor move between two logical offsets on the CURRENT
   *  line: CR to column 0 (clears xterm's pending-wrap state), a vertical hop,
   *  a forward hop. The deferred-wrap end position is unreachable by CUF (it
   *  clamps at the last column), so that one case lands before the final char
   *  and re-echoes it — xterm re-enters its natural deferred state. */
  private moveCursor(from: number, to: number): string {
    if (from === to) return "";
    if (to === this.line.length && this.line.length > 0) {
      const cols = this.getCols();
      const raw = layout((this.prompt + this.line).replace(CSI, ""), cols);
      if (raw.col === cols) {
        const prev = to - this.prevCharUnits(to);
        return this.moveReachable(from, prev) + this.line.slice(prev);
      }
    }
    return this.moveReachable(from, to);
  }

  private moveReachable(from: number, to: number): string {
    const a = this.physPos(from);
    const b = this.physPos(to);
    let w = "\r";
    if (b.row < a.row) w += `\x1b[${a.row - b.row}A`;
    else if (b.row > a.row) w += `\x1b[${b.row - a.row}B`;
    if (b.col > 0) w += `\x1b[${b.col}C`;
    return w;
  }

  /** Pre-mutation snapshot for `redraw`: how many rows the OLD prompt+line
   *  occupied and which of them the cursor physically sat on. */
  private snapshotForRedraw(): { rows: number; cursorRow: number } {
    return { rows: this.screenLayout().rows, cursorRow: this.physPos(this.cursor).row };
  }

  /** Mid-line edit strategy: hop down to the OLD last row, erase every wrapped
   *  row, rewrite prompt + (new) line, park the cursor at its logical spot. */
  private redraw(snap: { rows: number; cursorRow: number }): string {
    let w = "";
    if (snap.cursorRow < snap.rows) w += `\x1b[${snap.rows - snap.cursorRow}B`;
    w += ERASE_ROW + ERASE_ROW_ABOVE.repeat(snap.rows - 1) + this.prompt + this.line;
    w += this.moveCursor(this.line.length, this.cursor);
    return w;
  }

  /** ArrowUp (-1) / ArrowDown (+1): replace the current line with a history
   *  entry — same walk as the old block terminal (Down past the newest entry
   *  clears the line). */
  private historyMove(dir: -1 | 1): string {
    if (dir === -1) {
      if (this.history.length === 0) return "";
      const next = this.histIndex === null ? this.history.length - 1 : Math.max(0, this.histIndex - 1);
      this.histIndex = next;
      return this.replaceLine(this.history[next]!);
    }
    if (this.histIndex === null) return "";
    const next = this.histIndex + 1;
    if (next >= this.history.length) {
      this.histIndex = null;
      return this.replaceLine("");
    }
    this.histIndex = next;
    return this.replaceLine(this.history[next]!);
  }

  /** How the current prompt+line lies on screen (the cursor sits on the last
   *  of `rows`; `col === cols` is xterm's deferred-wrap state). */
  private screenLayout(): { rows: number; col: number } {
    return layout((this.prompt + this.line).replace(CSI, ""), this.getCols());
  }

  /** Erase the on-screen line — EVERY wrapped row, prompt included — and
   *  redraw it with `text` (which xterm re-wraps naturally). History recall
   *  always parks the cursor at the END of the recalled line. */
  private replaceLine(text: string): string {
    const snap = this.snapshotForRedraw();
    let erase = "";
    if (snap.cursorRow < snap.rows) erase += `\x1b[${snap.rows - snap.cursorRow}B`;
    erase += ERASE_ROW + ERASE_ROW_ABOVE.repeat(snap.rows - 1);
    this.line = text;
    this.cursor = text.length;
    return erase + this.prompt + text;
  }
}
