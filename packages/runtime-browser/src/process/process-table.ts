import { ErrnoError } from "@erdou/runtime-contract";
import type {
  SpawnOptions,
  ProcessInfo,
  ProcessState,
  ExitStatus,
  Signal,
} from "@erdou/runtime-contract";
import { PipeStream } from "../core/byte-stream.js";
import type { EventBus } from "../core/event-bus.js";
import type { Vfs } from "../vfs/vfs.js";
import type { Program, ProgramRegistry, ProcessContext } from "./program.js";
import { pipeProcesses } from "./pipe.js";

const SIGNAL_NUMBERS: Record<Signal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
};

export interface ProcessRecord {
  pid: number;
  ppid: number;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  state: ProcessState;
  exitCode: number | null;
  signal: Signal | null;
  startTimeMs: number;
  stdin: PipeStream;
  stdout: PipeStream;
  stderr: PipeStream;
  wait(): Promise<ExitStatus>;
  kill(signal?: Signal): void;
}

/** Internal spawn options beyond the public contract. */
export interface InternalSpawnOptions extends SpawnOptions {
  ppid?: number;
  /** Leave stdin open so the caller can pipe into it (used by pipelines). */
  pipeStdin?: boolean;
}

export interface ProcessTableDeps {
  vfs: Vfs;
  bus: EventBus;
  registry: ProgramRegistry;
  clock: () => number;
}

function toInfo(r: ProcessRecord): ProcessInfo {
  return {
    pid: r.pid,
    ppid: r.ppid,
    cmd: r.cmd,
    args: r.args,
    cwd: r.cwd,
    state: r.state,
    startTimeMs: r.startTimeMs,
    exitCode: r.exitCode,
  };
}

export class ProcessTable {
  private nextPid = 1;
  private readonly procs = new Map<number, ProcessRecord>();

  constructor(private readonly deps: ProcessTableDeps) {}

  spawn(opts: InternalSpawnOptions): ProcessRecord {
    const program: Program | undefined = this.deps.registry.get(opts.cmd);
    if (program === undefined) {
      throw new ErrnoError("ENOENT", { path: opts.cmd, syscall: "spawn" });
    }

    const pid = this.nextPid++;
    const now = this.deps.clock();
    const stdin = new PipeStream();
    const stdout = new PipeStream();
    const stderr = new PipeStream();

    if (opts.pipeStdin) {
      // left open — a pipeline stage will write into it and end it
    } else if (opts.stdin !== undefined) {
      stdin.write(opts.stdin);
      stdin.end();
    } else {
      stdin.end();
    }

    let resolveWait!: (status: ExitStatus) => void;
    const waitPromise = new Promise<ExitStatus>((resolve) => {
      resolveWait = resolve;
    });
    let settled = false;

    const finish = (state: "exited" | "killed", code: number, signal: Signal | null): void => {
      if (settled) return;
      settled = true;
      record.state = state;
      record.exitCode = code;
      record.signal = signal;
      if (!stdout.isClosed) stdout.end();
      if (!stderr.isClosed) stderr.end();
      // Resolve waiters before emitting so a throwing event listener can never
      // leave wait() unresolved.
      resolveWait({ code, signal });
      this.deps.bus.emit({ type: "process.exited", pid, code, signal });
    };

    const record: ProcessRecord = {
      pid,
      ppid: opts.ppid ?? 0,
      cmd: opts.cmd,
      args: opts.args ?? [],
      cwd: opts.cwd ?? "/",
      // Copy env so mutating a caller's env object (e.g. the shell's, via
      // `export`) cannot retroactively change an already-running process.
      env: opts.env ? { ...opts.env } : {},
      state: "running",
      exitCode: null,
      signal: null,
      startTimeMs: now,
      stdin,
      stdout,
      stderr,
      wait: () => waitPromise,
      kill: (signal: Signal = "SIGTERM") => {
        finish("killed", 128 + SIGNAL_NUMBERS[signal], signal);
      },
    };

    this.procs.set(pid, record);
    this.deps.bus.emit({ type: "process.started", pid, cmd: opts.cmd });

    const ctx: ProcessContext = {
      pid,
      argv: [opts.cmd, ...(opts.args ?? [])],
      env: record.env,
      cwd: record.cwd,
      stdin,
      stdout,
      stderr,
      vfs: this.deps.vfs,
      spawn: (cmd, args, o) =>
        this.spawn({
          cmd,
          args,
          cwd: o?.cwd ?? record.cwd,
          env: o?.env ?? record.env,
          ppid: pid,
        }),
    };

    queueMicrotask(() => {
      // If the process was killed before its body started, don't run it.
      if (settled) return;
      program(ctx).then(
        (code) => finish("exited", code, null),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!stderr.isClosed) stderr.write(message + "\n");
          finish("exited", 1, null);
        },
      );
    });

    return record;
  }

  /** Spawn a pipeline: each stage's stdout feeds the next stage's stdin. The
   *  last record's stdout is the pipeline's output. */
  spawnPiped(stages: InternalSpawnOptions[]): ProcessRecord[] {
    const records: ProcessRecord[] = [];
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const isFirst = i === 0;
      const record = this.spawn({ ...stage, pipeStdin: !isFirst });
      if (!isFirst) pipeProcesses(records[i - 1]!, record);
      records.push(record);
    }
    return records;
  }

  get(pid: number): ProcessRecord | undefined {
    return this.procs.get(pid);
  }

  list(): ProcessInfo[] {
    return [...this.procs.values()].map(toInfo);
  }

  kill(pid: number, signal?: Signal): void {
    const record = this.procs.get(pid);
    if (record === undefined) throw new ErrnoError("ESRCH", { path: String(pid), syscall: "kill" });
    record.kill(signal);
  }

  wait(pid: number): Promise<ExitStatus> {
    const record = this.procs.get(pid);
    if (record === undefined) throw new ErrnoError("ESRCH", { path: String(pid), syscall: "wait" });
    return record.wait();
  }
}
