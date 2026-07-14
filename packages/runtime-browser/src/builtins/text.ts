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

export const grep: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  let ignoreCase = false;
  let lineNumbers = false;
  let invert = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a.length > 1 && a.startsWith("-")) {
      for (const ch of a.slice(1)) {
        if (ch === "i") ignoreCase = true;
        else if (ch === "n") lineNumbers = true;
        else if (ch === "v") invert = true;
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
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const files = rest.slice(1);
  let anyMatch = false;
  let errored = false;

  const scan = (text: string, prefix: string): void => {
    const lines = text.split("\n");
    const trailing = text.endsWith("\n");
    const count = text === "" ? 0 : trailing ? lines.length - 1 : lines.length;
    for (let idx = 0; idx < count; idx++) {
      const line = lines[idx]!;
      const hay = ignoreCase ? line.toLowerCase() : line;
      if (hay.includes(needle) !== invert) {
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

function makeHeadTail(fromEnd: boolean): Program {
  return async (ctx) => {
    const args = ctx.argv.slice(1);
    let n = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-n") n = parseInt(args[++i] ?? "10", 10);
      else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
      else files.push(a);
    }
    try {
      const text = files.length > 0 ? decode(ctx.fs.readFile(abs(ctx.cwd, files[0]!))) : await readAllText(ctx.stdin);
      ctx.stdout.write(takeLines(text, n, fromEnd));
      return 0;
    } catch (err) {
      ctx.stderr.write(describeError(err) + "\n");
      return 1;
    }
  };
}

export const head = makeHeadTail(false);
export const tail = makeHeadTail(true);
