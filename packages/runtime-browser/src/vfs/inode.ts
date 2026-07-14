import type { FileType } from "@erdou/runtime-contract";

export interface BaseInode {
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface DirInode extends BaseInode {
  type: "directory";
  children: Map<string, Inode>;
}

export interface FileInode extends BaseInode {
  type: "file";
  data: Uint8Array;
}

export interface SymlinkInode extends BaseInode {
  type: "symlink";
  target: string;
}

export type Inode = DirInode | FileInode | SymlinkInode;

export const inodeType = (node: Inode): FileType => node.type;

export function newDir(now: number, mode = 0o755): DirInode {
  return {
    type: "directory",
    mode,
    mtimeMs: now,
    ctimeMs: now,
    birthtimeMs: now,
    children: new Map(),
  };
}

export function newFile(data: Uint8Array, now: number, mode = 0o644): FileInode {
  return { type: "file", mode, mtimeMs: now, ctimeMs: now, birthtimeMs: now, data };
}

export function newSymlink(target: string, now: number, mode = 0o777): SymlinkInode {
  return { type: "symlink", mode, mtimeMs: now, ctimeMs: now, birthtimeMs: now, target };
}
