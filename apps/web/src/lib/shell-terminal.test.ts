import { describe, it, expect } from "vitest";
import { ShellLineDiscipline, formatShellPrompt } from "./shell-terminal.js";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const ERASE_LINE = "\r\x1b[2K";
const ERASE_UP = "\x1b[A\x1b[2K"; // cursor-up + erase: one wrapped row above
const UP = "\x1b[A";
const DOWN = "\x1b[B";

const ok = { stdout: "", stderr: "", code: 0 };

/** Discipline over a mutable fake shell state — tests flip `cwd` the way a
 *  real `cd` would (the NEXT prompt picks it up) and `cols` the way a resize
 *  would (the next wrap-sensitive key picks it up). The prompt "ws / $ " is
 *  7 columns wide. */
function make(cols = 80): { d: ShellLineDiscipline; state: { cwd: string; cols: number } } {
  const state = { cwd: "/", cols };
  const d = new ShellLineDiscipline(
    () => `ws ${state.cwd} $ `,
    () => state.cols,
  );
  return { d, state };
}

describe("formatShellPrompt", () => {
  it("carries workspace, cwd, and $ with ANSI coloring", () => {
    const p = formatShellPrompt("erdou", "/src");
    expect(p).toBe(`\x1b[36merdou${RESET} \x1b[2m/src${RESET} \x1b[32m$${RESET} `);
  });
});

describe("start", () => {
  it("emits a bare prompt — the whole empty state", () => {
    const { d } = make();
    expect(d.start()).toBe("ws / $ ");
  });
});

describe("echo and backspace", () => {
  it("echoes printable input", () => {
    const { d } = make();
    d.start();
    expect(d.data("ls -la")).toEqual({ write: "ls -la", run: null });
  });

  it("backspace erases one echoed char", () => {
    const { d } = make();
    d.start();
    d.data("ab");
    expect(d.data("\x7f")).toEqual({ write: "\b \b", run: null });
  });

  it("backspace at the prompt boundary writes nothing (prompt survives)", () => {
    const { d } = make();
    d.start();
    expect(d.data("\x7f")).toEqual({ write: "", run: null });
    // and after erasing everything typed, further backspaces still stop:
    d.data("x");
    expect(d.data("\x7f\x7f\x7f").write).toBe("\b \b");
  });

  it("backspace edits the line the command actually runs", () => {
    const { d } = make();
    d.start();
    d.data("lsx");
    d.data("\x7f");
    expect(d.data("\r").run).toBe("ls");
  });
});

describe("Enter → run → output → fresh prompt", () => {
  it("submits the line and moves to the next row", () => {
    const { d } = make();
    d.start();
    d.data("pwd");
    expect(d.data("\r")).toEqual({ write: "\r\n", run: "pwd" });
  });

  it("prints stdout then a prompt with the updated cwd (cd persists)", () => {
    const { d, state } = make();
    d.start();
    d.data("cd /src\r");
    state.cwd = "/src"; // the shell's cwd moved while the command ran
    expect(d.commandDone(ok)).toEqual({ write: "ws /src $ ", run: null });
  });

  it("converts \\n to \\r\\n and guarantees a trailing newline before the prompt", () => {
    const { d } = make();
    d.start();
    d.data("ls\r");
    expect(d.commandDone({ stdout: "a\nb", stderr: "", code: 0 }).write).toBe(
      "a\r\nb\r\nws / $ ",
    );
  });

  it("prints stderr in red and a red exit line for code != 0", () => {
    const { d } = make();
    d.start();
    d.data("boom\r");
    expect(d.commandDone({ stdout: "", stderr: "no such cmd\n", code: 127 }).write).toBe(
      `${RED}no such cmd\r\n${RESET}${RED}exit 127${RESET}\r\nws / $ `,
    );
  });

  it("orders stdout before stderr", () => {
    const { d } = make();
    d.start();
    d.data("x\r");
    const w = d.commandDone({ stdout: "out\n", stderr: "err\n", code: 1 }).write;
    expect(w.indexOf("out")).toBeLessThan(w.indexOf("err"));
  });

  it("empty Enter just reprints the prompt", () => {
    const { d } = make();
    d.start();
    expect(d.data("\r")).toEqual({ write: "\r\nws / $ ", run: null });
  });

  it("whitespace-only Enter runs nothing", () => {
    const { d } = make();
    d.start();
    d.data("   ");
    expect(d.data("\r").run).toBeNull();
  });

  it("commandDone without a running command throws", () => {
    const { d } = make();
    d.start();
    expect(() => d.commandDone(ok)).toThrow(/without a running command/);
  });
});

