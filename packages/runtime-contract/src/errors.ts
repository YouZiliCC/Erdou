/**
 * POSIX-style errno errors. The kernel throws these — with the offending path
 * and syscall attached — instead of returning silent defaults, so failures
 * surface loudly and are debuggable at the call site.
 */
export type Errno =
  | "ENOENT"
  | "EEXIST"
  | "ENOTDIR"
  | "EISDIR"
  | "EACCES"
  | "ENOTEMPTY"
  | "EINVAL"
  | "ELOOP"
  | "EBADF"
  | "ESRCH"
  | "EADDRINUSE";

const DESCRIPTIONS: Record<Errno, string> = {
  ENOENT: "no such file or directory",
  EEXIST: "file already exists",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EACCES: "permission denied",
  ENOTEMPTY: "directory not empty",
  EINVAL: "invalid argument",
  ELOOP: "too many symbolic links encountered",
  EBADF: "bad file descriptor",
  ESRCH: "no such process",
  EADDRINUSE: "address already in use",
};

export interface ErrnoOptions {
  path?: string;
  syscall?: string;
}

export class ErrnoError extends Error {
  readonly code: Errno;
  readonly path?: string;
  readonly syscall?: string;

  constructor(code: Errno, opts: ErrnoOptions = {}) {
    const desc = DESCRIPTIONS[code];
    const tail = opts.syscall
      ? `, ${opts.syscall}${opts.path ? ` '${opts.path}'` : ""}`
      : opts.path
        ? ` '${opts.path}'`
        : "";
    super(`${code}: ${desc}${tail}`);
    this.name = "ErrnoError";
    this.code = code;
    if (opts.path !== undefined) this.path = opts.path;
    if (opts.syscall !== undefined) this.syscall = opts.syscall;
  }
}

const factory = (code: Errno) => (path: string, syscall: string): ErrnoError =>
  new ErrnoError(code, { path, syscall });

export const enoent = factory("ENOENT");
export const eexist = factory("EEXIST");
export const enotdir = factory("ENOTDIR");
export const eisdir = factory("EISDIR");
export const enotempty = factory("ENOTEMPTY");
export const eloop = factory("ELOOP");
export const ebadf = factory("EBADF");
export const eacces = factory("EACCES");
export const esrch = factory("ESRCH");
export const eaddrinuse = factory("EADDRINUSE");
