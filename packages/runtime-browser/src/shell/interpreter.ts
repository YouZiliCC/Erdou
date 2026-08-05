import { ErrnoError } from "@erdou/runtime-contract";
import type { Signal } from "@erdou/runtime-contract";
import { parse } from "./parser.js";
import { expandWord } from "./expand.js";
import type { Command, List, ListItem, Pipeline, Word, WordPart } from "./ast.js";
import { PipeStream } from "../core/byte-stream.js";
import { join, normalize } from "../vfs/path.js";
import type { Vfs } from "../vfs/vfs.js";
import type { ProcessTable, InternalSpawnOptions, ProcessRecord } from "../process/process-table.js";
import { pipeProcesses } from "../process/pipe.js";

const resolveAbs = (cwd: string, p: string): string =>
  p.startsWith("/") ? normalize(p) : join(cwd, p);

/** The commands the shell runs itself rather than spawning, because they touch
 *  its own cwd / environment / job list. They are also registered in the program
 *  registry as no-ops so `which cd` answers — which is why a pipeline has to
 *  reject them explicitly rather than let that no-op run. */
const IN_PROCESS_BUILTINS = new Set(["cd", "export", "jobs"]);

/** How deep `$( $( … ) )` may nest. Nesting is bounded by the source text — a
 *  substitution can only run what was literally written inside it, so runaway
 *  recursion is not reachable — but a pathological line should still fail with
 *  a message rather than build thousands of async frames. */
const MAX_SUBSTITUTION_DEPTH = 16;

/** What a `$(...)` needs from the command that contains it: where to report the
 *  substitution's stderr, and the caller's process list + cancel flag, so a kill
 *  of the outer command reaches the subshell's processes too. */
interface SubshellContext {
  stderr: PipeStream;
  records: ProcessRecord[];
  canceled: () => boolean;
}

type ExpandedRedirect =
  | { fd: 0 | 1 | 2; op: ">" | ">>" | "<"; file: string }
  | { fd: 1 | 2; op: ">&"; from: 1 | 2 };
interface ExpandedCommand {
  argv: string[];
  redirects: ExpandedRedirect[];
}

/**
 * Where one of a stage's output fds ends up.
 *
 * `stdout`/`stderr` name the fd's DEFAULT destination — the stage's own stdout
 * (the pipe to the next stage, or the shell's stdout on the last stage) and the
 * shell's stderr. Keeping them SYMBOLIC rather than resolving them up front is
 * what lets `2>&1` copy fd 1's target *as it stands at that point in the line*,
 * so `> log 2>&1` (both to the file) and `2>&1 > log` (stderr to the terminal,
 * stdout to the file) come out different, as POSIX says they must.
 *
 * `null` is `/dev/null`: the VFS boots with an empty root and has no device
 * nodes, so the shell recognizes the PATH and discards the stream itself —
 * otherwise `2>/dev/null`, one of the most common idioms an agent writes,
 * failed the whole line with ENOENT before the command ever ran. Redirects
 * only: a program that opens the path itself (`cat /dev/null`) still sees
 * ENOENT, exactly like any other missing file.
 */
type Sink =
  | { to: "stdout" }
  | { to: "stderr" }
  | { to: "null" }
  | { to: "file"; file: string; append: boolean };

/** Redirect targets are absolute and normalized by `expandCommand`, so the
 *  literal path is the whole test — `cd / && echo x > dev/null` matches too. */
const isDevNull = (file: string): boolean => file === "/dev/null";

interface StageSinks {
  out: Sink;
  err: Sink;
}

/** Both fds ended up in the same place, so the command should get ONE stream
 *  for them (a real dup2) rather than two that are merged afterwards. */
function sameSink(a: Sink, b: Sink): boolean {
  if (a.to !== b.to) return false;
  return a.to !== "file" || (b.to === "file" && a.file === b.file);
}

/** Two fds aimed at ONE file in different modes has no honest answer (`> f`
 *  truncates, `>> f` appends, and whichever write lands last decides). The
 *  realistic pairs — `&> f`, `> f 2>&1` — always agree, and share a stream. */
