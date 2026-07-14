import type { FileSystemApi } from "@erdou/runtime-contract";

const decoder = new TextDecoder();

function toStat(fs: FileSystemApi, path: string, follow: boolean) {
  const s = follow ? fs.stat(path) : fs.lstat(path);
  return {
    type: s.type === "directory" ? "dir" : s.type === "symlink" ? "symlink" : "file",
    mode: s.mode,
    size: s.size,
    ino: 0,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => s.type === "file",
    isDirectory: () => s.type === "directory",
    isSymbolicLink: () => s.type === "symlink",
  };
}

/**
 * Adapt Erdou's synchronous filesystem to the async `fs.promises` shape
 * isomorphic-git expects. Errors already carry POSIX `.code`s (ENOENT, …), so
 * isomorphic-git's own retry/mkdirp logic works unchanged.
 */
export function createGitFs(fs: FileSystemApi): {
  promises: Record<string, (...args: never[]) => Promise<unknown>>;
} {
  const promises = {
    async readFile(path: string, opts?: string | { encoding?: string }): Promise<Uint8Array | string> {
      const bytes = fs.readFile(path);
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      return encoding === "utf8" ? decoder.decode(bytes) : bytes;
    },
    async writeFile(path: string, data: Uint8Array | string): Promise<void> {
      fs.writeFile(path, typeof data === "string" ? data : new Uint8Array(data));
    },
    async unlink(path: string): Promise<void> {
      fs.rm(path);
    },
    async readdir(path: string): Promise<string[]> {
      return fs.readdir(path).map((e) => e.name);
    },
    async mkdir(path: string): Promise<void> {
      fs.mkdir(path);
    },
    async rmdir(path: string): Promise<void> {
      fs.rm(path);
    },
    async stat(path: string): Promise<ReturnType<typeof toStat>> {
      return toStat(fs, path, true);
    },
    async lstat(path: string): Promise<ReturnType<typeof toStat>> {
      return toStat(fs, path, false);
    },
    async symlink(target: string, path: string): Promise<void> {
      fs.symlink(target, path);
    },
    async readlink(path: string): Promise<string> {
      return fs.readlink(path);
    },
  };
  return { promises: promises as unknown as Record<string, (...args: never[]) => Promise<unknown>> };
}
