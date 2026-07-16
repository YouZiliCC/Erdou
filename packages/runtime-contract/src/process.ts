export type Signal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

export type ProcessState = "running" | "exited" | "killed";

export interface ExitStatus {
  code: number;
  signal: Signal | null;
}

export interface SpawnOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  /** Run in the background — the caller does not block on it. A serving
   *  program (a real server blocks forever) is spawned detached; its
   *  readiness is observed via the `port.opened` event, never by waiting
   *  for the process to exit. */
  detached?: boolean;
}

/** A readable stream of bytes produced by a process. */
export interface ByteStream {
  read(): AsyncIterableIterator<Uint8Array>;
  /** Drains the stream to completion and decodes it as UTF-8. */
  text(): Promise<string>;
}

/** A writable stream of bytes consumed by a process. */
export interface WritableByteStream {
  write(chunk: Uint8Array | string): void;
  end(): void;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly stdout: ByteStream;
  readonly stderr: ByteStream;
  readonly stdin: WritableByteStream;
  wait(): Promise<ExitStatus>;
  kill(signal?: Signal): Promise<void>;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cmd: string;
  args: string[];
  cwd: string;
  state: ProcessState;
  startTimeMs: number;
  exitCode: number | null;
}
