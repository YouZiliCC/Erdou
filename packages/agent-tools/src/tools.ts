import type { ToolContext, ToolDef, ToolResult } from "./types.js";

const decoder = new TextDecoder();
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const pathParam = {
  type: "object",
  properties: { path: { type: "string", description: "Absolute path (starts with /)." } },
  required: ["path"],
} as const;

const readFile: ToolDef = {
  name: "read_file",
  description: "Read a text file from the filesystem and return its contents.",
  parameters: pathParam,
  async execute(ctx, args): Promise<ToolResult> {
    if (typeof args.path !== "string") return { ok: false, output: "'path' must be a string" };
    try {
      return { ok: true, output: decoder.decode(await ctx.runtime.readFile(args.path)) };
    } catch (err) {
      return { ok: false, output: message(err) };
    }
  },
};

const writeFile: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a text file. The parent directory must already exist (call make_dir first if needed).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    if (typeof args.path !== "string" || typeof args.content !== "string") {
      return { ok: false, output: "'path' and 'content' must be strings" };
    }
    try {
      await ctx.runtime.writeFile(args.path, args.content);
      return { ok: true, output: `wrote ${args.content.length} bytes to ${args.path}` };
    } catch (err) {
      return { ok: false, output: message(err) };
    }
  },
};

const listDir: ToolDef = {
  name: "list_dir",
  description: "List the entries of a directory (one per line; 'd' prefix = directory).",
  parameters: pathParam,
  async execute(ctx, args): Promise<ToolResult> {
    if (typeof args.path !== "string") return { ok: false, output: "'path' must be a string" };
    try {
      const entries = await ctx.runtime.readdir(args.path);
      const lines = entries.map((e) => `${e.type === "directory" ? "d" : "-"} ${e.name}`);
      return { ok: true, output: lines.join("\n") || "(empty directory)" };
    } catch (err) {
      return { ok: false, output: message(err) };
    }
  },
};

const makeDir: ToolDef = {
  name: "make_dir",
  description: "Create a directory (and any missing parents).",
  parameters: pathParam,
  async execute(ctx, args): Promise<ToolResult> {
    if (typeof args.path !== "string") return { ok: false, output: "'path' must be a string" };
    try {
      await ctx.runtime.mkdir(args.path, { recursive: true });
      return { ok: true, output: `created directory ${args.path}` };
    } catch (err) {
      return { ok: false, output: message(err) };
    }
  },
};

const removePath: ToolDef = {
  name: "remove_path",
  description: "Delete a file or directory (recursively).",
  parameters: pathParam,
  async execute(ctx, args): Promise<ToolResult> {
    if (typeof args.path !== "string") return { ok: false, output: "'path' must be a string" };
    try {
      await ctx.runtime.rm(args.path, { recursive: true, force: true });
      return { ok: true, output: `removed ${args.path}` };
    } catch (err) {
      return { ok: false, output: message(err) };
    }
  },
};

const runShell: ToolDef = {
  name: "run_shell",
  description:
    "Run a shell command line (supports pipes, redirection, && and $VARS). Returns stdout, stderr and the exit code. The commands available in this environment are listed in your environment brief.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The command line to run." } },
    required: ["command"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    if (typeof args.command !== "string") return { ok: false, output: "'command' must be a string" };
    try {
      const proc = await ctx.runtime.exec(args.command);
      const [status, stdout, stderr] = await Promise.all([
        proc.wait(),
        proc.stdout.text(),
        proc.stderr.text(),
      ]);
      const parts: string[] = [];
      if (stdout.length > 0) parts.push(stdout.trimEnd());
      if (stderr.length > 0) parts.push(`[stderr] ${stderr.trimEnd()}`);
      parts.push(`[exit ${status.code}]`);
      return { ok: status.code === 0, output: parts.join("\n") };
    } catch (err) {
      return { ok: false, output: message(err) };
    }
  },
};

/** The default coding-agent toolset. */
export function createTools(): ToolDef[] {
  return [readFile, writeFile, listDir, makeDir, removePath, runShell];
}
