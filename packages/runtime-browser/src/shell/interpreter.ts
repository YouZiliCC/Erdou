import { ErrnoError } from "@erdou/runtime-contract";
import type { Signal } from "@erdou/runtime-contract";
import { parse } from "./parser.js";
import { expandWord } from "./expand.js";
import type { Command, Pipeline } from "./ast.js";
import { PipeStream } from "../core/byte-stream.js";
import { join, normalize } from "../vfs/path.js";
import type { Vfs } from "../vfs/vfs.js";
import type { ProcessTable, InternalSpawnOptions, ProcessRecord } from "../process/process-table.js";

const resolveAbs = (cwd: string, p: string): string =>
  p.startsWith("/") ? normalize(p) : join(cwd, p);

interface ExpandedRedirect {
  fd: 0 | 1 | 2;
  op: ">" | ">>" | "<";
  file: string;
}
interface ExpandedCommand {
  argv: string[];
  redirects: ExpandedRedirect[];
}

export interface ShellResult {
  stdout: PipeStream;
  stderr: PipeStream;
  wait(): Promise<number>;
  /** Kill every process this execution spawned. */
  kill(signal?: Signal): void;
}

export interface ShellDeps {
  table: ProcessTable;
  vfs: Vfs;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * The shell interpreter: parses a command line and runs it against the process
 * table, wiring pipelines, redirections and `&&`/`||`/`;` control flow. `cd`
 * and `export` are handled in-process because they mutate the shell's own cwd
 * and environment, which persist across `execute` calls on the same instance.
 */
export class Shell {
  cwd: string;
  env: Record<string, string>;
  private readonly table: ProcessTable;
  private readonly vfs: Vfs;

  constructor(deps: ShellDeps) {
    this.table = deps.table;
    this.vfs = deps.vfs;
    this.cwd = deps.cwd ?? "/";
    this.env = deps.env ?? {};
  }

  execute(src: string): ShellResult {
    const stdout = new PipeStream();
    const stderr = new PipeStream();
    const records: ProcessRecord[] = [];
    const wait = (async (): Promise<number> => {
      try {
        return await this.process(src, stdout, stderr, records);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!stderr.isClosed) stderr.write(msg + "\n");
        return 2;
      } finally {
        if (!stdout.isClosed) stdout.end();
        if (!stderr.isClosed) stderr.end();
      }
    })();
    return {
      stdout,
      stderr,
      wait: () => wait,
      kill: (signal?: Signal) => {
        for (const r of records) if (r.state === "running") r.kill(signal);
      },
    };
  }

  run(src: string): Promise<number> {
    return this.execute(src).wait();
  }

  private async process(
    src: string,
    stdout: PipeStream,
    stderr: PipeStream,
    records: ProcessRecord[],
  ): Promise<number> {
    const list = parse(src);
    let code = 0;
    for (const item of list.items) {
      const shouldRun =
        item.op === null || item.op === ";"
          ? true
          : item.op === "&&"
            ? code === 0
            : code !== 0; // "||"
      if (!shouldRun) continue;
      // `&` is parsed but runs in the foreground this round — true background
      // detachment is deferred. Running sequentially keeps output capture and
      // &&/||/; sequencing correct instead of racing stream teardown.
      code = await this.execPipeline(item.pipeline, stdout, stderr, records);
    }
    return code;
  }

  private async execPipeline(
    pipeline: Pipeline,
    shellStdout: PipeStream,
    shellStderr: PipeStream,
    records: ProcessRecord[],
  ): Promise<number> {
    const specs = pipeline.commands.map((c) => this.expandCommand(c));

    if (specs.length === 1) {
      const argv = specs[0]!.argv;
      if (argv[0] === "cd") return this.builtinCd(argv, shellStderr);
      if (argv[0] === "export") return this.builtinExport(argv);
    }

    const firstInput = specs[0]!.redirects.find((r) => r.op === "<");
    const firstStdin = firstInput ? this.vfs.readFile(firstInput.file) : undefined;

    const stages = this.table.spawnPiped(
      specs.map((s, idx): InternalSpawnOptions => ({
        cmd: s.argv[0] ?? "",
        args: s.argv.slice(1),
        cwd: this.cwd,
        env: this.env,
        ...(idx === 0 && firstStdin !== undefined ? { stdin: firstStdin } : {}),
      })),
    );
    records.push(...stages);

    const drains: Promise<void>[] = [];
    for (let idx = 0; idx < stages.length; idx++) {
      const stage = stages[idx]!;
      const redirects = specs[idx]!.redirects;
      const isLast = idx === stages.length - 1;
      const out = redirects.find((r) => r.fd === 1 && (r.op === ">" || r.op === ">>"));
      const err = redirects.find((r) => r.fd === 2 && (r.op === ">" || r.op === ">>"));
      if (out) drains.push(this.drainToFile(stage.stdout, out.file, out.op === ">>"));
      else if (isLast) drains.push(this.drainToStream(stage.stdout, shellStdout));
      if (err) drains.push(this.drainToFile(stage.stderr, err.file, err.op === ">>"));
      else drains.push(this.drainToStream(stage.stderr, shellStderr));
    }

    const status = await stages[stages.length - 1]!.wait();
    await Promise.all(drains);
    return status.code;
  }

  private expandCommand(command: Command): ExpandedCommand {
    const argv = command.words.flatMap((w) => expandWord(w, this.env, this.vfs, this.cwd));
    const redirects: ExpandedRedirect[] = command.redirects.map((r) => {
      const targets = expandWord(r.target, this.env, this.vfs, this.cwd);
      if (targets.length !== 1) {
        throw new ErrnoError("EINVAL", { syscall: "redirect", path: "ambiguous redirect" });
      }
      return { fd: r.fd, op: r.op, file: resolveAbs(this.cwd, targets[0]!) };
    });
    return { argv, redirects };
  }

  private async drainToFile(stream: PipeStream, file: string, append: boolean): Promise<void> {
    const parts: Uint8Array[] = [];
    for await (const chunk of stream.read()) parts.push(chunk);
    const total = parts.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of parts) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (append) this.vfs.appendFile(file, bytes);
    else this.vfs.writeFile(file, bytes);
  }

  private async drainToStream(src: PipeStream, dst: PipeStream): Promise<void> {
    for await (const chunk of src.read()) {
      if (!dst.isClosed) dst.write(chunk);
    }
  }

  private builtinCd(argv: string[], stderr: PipeStream): number {
    const dir = argv[1] ?? this.env["HOME"] ?? "/";
    const target = resolveAbs(this.cwd, dir);
    try {
      if (this.vfs.stat(target).type !== "directory") {
        stderr.write(`cd: not a directory: ${dir}\n`);
        return 1;
      }
    } catch (err) {
      stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
      return 1;
    }
    this.cwd = target;
    return 0;
  }

  private builtinExport(argv: string[]): number {
    for (const assignment of argv.slice(1)) {
      const eq = assignment.indexOf("=");
      if (eq > 0) this.env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    }
    return 0;
  }
}