describe("history", () => {
  function withHistory(): ShellLineDiscipline {
    const { d } = make();
    d.start();
    d.data("one\r");
    d.commandDone(ok);
    d.data("two\r");
    d.commandDone(ok);
    return d;
  }

  it("ArrowUp/ArrowDown round-trip: two → one → (clamp) one → two → cleared line", () => {
    const d = withHistory();
    expect(d.data(UP).write).toBe(`${ERASE_LINE}ws / $ two`);
    expect(d.data(UP).write).toBe(`${ERASE_LINE}ws / $ one`);
    expect(d.data(UP).write).toBe(`${ERASE_LINE}ws / $ one`); // clamped at oldest
    expect(d.data(DOWN).write).toBe(`${ERASE_LINE}ws / $ two`);
    expect(d.data(DOWN).write).toBe(`${ERASE_LINE}ws / $ `); // past newest → empty line
    expect(d.data(DOWN).write).toBe(""); // already off the end
  });

  it("Enter runs the recalled entry", () => {
    const d = withHistory();
    d.data(UP);
    expect(d.data("\r").run).toBe("two");
  });

  it("a recalled-then-edited line runs as edited", () => {
    const d = withHistory();
    d.data(UP); // "two"
    d.data("\x7f"); // "tw"
    d.data("o!"); // "two!"
    expect(d.data("\r").run).toBe("two!");
  });

  it("ArrowUp with no history writes nothing", () => {
    const { d } = make();
    d.start();
    expect(d.data(UP)).toEqual({ write: "", run: null });
  });

  it("unknown CSI sequences are swallowed, not echoed", () => {
    const { d } = make();
    d.start();
    expect(d.data("\x1b[3~")).toEqual({ write: "", run: null }); // Delete key
    expect(d.data("x").write).toBe("x"); // stream stays in sync
  });
});

describe("wrapped lines (cols-aware erase)", () => {
  // All widths below include the 7-column prompt "ws / $ ".

  it("history recall over a wrapped line erases every wrapped row", () => {
    const { d } = make(10);
    d.start();
    d.data("0123456789\r"); // 7 + 10 = 17 cols → 2 rows on screen
    d.commandDone(ok);
    d.data("ab\r");
    d.commandDone(ok);
    // Recalling onto short lines is still a one-row erase:
    expect(d.data(UP).write).toBe(`${ERASE_LINE}ws / $ ab`);
    expect(d.data(UP).write).toBe(`${ERASE_LINE}ws / $ 0123456789`);
    // Now the on-screen line spans 2 rows — Down must erase BOTH before redraw:
    expect(d.data(DOWN).write).toBe(`${ERASE_LINE}${ERASE_UP}ws / $ ab`);
  });

  it("ArrowDown past the newest entry clears a wrapped line fully", () => {
    const { d } = make(10);
    d.start();
    d.data("0123456789\r");
    d.commandDone(ok);
    d.data(UP); // recall the 2-row line
    expect(d.data(DOWN).write).toBe(`${ERASE_LINE}${ERASE_UP}ws / $ `);
  });

  it("backspace over a wrap boundary redraws all rows (BS cannot cross it)", () => {
    const { d } = make(10);
    d.start();
    d.data("abcd"); // 7 + 4 = 11 cols → 2 rows, cursor on row 2
    expect(d.data("\x7f").write).toBe(`${ERASE_LINE}${ERASE_UP}ws / $ abc`);
    expect(d.data("\r").run).toBe("abc"); // the model stayed in sync
  });

  it("backspace on an exactly-full row (xterm deferred wrap) redraws in place", () => {
    const { d } = make(10);
    d.start();
    d.data("abc"); // 7 + 3 = 10 cols: cursor is in deferred-wrap, \b unsafe
    expect(d.data("\x7f").write).toBe(`${ERASE_LINE}ws / $ ab`);
    expect(d.data("\r").run).toBe("ab");
  });

  it("a line one short of the width keeps the cheap in-place erase", () => {
    const { d } = make(10);
    d.start();
    d.data("ab"); // 9 of 10 cols: single row, no deferred wrap
    expect(d.data("\x7f")).toEqual({ write: "\b \b", run: null });
  });

  it("CJK chars count two columns; early wrap adds rows ceil(width/cols) misses", () => {
    const { d } = make(5);
    d.start();
    // Prompt alone wraps (7 of 5). Each 界 is 2 cells; at col 4 of a 5-col row
    // it wraps whole, leaving a blank cell — 4 rows total, though
    // ceil((7+8)/5) = 3. The erase must cover the real 4.
    d.data("界界界界");
    expect(d.data("\x7f").write).toBe(
      `${ERASE_LINE}${ERASE_UP}${ERASE_UP}${ERASE_UP}ws / $ 界界界`,
    );
  });

  it("backspacing a wide char on one row erases both cells", () => {
    const { d } = make();
    d.start();
    d.data("ls 二豆");
    expect(d.data("\x7f").write).toBe("\b \b\b \b");
    expect(d.data("\r").run).toBe("ls 二");
  });

  it("a surrogate-pair char is deleted whole, not split", () => {
    const { d } = make();
    d.start();
    d.data("a😀");
    expect(d.data("\x7f").write).toBe("\b \b"); // narrow under xterm's Unicode-6 widths
    expect(d.data("\r").run).toBe("a");
  });

  it("reads cols live — a resize changes the math on the next key", () => {
    const { d, state } = make(20);
    d.start();
    d.data("0123456789"); // 17 of 20 cols: one row
    state.cols = 10; // xterm reflows the line to 2 rows on resize
    expect(d.data("\x7f").write).toBe(`${ERASE_LINE}${ERASE_UP}ws / $ 012345678`);
  });
});

