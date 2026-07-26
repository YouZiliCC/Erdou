import { ErrnoError } from "@erdou/runtime-contract";
import type { Signal } from "@erdou/runtime-contract";
import { parse } from "./parser.js";
import { expandWord } from "./expand.js";
import type { Command, List, ListItem, Pipeline } from "./ast.js";
import { PipeStream } from "../core/byte-stream.js";
import { join, normalize } from "../vfs/path.js";
import type { Vfs } from "../vfs/vfs.js";
import type { ProcessTable, InternalSpawnOptions, ProcessRecord } from "../process/process-table.js";
import { pipeProcesses } from "../process/pipe.js";

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

/** A background job launched by a trailing `&`. `record` is the job's adopted
 *  process-table entry: its pid is what `[pid] cmd` announced, killing it kills
 *  the job's stages, and its stdout/stderr streams hold the buffered output. */
interface BackgroundJob {
  pid: number;
  command: string;
  record: ProcessRecord;
}

/** The `$?` of one execution context. Foreground lines share the shell's cell,
 *  so `$?` survives across `execute` calls the way a session expects; a `&` job
 *  runs against its own, because bash leaves the launching shell's `$?` at the
 *  status of the `&` (0) no matter what the detached job later exits with. */
interface StatusCell {
  last: number;
}

/**
 * The shell interpreter: parses a command line and runs it against the process
 * table, wiring pipelines, redirections and `&&`/`||`/`;` control flow. `cd`,
 * `export` and `jobs` are handled in-process because they touch the shell's
 * own cwd/environment/job-list, which persist across `execute` calls on the
 * same instance. A trailing `&` detaches the whole line as a background job
 * (see {@link Shell.launchBackground}).
 */
