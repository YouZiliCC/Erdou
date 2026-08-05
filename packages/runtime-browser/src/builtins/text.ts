import type { Program } from "../process/program.js";
import { abs, decode, describeError, readAllText } from "./util.js";

export const echo: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  const noNewline = args[0] === "-n";
  const body = (noNewline ? args.slice(1) : args).join(" ");
  ctx.stdout.write(body + (noNewline ? "" : "\n"));
  return 0;
};

export const pwd: Program = async (ctx) => {
  ctx.stdout.write(ctx.cwd + "\n");
  return 0;
};

export const trueCmd: Program = async () => 0;
export const falseCmd: Program = async () => 1;

export const env: Program = async (ctx) => {
  for (const [k, v] of Object.entries(ctx.env)) ctx.stdout.write(`${k}=${v}\n`);
  return 0;
};

/**
 * `grep` — an honest busybox-style SUBSET for the browser kernel:
 *
 *   grep [-i] [-n] [-v] PATTERN [FILE...]
 *
 * PATTERN is a JavaScript RegExp, NOT a literal substring — close enough to
 * ERE for the agent's use (`^ $ . | () [] + ? {}` all work unescaped, so a
 * `-E`-style pattern needs no flag). It is deliberately never degraded to a
 * substring search: the agent reads exit 1 as "the string is absent from the
 * codebase", so a silently-mangled `^foo` would be read as a fact about the
 * files. An uncompilable PATTERN, and any flag outside -i/-n/-v, therefore
 * fail loudly instead. Exit: 0 = matched, 1 = no match, 2 = usage/system error
 * (unsupported option, bad pattern, unreadable FILE). A usage error must NOT
 * exit 1: `grep -r foo .` in an `if`/`||` chain would then be indistinguishable
 * from a clean no-match, which is exactly the misreading this rejection exists
 * to prevent. (sed and awk exit 1 on a usage error; they have no "no match"
 * status for it to collide with, so grep diverges from them here on purpose.)
 */
export const grep: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  let ignoreCase = false;
  let lineNumbers = false;
  let invert = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // POSIX end-of-options, as in sed/awk. It is the only way to grep a pattern
    // that starts with a dash; without this case the flag loop below walks the
    // characters of "--" and rejects it as unsupported option '--'.
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.length > 1 && a.startsWith("-")) {
      for (const ch of a.slice(1)) {
        if (ch === "i") ignoreCase = true;
        else if (ch === "n") lineNumbers = true;
        else if (ch === "v") invert = true;
        else {
          ctx.stderr.write(`grep: unsupported option '-${ch}' (supported: -i, -n, -v)\n`);
          return 2;
        }
      }
    } else {
      rest.push(a);
    }
  }
  const pattern = rest[0];
  if (pattern === undefined) {
    ctx.stderr.write("grep: missing pattern\n");
    return 2;
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (err) {
    ctx.stderr.write(`grep: invalid pattern '${pattern}': ${describeError(err)}\n`);
    return 2;
  }
  const files = rest.slice(1);
  let anyMatch = false;
  let errored = false;

  const scan = (text: string, prefix: string): void => {
    const lines = text.split("\n");
    const trailing = text.endsWith("\n");
    const count = text === "" ? 0 : trailing ? lines.length - 1 : lines.length;
    for (let idx = 0; idx < count; idx++) {
      const line = lines[idx]!;
      if (re.test(line) !== invert) {
        anyMatch = true;
        const label = (prefix ? `${prefix}:` : "") + (lineNumbers ? `${idx + 1}:` : "");
        ctx.stdout.write(label + line + "\n");
      }
    }
  };

  if (files.length === 0) {
    scan(await readAllText(ctx.stdin), "");
  } else {
    for (const f of files) {
      try {
        scan(decode(ctx.fs.readFile(abs(ctx.cwd, f))), files.length > 1 ? f : "");
      } catch (err) {
        ctx.stderr.write(describeError(err) + "\n");
        errored = true;
      }
    }
  }
  if (errored) return 2;
  return anyMatch ? 0 : 1;
};

function takeLines(text: string, n: number, fromEnd: boolean): string {
  const all = text.split("\n");
  const lines = text.endsWith("\n") ? all.slice(0, -1) : all;
  // slice(-0) === slice(0) returns everything, so guard n <= 0 for the tail case.
  const picked = fromEnd ? (n <= 0 ? [] : lines.slice(-n)) : lines.slice(0, Math.max(0, n));
  return picked.map((l) => l + "\n").join("");
}

function makeHeadTail(name: string, fromEnd: boolean): Program {
  return async (ctx) => {
    const args = ctx.argv.slice(1);
    let n = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-n") {
        const v = args[++i];
        // parseInt would turn a missing or garbled count into NaN, which
        // takeLines reads as "nothing" (head) or "everything" (tail) — a
        // silent degradation, so reject anything but a plain integer.
        if (v === undefined || !/^\d+$/.test(v)) {
          ctx.stderr.write(`${name}: invalid line count '${v ?? ""}' (usage: ${name} [-n N] [FILE...])\n`);
          return 2;
        }
        n = parseInt(v, 10);
      } else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
      else files.push(a);
    }
    if (files.length === 0) {
      ctx.stdout.write(takeLines(await readAllText(ctx.stdin), n, fromEnd));
      return 0;
    }
    let code = 0;
    let headed = false;
    for (const f of files) {
      let text: string;
      try {
        text = decode(ctx.fs.readFile(abs(ctx.cwd, f)));
      } catch (err) {
        ctx.stderr.write(describeError(err) + "\n");
        code = 1;
        continue;
      }
      // coreutils separator: header per operand only when there are several,
      // with a blank line before every header except the first emitted one.
      if (files.length > 1) ctx.stdout.write((headed ? "\n" : "") + `==> ${f} <==\n`);
      headed = true;
      ctx.stdout.write(takeLines(text, n, fromEnd));
    }
    return code;
  };
}

export const head = makeHeadTail("head", false);
export const tail = makeHeadTail("tail", true);