describe("type-ahead while busy", () => {
  it("buffers input silently, then echoes it after output + next prompt", () => {
    const { d } = make();
    d.start();
    d.data("slow\r");
    expect(d.data("echo hi")).toEqual({ write: "", run: null });
    const u = d.commandDone({ stdout: "done\n", stderr: "", code: 0 });
    expect(u).toEqual({ write: "done\r\nws / $ echo hi", run: null });
    expect(d.data("\r").run).toBe("echo hi"); // the typed-ahead line is live
  });

  it("a buffered Enter submits its line right after the prompt", () => {
    const { d } = make();
    d.start();
    d.data("slow\r");
    d.data("pwd\r");
    expect(d.commandDone(ok)).toEqual({ write: "ws / $ pwd\r\n", run: "pwd" });
  });

  it("input behind a buffered Enter stays buffered for the next command", () => {
    const { d } = make();
    d.start();
    d.data("slow\r");
    d.data("pwd\rnext");
    expect(d.commandDone(ok).run).toBe("pwd");
    // "next" was re-stashed; it echoes after pwd's output + prompt.
    expect(d.commandDone(ok)).toEqual({ write: "ws / $ next", run: null });
  });

  it("input typed behind Enter in a single chunk becomes type-ahead", () => {
    const { d } = make();
    d.start();
    expect(d.data("ls\recho hi")).toEqual({ write: "ls\r\n", run: "ls" });
    expect(d.commandDone(ok)).toEqual({ write: "ws / $ echo hi", run: null });
  });
});

describe("Ctrl+C", () => {
  it("on an idle line: prints ^C and a fresh prompt, discards the line", () => {
    const { d } = make();
    d.start();
    d.data("abc");
    expect(d.data("\x03")).toEqual({ write: "^C\r\nws / $ ", run: null });
    expect(d.data("\r").run).toBeNull(); // the line really is gone
  });

  it("while a command runs: no kill — it buffers like any key and cancels the type-ahead line", () => {
    const { d } = make();
    d.start();
    d.data("slow\r");
    expect(d.data("abc\x03")).toEqual({ write: "", run: null }); // nothing faked mid-run
    // Replay after completion: "abc" echoes, then ^C cancels it — a real
    // line-buffered terminal's behavior, minus the SIGINT we cannot send.
    expect(d.commandDone(ok)).toEqual({
      write: "ws / $ abc^C\r\nws / $ ",
      run: null,
    });
  });

  it("resets a history walk", () => {
    const { d } = make();
    d.start();
    d.data("one\r");
    d.commandDone(ok);
    d.data(UP); // recall "one"
    d.data("\x03");
    expect(d.data(DOWN)).toEqual({ write: "", run: null }); // walk abandoned
  });
});

