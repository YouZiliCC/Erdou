import type { ByteStream, WritableByteStream } from "./process.js";
import type { Stat, FileEntry, WriteFileOptions, MkdirOptions, RmOptions } from "./fs.js";
import type { HttpHandler } from "./http.js";

/**
 * The synchronous filesystem surface an executor (a built-in, a language
 * runtime, a WASI host…) uses. Any Runtime's filesystem satisfies this, so
 * executors never depend on a concrete Runtime — only on this contract.
 */
export interface FileSystemApi {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | string, opts?: WriteFileOptions): void;
  appendFile(path: string, data: Uint8Array | string): void;
  readdir(path: string): FileEntry[];
  mkdir(path: string, opts?: MkdirOptions): void;
  rm(path: string, opts?: RmOptions): void;
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
  stat(path: string): Stat;
  lstat(path: string): Stat;
  exists(path: string): boolean;
  readlink(path: string): string;
  symlink(target: string, linkPath: string): void;
  chmod(path: string, mode: number): void;
}

/**
 * What a process's program receives — a POSIX-like "syscall" surface. This is
 * the extension point for new languages: a language runtime is just an
 * `Executor` you register under a command name (e.g. "python"). Because it maps
 * so closely to WASI (argv/env/cwd/stdio/fs), a WASI host is an Executor too.
 */
export interface ExecContext {
  pid: number;
  /** [command, ...args] */
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ByteStream;
  stdout: WritableByteStream;
  stderr: WritableByteStream;
  fs: FileSystemApi;
  /** Register an HTTP handler for this process on a virtual port. */
  serve(port: number, handler: HttpHandler): void;
}

/** A program: runs in a process, resolves to an exit code. */
export type Executor = (ctx: ExecContext) => Promise<number>;
