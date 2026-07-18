/**
 * Line discipline for the browser kernel's terminal: a real-terminal feel on
 * top of a command-at-a-time RpcShellSession (async exec, no PTY). Pure — no
 * xterm import; the component feeds it xterm onData strings and command
 * results, and it returns the exact bytes to write plus the command to run
 * (if any). Tests hand it strings and assert on the writes.
 *
 * Model: cursor-at-end (no left/right movement — Backspace edits the tail).
 * While a command is in flight all input is buffered raw (type-ahead) and
 * replayed through the SAME key path after the output + next prompt land, so a
 * buffered Enter runs its line and a buffered Ctrl+C cancels it — exactly what
 * a line-buffered real terminal does. Ctrl+C cannot kill the running command
 * (RpcShellSession has no kill); it is buffered like any other key, not faked.
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
  /** The prompt currently on screen. Fresh prompts recompute via getPrompt()
   *  (cwd persists across commands — `cd` moves the next prompt); in-line
   *  redraws (history recall) reuse this stored copy. */
  private prompt = "";
  private busy = false;
  /** Raw input received while busy; replayed through process() on commandDone. */
  private typeAhead = "";
  private readonly history: string[] = [];
  private histIndex: number | null = null;

  constructor(
    private readonly getPrompt: () => string,
    /** Live terminal width (the component passes () => term.cols) — read at
     *  every wrap-sensitive operation so resizes are picked up. */
    private readonly getCols: () => number,
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
      if (ch === "\x1b") {
        const [consumed, w] = this.escape(input, i);
        i += consumed;
        write += w;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        i += 1;
        if (ch === "\r" && input[i] === "\n") i += 1; // pasted CRLF = one Enter
        const cmd = this.line.trim();
        this.line = "";
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
        // At the prompt boundary (empty line) there is nothing to erase.
        if (this.line.length === 0) continue;
        const before = this.screenLayout();
        // Pop one code point — a surrogate pair is a single on-screen char.
        const units =
          this.line.length >= 2 &&
          /[\uDC00-\uDFFF]/.test(this.line[this.line.length - 1]!) &&
          /[\uD800-\uDBFF]/.test(this.line[this.line.length - 2]!)
            ? 2
            : 1;
        const deleted = this.line.slice(-units);
        this.line = this.line.slice(0, -units);
        if (before.rows === 1 && before.col < this.getCols()) {
          // Whole prompt+line on one row, no deferred wrap: erase in place.
          write += "\b \b".repeat(WIDE.test(deleted) ? 2 : 1);
        } else {
          // Wrapped (or exactly-full) row: xterm's BS cannot cross a wrap
          // boundary, so erase every row and redraw the shortened line.
          write +=
            ERASE_ROW + ERASE_ROW_ABOVE.repeat(before.rows - 1) + this.prompt + this.line;
        }
        continue;
      }
      if (ch === "\x03") {
        // Ctrl+C on an idle line: cancel it — ^C, fresh prompt, line discarded.
        i += 1;
        this.line = "";
        this.histIndex = null;
        this.prompt = this.getPrompt();
        write += "^C\r\n" + this.prompt;
        continue;
      }
      if (ch < " ") {
        i += 1; // other control chars (Tab, Ctrl+…): no binding, ignore
        continue;
      }
      this.line += ch;
      write += ch; // local echo
      i += 1;
    }
    return { write, run: null };
  }

  /** Consume one escape sequence at input[i] → [chars consumed, write].
   *  Up/Down drive history; everything else (left/right/delete/…) is ignored
   *  under the cursor-at-end model. */
  private escape(input: string, i: number): [number, string] {
    if (input[i + 1] !== "[") return [2, ""]; // ESC + one char (alt-chords): ignore
    let j = i + 2;
    while (j < input.length && input[j]! >= "0" && input[j]! <= "?") j += 1; // CSI parameter bytes
    const seq = input.slice(i, j + 1); // includes the final byte (if present)
    const consumed = j + 1 - i;
    if (seq === "\x1b[A") return [consumed, this.historyMove(-1)];
    if (seq === "\x1b[B") return [consumed, this.historyMove(1)];
    return [consumed, ""];
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
   *  redraw it with `text` (which xterm re-wraps naturally). */
  private replaceLine(text: string): string {
    const erase = ERASE_ROW + ERASE_ROW_ABOVE.repeat(this.screenLayout().rows - 1);
    this.line = text;
    return erase + this.prompt + text;
  }
}