describe("cursor movement and mid-line editing", () => {
  const LEFT = "\x1b[D";
  const RIGHT = "\x1b[C";
  const HOME = "\x1b[H";
  const END = "\x1b[F";
  const DEL = "\x1b[3~";

  it("Left moves the cursor and typing inserts mid-line (full-redraw strategy)", () => {
    const { d } = make();
    d.start();
    d.data("abc");
    // prompt "ws / $ " = 7 cols; cursor from col 10 to col 9
    expect(d.data(LEFT)).toEqual({ write: "\r\x1b[9C", run: null });
    // insert before "c": erase row, rewrite, park cursor after the X (col 10)
    expect(d.data("X").write).toBe(ERASE_LINE + "ws / $ " + "abXc" + "\r\x1b[10C");
    expect(d.data("\r")).toMatchObject({ run: "abXc" });
  });

  it("Backspace mid-line deletes BEFORE the cursor", () => {
    const { d } = make();
    d.start();
    d.data("abc");
    d.data(LEFT); // ab|c
    expect(d.data("\x7f").write).toBe(ERASE_LINE + "ws / $ " + "ac" + "\r\x1b[8C");
    expect(d.data("\r")).toMatchObject({ run: "ac" });
  });

  it("Delete removes the code point AT the cursor; Home jumps to column 0 of the line", () => {
    const { d } = make();
    d.start();
    d.data("abc");
    expect(d.data(HOME)).toEqual({ write: "\r\x1b[7C", run: null }); // |abc
    expect(d.data(DEL).write).toBe(ERASE_LINE + "ws / $ " + "bc" + "\r\x1b[7C");
    expect(d.data("\r")).toMatchObject({ run: "bc" });
  });

  it("Ctrl+A / Ctrl+E mirror Home / End; boundary arrows are no-ops", () => {
    const { d } = make();
    d.start();
    d.data("ab");
    expect(d.data("\x01")).toEqual({ write: "\r\x1b[7C", run: null }); // Ctrl+A
    expect(d.data(LEFT)).toEqual({ write: "", run: null }); // already at 0
    expect(d.data("\x05")).toEqual({ write: "\r\x1b[9C", run: null }); // Ctrl+E
    expect(d.data(RIGHT)).toEqual({ write: "", run: null }); // already at end
    expect(d.data(END)).toEqual({ write: "", run: null }); // End at end: no-op
  });

  it("mid-line edit on a WRAPPED line erases every row and repositions across the wrap", () => {
    const { d } = make(10); // prompt 7 + "abcdef" = 13 visible -> 2 rows
    d.start();
    d.data("abcdef");
    d.data(LEFT + LEFT + LEFT + LEFT); // ab|cdef
    const w = d.data("X").write; // -> abXcdef (14 visible, still 2 rows)
    // cursor sat on row 1 of 2: hop down, erase both rows, rewrite, park the
    // cursor at the row-2 start (offset 3 lands exactly on the wrap boundary)
    expect(w).toBe("\x1b[1B" + ERASE_LINE + ERASE_UP + "ws / $ " + "abXcdef" + "\r");
    // Enter from mid-line parks the cursor at the end first
    const enter = d.data("\r");
    expect(enter.run).toBe("abXcdef");
    expect(enter.write).toBe("\r\x1b[4C" + "\r\n");
  });

  it("End onto an exactly-full row restores xterm's deferred-wrap state by re-echoing the final char", () => {
    const { d } = make(10); // prompt 7 + "abc" = 10 visible: exactly full
    d.start();
    d.data("abc");
    expect(d.data(HOME)).toEqual({ write: "\r\x1b[7C", run: null });
    // CUF cannot reach the deferred position (it clamps at the last column):
    // land before "c" and re-echo it instead.
    expect(d.data(END)).toEqual({ write: "\r\x1b[9C" + "c", run: null });
  });

  it("history recall parks the cursor at the END of the recalled line", () => {
    const { d } = make();
    d.start();
    const r = d.data("echo hi\r");
    expect(r.run).toBe("echo hi");
    d.commandDone(ok);
    d.data("ab");
    d.data(LEFT); // a|b
    d.data(UP); // recall "echo hi", cursor at end
    expect(d.data("!").write).toBe("!"); // plain append echo = cursor is at end
  });

  it("arrows buffered as type-ahead during a command replay as real edits", () => {
    const { d } = make();
    d.start();
    expect(d.data("ls\r").run).toBe("ls");
    d.data("ab" + LEFT + "X"); // buffered while busy
    d.commandDone(ok); // replay: type ab, Left, insert X -> aXb
    expect(d.data("\r")).toMatchObject({ run: "aXb" });
  });
});
