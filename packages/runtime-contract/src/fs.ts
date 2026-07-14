export type FileType = "file" | "directory" | "symlink";

export interface Stat {
  type: FileType;
  size: number;
  /** POSIX permission bits, e.g. 0o644. */
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface FileEntry {
  name: string;
  type: FileType;
}

export interface WriteFileOptions {
  mode?: number;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}
