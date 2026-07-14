import type { Program } from "../process/program.js";
import { globToRegExp } from "../shell/glob.js";
import { basename } from "../vfs/path.js";
import { abs, describeError, joinPath, shortFlags } from "./util.js";

export const ls: Program = async (ctx) => {
  const { flags, positional } = shortFlags(ctx.argv.slice(1));
  const showAll = flags.has("a");
  const long = flags.has("l");
  const target = abs(ctx.cwd, positional[0] ?? ".");
  try {
    if (ctx.fs.stat(target).type !== "directory") {
      ctx.stdout.write((positional[0] ?? target) + "\n");
      return 0;
    }
    const entries = ctx.fs
      .readdir(target)
      .filter((e) => showAll || !e.name.startsWith("."));
    for (const entry of entries) {
      if (long) {
        const st = ctx.fs.lstat(joinPath(target, entry.name));
        const t = entry.type === "directory" ? "d" : entry.type === "symlink" ? "l" : "-";
        ctx.stdout.write(`${t} ${st.mode.toString(8)} ${st.size} ${entry.name}\n`);
      } else {
        ctx.stdout.write(entry.name + "\n");
      }
    }
    return 0;
  } catch (err) {
    ctx.stderr.write(describeError(err) + "\n");
    return 1;
  }
};

export const cat: Program = async (ctx) => {
  const paths = ctx.argv.slice(1);
  if (paths.length === 0) {
    for await (const chunk of ctx.stdin.read()) ctx.stdout.write(chunk);
    return 0;
  }
  let code = 0;
  for (const p of paths) {
    try {
      ctx.stdout.write(ctx.fs.readFile(abs(ctx.cwd, p)));
    } catch (err) {
      ctx.stderr.write(describeError(err) + "\n");
      code = 1;
    }
  }
  return code;
};

export const mkdir: Program = async (ctx) => {
  const { flags, positional } = shortFlags(ctx.argv.slice(1));
  const recursive = flags.has("p");
  let code = 0;
  for (const p of positional) {
    try {
      ctx.fs.mkdir(abs(ctx.cwd, p), { recursive });
    } catch (err) {
      ctx.stderr.write(describeError(err) + "\n");
      code = 1;
    }
  }
  return code;
};

export const rm: Program = async (ctx) => {
  const { flags, positional } = shortFlags(ctx.argv.slice(1));
  const recursive = flags.has("r");
  const force = flags.has("f");
  let code = 0;
  for (const p of positional) {
    try {
      ctx.fs.rm(abs(ctx.cwd, p), { recursive, force });
    } catch (err) {
      ctx.stderr.write(describeError(err) + "\n");
      code = 1;
    }
  }
  return code;
};

export const cp: Program = async (ctx) => {
  const { flags, positional } = shortFlags(ctx.argv.slice(1));
  const recursive = flags.has("r");
  const [src, dst] = positional;
  if (src === undefined || dst === undefined) {
    ctx.stderr.write("cp: missing file operand\n");
    return 1;
  }
  const from = abs(ctx.cwd, src);
  try {
    if (ctx.fs.stat(from).type === "directory" && !recursive) {
      ctx.stderr.write(`cp: -r not specified; omitting directory '${src}'\n`);
      return 1;
    }
    ctx.fs.copy(from, abs(ctx.cwd, dst));
    return 0;
  } catch (err) {
    ctx.stderr.write(describeError(err) + "\n");
    return 1;
  }
};

export const mv: Program = async (ctx) => {
  const [src, dst] = ctx.argv.slice(1);
  if (src === undefined || dst === undefined) {
    ctx.stderr.write("mv: missing file operand\n");
    return 1;
  }
  try {
    ctx.fs.rename(abs(ctx.cwd, src), abs(ctx.cwd, dst));
    return 0;
  } catch (err) {
    ctx.stderr.write(describeError(err) + "\n");
    return 1;
  }
};

export const touch: Program = async (ctx) => {
  let code = 0;
  for (const p of ctx.argv.slice(1)) {
    const path = abs(ctx.cwd, p);
    try {
      if (!ctx.fs.exists(path)) ctx.fs.writeFile(path, new Uint8Array(0));
    } catch (err) {
      ctx.stderr.write(describeError(err) + "\n");
      code = 1;
    }
  }
  return code;
};

export const find: Program = async (ctx) => {
  const args = ctx.argv.slice(1);
  let dir = ".";
  let namePattern: string | null = null;
  let typeFilter: "f" | "d" | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-name") namePattern = args[++i] ?? "";
    else if (a === "-type") typeFilter = args[++i] === "d" ? "d" : "f";
    else if (!a.startsWith("-")) dir = a;
  }
  const base = abs(ctx.cwd, dir);
  try {
    ctx.fs.stat(base);
  } catch (err) {
    ctx.stderr.write(describeError(err) + "\n");
    return 1;
  }
  const re = namePattern !== null ? globToRegExp(namePattern) : null;
  const results: string[] = [];
  const walk = (path: string): void => {
    const st = ctx.fs.lstat(path);
    const typeOk = !typeFilter || (typeFilter === "d" ? st.type === "directory" : st.type === "file");
    const nameOk = !re || re.test(basename(path));
    if (typeOk && nameOk) results.push(path);
    if (st.type === "directory") {
      for (const entry of ctx.fs.readdir(path)) walk(joinPath(path, entry.name));
    }
  };
  walk(base);
  for (const r of results) ctx.stdout.write(r + "\n");
  return 0;
};