function assertNoModeConflict({ out, err }: StageSinks): void {
  if (out.to === "file" && err.to === "file" && out.file === err.file && out.append !== err.append) {
    throw new ErrnoError("EINVAL", {
      syscall: "redirect",
      path: `conflicting > and >> redirects to ${out.file}`,
    });
  }
}

/** Fold a command's redirects left to right into a final destination per output
 *  fd. `<` is handled separately (it is the stage's stdin, not a sink). */
function resolveSinks(redirects: ExpandedRedirect[]): StageSinks {
  let out: Sink = { to: "stdout" };
  let err: Sink = { to: "stderr" };
  for (const r of redirects) {
    if (r.op === "<") continue;
    if (r.op === ">&") {
      // Copy the OTHER fd's current sink. `2>&2` / `1>&1` are no-ops, as in bash.
      if (r.fd === 1) out = r.from === 1 ? out : err;
      else err = r.from === 1 ? out : err;
      continue;
    }
    const sink: Sink = isDevNull(r.file)
      ? { to: "null" }
      : { to: "file", file: r.file, append: r.op === ">>" };
    if (r.fd === 1) out = sink;
    else err = sink;
  }
  return { out, err };
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
  /** Internal: how many `$(...)` levels deep this shell already is. Set only by
   *  {@link Shell.runSubstitution} when it builds the subshell. */
  substitutionDepth?: number;
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
  /** `$( )` nesting level of this shell (0 for a user's shell). */
  private readonly subDepth: number;

  constructor(deps: ShellDeps) {
    this.subDepth = deps.substitutionDepth ?? 0;
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
      code = await this.execPipeline(item.pipeline, stdout, stderr, records, status.last, canceled);
      status.last = code;
    }
    return code;
  }

  /**
   * Launch `list` as a detached background job: adopt a real pid for the
   * composite (so it shows up in `ps` and `kill <pid>` kills the whole job),
   * buffer its stdout/stderr on that process-table entry, register it in this
   * shell's job list, and announce "[pid] command" on the shell's stdout.
   * Returns 0 immediately — the caller does not await the job. The job reads
   * this shell's LIVE cwd/env, at the moment each stage spawns; that is a
   * microtask or more after the `&` line, because expansion became async with
   * `$(...)`. (Before that it spawned synchronously here and the job was
   * guaranteed the cwd/env as of the `&`. A `cd` cannot realistically land in
   * the gap — it takes another `execute` call, i.e. a macrotask — but the
   * guarantee is weaker than it was, so it is stated rather than implied.)
   * The shell has no async output channel (sessions are command-at-a-time), so
   * the buffered output surfaces only when `jobs` reports the job done — never
   * interleaved into a later prompt.
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

  /**
   * Open every `<` of a command, in order, and return the LAST one's bytes as
   * stdin (bash opens them all; the last wins). Opening all of them is what
   * makes `cat < b < missing` fail instead of quietly printing b.
   */
  private openInputs(spec: ExpandedCommand): Uint8Array | undefined {
    let stdin: Uint8Array | undefined;
    for (const r of spec.redirects) {
      if (r.op === "<") stdin = isDevNull(r.file) ? new Uint8Array() : this.vfs.readFile(r.file);
    }
    return stdin;
  }

  /**
   * Open every output target, in source order, BEFORE the command runs — where
   * bash opens them. Three behaviours depend on it: a target a later redirect
   * overrides is still created and truncated (`> a > b` leaves `a` empty); a
   * target that cannot be opened fails the command INSTEAD of letting it run
   * and discarding its output; and a command that never starts still truncates
   * its log, so a re-run cannot leave the previous run's output there to be
   * read as this one's.
   */
  private openTargets(specs: ExpandedCommand[]): void {
    for (const spec of specs) {
      for (const r of spec.redirects) {
        if ((r.op === ">" || r.op === ">>") && isDevNull(r.file)) continue; // a discard, not a file
        if (r.op === ">") this.vfs.writeFile(r.file, new Uint8Array());
        else if (r.op === ">>" && !this.vfs.exists(r.file)) {
          this.vfs.writeFile(r.file, new Uint8Array());
        }
      }
    }
  }

  /** Drain one of a command's output streams to wherever its fd resolved. */
  private drainSink(
    sink: Sink,
    stream: PipeStream,
    shellStdout: PipeStream,
    shellStderr: PipeStream,
  ): Promise<void> {
    if (sink.to === "null") return this.drainToNull(stream);
    if (sink.to === "file") return this.drainToFile(stream, sink.file, sink.append);
    return this.drainToStream(stream, sink.to === "stderr" ? shellStderr : shellStdout);
  }

  /** Read the stream to completion and drop every chunk — the write side of
   *  `/dev/null`. The read must still happen: an undrained PipeStream would
   *  hold the whole output in memory for the life of the process record. */
  private async drainToNull(stream: PipeStream): Promise<void> {
    for await (const chunk of stream.read()) void chunk;
  }

  /**
   * Run an in-process builtin (`cd`/`export`/`jobs`) with its redirects
   * honoured. These three are handled in-process because they touch the shell's
   * own cwd/env/job-list, but that is no reason for `jobs > jobs.log` to print
   * to the terminal and write no file — which is what dispatching them before
   * the redirect machinery used to do.
   *
   * Order matters and matches bash: the redirects are set up FIRST, so a target
   * that cannot be opened fails the line and the builtin's side effect (the cwd
   * move, the assignment) never happens. Targets were resolved against the cwd
   * back in `expandCommand`, so `cd /sub > rel.log` writes the log next to
   * where the shell was, not where it lands. Draining after the builtin returns
   * cannot deadlock: PipeStream is unbounded, so writing with no reader is free.
   */
  private async runBuiltin(
    spec: ExpandedCommand,
    run: (stdout: PipeStream, stderr: PipeStream) => number | Promise<number>,
    shellStdout: PipeStream,
    shellStderr: PipeStream,
  ): Promise<number> {
    const sinks = resolveSinks(spec.redirects);
    assertNoModeConflict(sinks);
    this.openInputs(spec); // opened for its errors only — no builtin reads stdin
    this.openTargets([spec]);

    const merged = sameSink(sinks.out, sinks.err);
    const out = new PipeStream();
    const err = merged ? out : new PipeStream();
    try {
      return await run(out, err);
    } finally {
      out.end();
      err.end();
      const drains = [this.drainSink(sinks.out, out, shellStdout, shellStderr)];
      // A merged builtin has ONE stream; draining it twice would split its
      // output between the two consumers.
      if (!merged) drains.push(this.drainSink(sinks.err, err, shellStdout, shellStderr));
      await Promise.all(drains);
    }
  }

  private async execPipeline(
    pipeline: Pipeline,
    shellStdout: PipeStream,
    shellStderr: PipeStream,
    records: ProcessRecord[],
    lastStatus: number,
    canceled: () => boolean,
  ): Promise<number> {
    const ctx: SubshellContext = { stderr: shellStderr, records, canceled };
    const specs: ExpandedCommand[] = [];
    for (const c of pipeline.commands) specs.push(await this.expandCommand(c, lastStatus, ctx));

    if (specs.length > 1) {
      // Only a single-command line reaches the in-process handlers below, and
      // cd/export/jobs are ALSO registered as no-op programs (so `which cd`
      // answers) — so a piped builtin used to spawn that no-op and exit 0 with
      // no output. Refuse instead: bash would run it in a subshell, where its
      // whole purpose (changing THIS shell's cwd/env/job list) cannot happen,
      // so there is nothing worth emulating and everything to say out loud.
      const idx = specs.findIndex((s) => IN_PROCESS_BUILTINS.has(s.argv[0] ?? ""));
      if (idx !== -1) {
        throw new ErrnoError("EINVAL", {
          syscall: "spawn",
          path:
            `'${specs[idx]!.argv[0]}' is a shell builtin and cannot be used in a pipeline — ` +
            `it changes this shell's own cwd/environment/job list, which a pipeline stage cannot do. ` +
            `Run it as its own command (redirect it if you want its output in a file).`,
        });
      }
    }

    if (specs.length === 1) {
      const spec = specs[0]!;
      const argv = spec.argv;
      // Bound to the streams the redirects resolve to, not to the shell's own:
      // a builtin's output is redirectable like any other command's.
      if (argv[0] === "cd") {
        return this.runBuiltin(spec, (_out, err) => this.builtinCd(argv, err), shellStdout, shellStderr);
      }
      if (argv[0] === "export") {
        return this.runBuiltin(spec, () => this.builtinExport(argv), shellStdout, shellStderr);
      }
      if (argv[0] === "jobs") {
        return this.runBuiltin(spec, (out, err) => this.builtinJobs(argv, out, err), shellStdout, shellStderr);
      }
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

    const firstStdin = this.openInputs(specs[0]!);
    const sinks = specs.map((s) => resolveSinks(s.redirects));
    for (const s of sinks) assertNoModeConflict(s);
    this.openTargets(specs);
    const lastIdx = specs.length - 1;
    /** Both fds end up in the same place — so the process gets ONE stream. */
    const merged = sinks.map(({ out, err }) => sameSink(out, err));
    // A stage feeds the next one only while fd 1 still points at its own stdout;
    // `> f` takes it off the pipe. When the fds are merged, that one stream
    // carries both.
    const feedsNext = (idx: number): boolean => idx < lastIdx && sinks[idx]!.out.to === "stdout";

    // Spawned here rather than via table.spawnPiped so that a stage whose
    // stdout is redirected is NOT also piped onward. A PipeStream is
    // single-consumer (read() shifts chunks off one shared array), so leaving
    // both the pipe pump and drainToFile reading it round-robins the output
    // between the file and the next stage. POSIX gives the redirect the
    // stdout and the next stage an empty stdin — which is exactly what
    // spawning that stage without `pipeStdin` produces.
    const stages: ProcessRecord[] = [];
    try {
      for (let idx = 0; idx < specs.length; idx++) {
        const spec = specs[idx]!;
        const upstream = idx > 0 && feedsNext(idx - 1);
        const opts: InternalSpawnOptions = {
          cmd: spec.argv[0] ?? "",
          args: spec.argv.slice(1),
          cwd: this.cwd,
          env: this.env,
          ...(idx === 0 && firstStdin !== undefined ? { stdin: firstStdin } : {}),
          ...(upstream ? { pipeStdin: true } : {}),
          ...(merged[idx] ? { mergeOutput: true } : {}),
        };
        const record = this.table.spawn(opts);
        // Record before wiring: a later stage failing to spawn (ENOENT) must
        // still leave the ones already running killable through the caller's
        // ShellResult, not orphaned in the process table forever.
        stages.push(record);
        records.push(record);
        if (upstream) pipeProcesses(stages[idx - 1]!, record);
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
      const isLast = idx === lastIdx;
      const drain = (sink: Sink, stream: PipeStream): void => {
        // `stdout` on a non-last stage needs no drain — the pipe consumed it.
        if (sink.to === "stdout" && !isLast) return;
        drains.push(this.drainSink(sink, stream, shellStdout, shellStderr));
      };
      drain(sinks[idx]!.out, stage.stdout);
      // A merged stage has ONE stream; draining `stage.stderr` too would put a
      // second consumer on it and split the output between them.
      if (!merged[idx]) drain(sinks[idx]!.err, stage.stderr);
    }

    // Wait for EVERY stage, not just the last: POSIX says the shell waits for
    // all of a pipeline's commands and reports the last one's status. This used
    // to happen by accident, because each stage's stderr was unconditionally
    // drained; a `2>&1` that put stderr on the pipe removed that drain and let
    // the pipeline settle with an upstream process still running.
    const statuses = await Promise.all(stages.map((s) => s.wait()));
    await Promise.all(drains);
    return statuses[lastIdx]!.code;
  }

  /**
   * Run `src` in a SUBSHELL and return its stdout with trailing newlines
   * stripped — `$(...)`.
   *
   * A fresh Shell over the same table and vfs, holding a COPY of the cwd and
   * environment, is the subshell: `cd` and `export` inside `$( )` mutate that
   * instance's fields and are dropped with it, which is exactly the isolation
   * POSIX asks for, for free.
   *
   * Two things are deliberately shared rather than copied. The substitution's
   * processes are recorded in the CALLER's `records`, so killing the outer
   * command kills the substitution with it instead of orphaning it. And its
   * stderr goes straight to the shell's, so a diagnostic printed inside `$( )`
   * is reported rather than captured into the expansion and pasted into an
   * argument.
   *
   * The exit status is NOT adopted: `echo $(false)` succeeds, as in bash.
   */
  private async runSubstitution(src: string, ctx: SubshellContext): Promise<string> {
    if (this.subDepth >= MAX_SUBSTITUTION_DEPTH) {
      throw new ErrnoError("EINVAL", {
        syscall: "expand",
        path: `command substitution nested deeper than ${MAX_SUBSTITUTION_DEPTH}: $(${src})`,
      });
    }
    const out = new PipeStream();
    const sub = new Shell({
      table: this.table,
      vfs: this.vfs,
      cwd: this.cwd,
      env: { ...this.env },
      substitutionDepth: this.subDepth + 1,
    });
    try {
      await sub.process(src, out, ctx.stderr, ctx.records, ctx.canceled);
    } catch (err) {
      // A failure inside `$( )` is the SUBSTITUTION's failure, not the outer
      // command's. bash reports it and lets the outer command run with whatever
      // was captured — `echo [$(nosuchcmd)]` prints `[]` and exits 0 — so this
      // is reported on the shell's stderr rather than rethrown.
      const msg = err instanceof Error ? err.message : String(err);
      if (!ctx.stderr.isClosed) ctx.stderr.write(msg + "\n");
    } finally {
      out.end();
    }
    return (await out.text()).replace(/\n+$/, "");
  }

  /** Resolve every `$(...)` in a word to its output, left to right — order
   *  matters because a substitution can have side effects. */
  private async substitute(word: Word, ctx: SubshellContext): Promise<Word> {
    if (!word.parts.some((p) => p.t === "cmdsub")) return word;
    const parts: WordPart[] = [];
    for (const p of word.parts) {
      parts.push(p.t === "cmdsub" ? { t: "sub", v: await this.runSubstitution(p.src, ctx) } : p);
    }
    return { parts };
  }

  /** `$?` is a shell parameter, not an environment variable: it is injected into
   *  the expansion environment only, so it can never reach a spawned process's
   *  env (where `env` would print a bogus `?=0`). An env entry actually named
   *  `?` — only reachable via `export '?=x'` — loses to the parameter, as in
   *  bash, where `$?` never reads the environment at all. */
  private async expandCommand(
    command: Command,
    lastStatus: number,
    ctx: SubshellContext,
  ): Promise<ExpandedCommand> {
    const env = { ...this.env, "?": String(lastStatus) };
    // Sequential, not `map`: a `$( )` can write files, so the substitutions in
    // one command line have to run in the order they were written.
    const argv: string[] = [];
    for (const w of command.words) {
      argv.push(...expandWord(await this.substitute(w, ctx), env, this.vfs, this.cwd));
    }
    const redirects: ExpandedRedirect[] = [];
    for (const r of command.redirects) {
      // A duplication names an fd, not a path — nothing to expand.
      if (r.op === ">&") {
        redirects.push({ fd: r.fd, op: r.op, from: r.from });
        continue;
      }
      const targets = expandWord(await this.substitute(r.target, ctx), env, this.vfs, this.cwd);
      if (targets.length !== 1) {
        throw new ErrnoError("EINVAL", { syscall: "redirect", path: "ambiguous redirect" });
      }
      redirects.push({ fd: r.fd, op: r.op, file: resolveAbs(this.cwd, targets[0]!) });
    }
    return { argv, redirects };
  }

  /**
   * Drain one stream into `file`. `&> f` / `> f 2>&1` need no special case
   * here: those stages are spawned with `mergeOutput`, so both fds already
   * write into this single stream, in the order the program wrote them.
   *
   * MEMORY: the whole output is buffered before it reaches the file, so
   * `cmd > big.log` peaks at the size of what `cmd` printed. Deliberate, not an
   * oversight — `Vfs.appendFile` reallocates and copies the entire file on
   * every call, so streaming chunk-by-chunk would turn one linear write into a
   * quadratic one. The file itself is in memory either way; the buffer only
   * doubles the peak.
   */
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