export class Shell {
  cwd: string;
  env: Record<string, string>;
  private readonly table: ProcessTable;
  private readonly vfs: Vfs;
  /** This shell's background jobs, oldest first. Finished jobs stay here until
   *  `jobs` has reported them done once, then they are dropped. */
  private readonly jobs: BackgroundJob[] = [];
  /** Exit status of the last foreground command — what `$?` expands to. */
  private readonly status: StatusCell = { last: 0 };

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
    let canceled = false;
    const wait = (async (): Promise<number> => {
      try {
        return await this.process(src, stdout, stderr, records, () => canceled);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!stderr.isClosed) stderr.write(msg + "\n");
        // A parse/redirect failure is still a completed foreground command, so
        // `$?` must report it rather than keep the previous line's status.
        this.status.last = 2;
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
        canceled = true; // also stop launching the list's not-yet-started items
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
    canceled: () => boolean,
  ): Promise<number> {
    const list = parse(src);
    // A trailing `&` backgrounds the whole list: announce "[pid] cmd" on the
    // shell's stdout and return immediately; the job runs detached under an
    // adopted pid (it is NOT in `records`, so killing this foreground result
    // does not touch it — `&` means detach).
    if (list.background) return this.launchBackground(src, list, stdout);
    return this.runList(list.items, stdout, stderr, records, canceled, this.status);
  }

  /** Run list items sequentially with &&/||/; semantics. `canceled` is checked
   *  before each item so a kill also stops the items not yet started. `status`
   *  is both the source of `$?` for the next item and where each item's exit
   *  status lands; a skipped item leaves it alone, as in bash. */
  private async runList(
    items: ListItem[],
    stdout: PipeStream,
    stderr: PipeStream,
    records: ProcessRecord[],
    canceled: () => boolean,
    status: StatusCell,
  ): Promise<number> {
    let code = 0; // a list whose items all get skipped/canceled reports success
    for (const item of items) {
      if (canceled()) break;
      const shouldRun =
        item.op === null || item.op === ";"
          ? true
          : item.op === "&&"
            ? code === 0
            : code !== 0; // "||"
      if (!shouldRun) continue;
      code = await this.execPipeline(item.pipeline, stdout, stderr, records, status.last);
      status.last = code;
    }
    return code;
  }

  /**
   * Launch `list` as a detached background job: adopt a real pid for the
   * composite (so it shows up in `ps` and `kill <pid>` kills the whole job),
   * buffer its stdout/stderr on that process-table entry, register it in this
   * shell's job list, and announce "[pid] command" on the shell's stdout.
   * Returns 0 immediately — the caller does not await the job. The first
   * pipeline spawns synchronously here, so the job sees the cwd/env as of the
   * `&` line. The shell has no async output channel (sessions are command-at-
   * a-time), so the buffered output surfaces only when `jobs` reports the job
   * done — never interleaved into a later prompt.
   */
  private launchBackground(src: string, list: List, shellStdout: PipeStream): number {
    // parse() only accepts `&` as the line's final token, so the trimmed
    // source is guaranteed to end with it — strip it for display.
    const command = src.trimEnd().replace(/&$/, "").trim();
    const jobStdout = new PipeStream();
    const jobStderr = new PipeStream();
    const records: ProcessRecord[] = [];
    let canceled = false;
    const adopted = this.table.adopt({
      cmd: command,
      cwd: this.cwd,
      env: this.env,
      stdout: jobStdout,
      stderr: jobStderr,
    });
    adopted.onKill((signal) => {
      canceled = true;
      for (const r of records) if (r.state === "running") r.kill(signal);
    });
    this.jobs.push({ pid: adopted.record.pid, command, record: adopted.record });
    shellStdout.write(`[${adopted.record.pid}] ${command}\n`);
    void (async (): Promise<void> => {
      let code: number;
      try {
        // Its own status cell: the job's exit status is not this shell's `$?`.
        code = await this.runList(list.items, jobStdout, jobStderr, records, () => canceled, {
          last: 0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!jobStderr.isClosed) jobStderr.write(msg + "\n");
        code = 2;
      } finally {
        // End the buffers before settling the record, so a normally-exited job
        // is fully readable the moment it reads as done. (A killed job settles
        // first via the table; the runner unwinds and ends them within
        // microtasks, and `jobs` awaits the streams, tolerating that gap.)
        if (!jobStdout.isClosed) jobStdout.end();
        if (!jobStderr.isClosed) jobStderr.end();
      }
      adopted.exited(code);
    })();
    return 0;
  }

  /**
   * `jobs` — session-scoped job report. Running jobs print as
   * "[pid] running  <command>"; finished (exited or killed) jobs print once as
   * "[pid] done (<exit code>)  <command>" followed by their buffered
   * stdout/stderr — this is the one sanctioned place a background job's output
   * surfaces (the command-at-a-time shell cannot interleave it asynchronously)
   * — and are then dropped from the list.
   */
  private async builtinJobs(
    argv: string[],
    stdout: PipeStream,
    stderr: PipeStream,
  ): Promise<number> {
    if (argv.length > 1) {
      stderr.write(`jobs: takes no arguments (got: ${argv.slice(1).join(" ")})\n`);
      return 2;
    }
    const reported: BackgroundJob[] = [];
    for (const job of [...this.jobs]) {
      if (job.record.state === "running") {
        stdout.write(`[${job.pid}] running  ${job.command}\n`);
      } else {
        stdout.write(`[${job.pid}] done (${job.record.exitCode})  ${job.command}\n`);
        const [out, err] = await Promise.all([job.record.stdout.text(), job.record.stderr.text()]);
        if (out.length > 0) stdout.write(out);
        if (err.length > 0) stderr.write(err);
        reported.push(job);
      }
    }
    for (const job of reported) {
      const idx = this.jobs.indexOf(job);
      if (idx !== -1) this.jobs.splice(idx, 1);
    }
    return 0;
  }

  private async execPipeline(
    pipeline: Pipeline,
    shellStdout: PipeStream,
    shellStderr: PipeStream,
    records: ProcessRecord[],
    lastStatus: number,
  ): Promise<number> {
    const specs = pipeline.commands.map((c) => this.expandCommand(c, lastStatus));

    if (specs.length === 1) {
      const argv = specs[0]!.argv;
      if (argv[0] === "cd") return this.builtinCd(argv, shellStderr);
      if (argv[0] === "export") return this.builtinExport(argv);
      if (argv[0] === "jobs") return this.builtinJobs(argv, shellStdout, shellStderr);
    }

    // Only the first stage's stdin is ours to set — every later stage's stdin is
    // the pipe. Honouring `<` there means dropping that pipe (POSIX: the
    // redirect wins), which the wiring below cannot express; reading only
    // specs[0] instead made `a | b < f` quietly feed b with a's output.
    const lateInput = specs.findIndex((s, idx) => idx > 0 && s.redirects.some((r) => r.op === "<"));
    if (lateInput !== -1) {
      const cmd = specs[lateInput]!.argv[0] ?? "";
      throw new ErrnoError("EINVAL", {
        syscall: "redirect",
        path: `stdin redirect on pipeline stage ${lateInput + 1} (${cmd}) is not supported`,
      });
    }

    const firstInput = specs[0]!.redirects.find((r) => r.op === "<");
    const firstStdin = firstInput ? this.vfs.readFile(firstInput.file) : undefined;
    const outRedirects = specs.map((s) =>
      s.redirects.find((r) => r.fd === 1 && (r.op === ">" || r.op === ">>")),
    );

    // Spawned here rather than via table.spawnPiped so that a stage whose
    // stdout is redirected is NOT also piped onward. A PipeStream is
    // single-consumer (read() shifts chunks off one shared array), so leaving
    // both pipeProcesses and drainToFile reading it round-robins the output
    // between the file and the next stage. POSIX gives the redirect the
    // stdout and the next stage an empty stdin — which is exactly what
    // spawning that stage without `pipeStdin` produces.
    const stages: ProcessRecord[] = [];
    try {
      for (let idx = 0; idx < specs.length; idx++) {
        const spec = specs[idx]!;
        const upstream =
          idx > 0 && outRedirects[idx - 1] === undefined ? stages[idx - 1] : undefined;
        const opts: InternalSpawnOptions = {
          cmd: spec.argv[0] ?? "",
          args: spec.argv.slice(1),
          cwd: this.cwd,
          env: this.env,
          ...(idx === 0 && firstStdin !== undefined ? { stdin: firstStdin } : {}),
          ...(upstream ? { pipeStdin: true } : {}),
        };
        const record = this.table.spawn(opts);
        // Record before wiring: a later stage failing to spawn (ENOENT) must
        // still leave the ones already running killable through the caller's
        // ShellResult, not orphaned in the process table forever.
        stages.push(record);
        records.push(record);
        if (upstream) pipeProcesses(upstream, record);
      }
    } catch (err) {
      // The pipeline will never run, so tear down the stages that did start
      // instead of leaking them.
      for (const r of stages) if (r.state === "running") r.kill();
      throw err;
    }

    const drains: Promise<void>[] = [];
    for (let idx = 0; idx < stages.length; idx++) {
      const stage = stages[idx]!;
      const isLast = idx === stages.length - 1;
      const out = outRedirects[idx];
      const err = specs[idx]!.redirects.find((r) => r.fd === 2 && (r.op === ">" || r.op === ">>"));
      if (out) drains.push(this.drainToFile(stage.stdout, out.file, out.op === ">>"));
      else if (isLast) drains.push(this.drainToStream(stage.stdout, shellStdout));
      if (err) drains.push(this.drainToFile(stage.stderr, err.file, err.op === ">>"));
      else drains.push(this.drainToStream(stage.stderr, shellStderr));
    }

    const status = await stages[stages.length - 1]!.wait();
    await Promise.all(drains);
    return status.code;
  }

  /** `$?` is a shell parameter, not an environment variable: it is injected into
   *  the expansion environment only, so it can never reach a spawned process's
   *  env (where `env` would print a bogus `?=0`). An env entry actually named
   *  `?` — only reachable via `export '?=x'` — loses to the parameter, as in
   *  bash, where `$?` never reads the environment at all. */
  private expandCommand(command: Command, lastStatus: number): ExpandedCommand {
    const env = { ...this.env, "?": String(lastStatus) };
    const argv = command.words.flatMap((w) => expandWord(w, env, this.vfs, this.cwd));
    const redirects: ExpandedRedirect[] = command.redirects.map((r) => {
      const targets = expandWord(r.target, env, this.vfs, this.cwd);
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
