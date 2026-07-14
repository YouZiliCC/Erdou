import type { ByteStream, WritableByteStream } from "@erdou/runtime-contract";
import type { Vfs } from "../vfs/vfs.js";
import type { ProcessRecord } from "./process-table.js";

/** The execution context handed to a program (an in-process "syscall" surface). */
export interface ProcessContext {
  pid: number;
  /** [cmd, ...args] */
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ByteStream;
  stdout: WritableByteStream;
  stderr: WritableByteStream;
  vfs: Vfs;
  spawn(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): ProcessRecord;
}

/** A program is a function that runs in a process and resolves to an exit code. */
export type Program = (ctx: ProcessContext) => Promise<number>;

export type ProgramRegistry = Map<string, Program>;
