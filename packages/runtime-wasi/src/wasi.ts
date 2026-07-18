import type { FileSystemApi } from "@erdou/runtime-contract";

// WASI preview1 errno (note: these numbers differ from POSIX).
const E = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54 } as const;
// WASI filetype.
const FT = { UNKNOWN: 0, CHAR: 2, DIRECTORY: 3, REGULAR: 4, SYMLINK: 7 } as const;

const encoder = new TextEncoder();

export class WasiExit extends Error {
  constructor(public readonly code: number) {
    super(`wasi exit ${code}`);
  }
}

interface Fd {
  type: "stdin" | "stdout" | "stderr" | "file" | "dir" | "preopen";
  path?: string;
  buffer?: Uint8Array;
  position: number;
  readable: boolean;
  writable: boolean;
  dirty: boolean;
  preopenName?: string;
}

export interface WasiOptions {
  args: string[];
  env: Record<string, string>;
  fs: FileSystemApi;
  cwd: string;
  stdin: Uint8Array;
  writeStdout: (bytes: Uint8Array) => void;
  writeStderr: (bytes: Uint8Array) => void;
  /** Milliseconds since epoch. */
  now?: () => number;
  random?: (buffer: Uint8Array) => void;
}

function normalize(p: string): string {
  const stack: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return "/" + stack.join("/");
}

function mapError(err: unknown): number {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "ENOENT":
      return E.NOENT;
    case "EEXIST":
      return E.EXIST;
    case "ENOTDIR":
      return E.NOTDIR;
    case "EISDIR":
      return E.ISDIR;
    case "ENOTEMPTY":
      return E.EXIST;
    default:
      return E.INVAL;
  }
}

function fillRandom(buffer: Uint8Array): void {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(buffer);
}

/**
 * A subset WASI `wasi_snapshot_preview1` host backed by the Erdou filesystem
 * and stdio. Enough to run typical `wasm32-wasi` programs (args, env, stdio,
 * file read/write/seek, stat, mkdir/unlink, clock, random). Unimplemented calls
 * return ENOSYS rather than failing instantiation.
 */
export class WasiHost {
  private memory: WebAssembly.Memory | undefined;
  private readonly fds = new Map<number, Fd>();
  private nextFd = 4;
  exitCode = 0;

  constructor(private readonly opts: WasiOptions) {
    this.fds.set(0, { type: "stdin", position: 0, readable: true, writable: false, dirty: false, buffer: opts.stdin });
    this.fds.set(1, { type: "stdout", position: 0, readable: false, writable: true, dirty: false });
    this.fds.set(2, { type: "stderr", position: 0, readable: false, writable: true, dirty: false });
    this.fds.set(3, { type: "preopen", path: "/", position: 0, readable: true, writable: true, dirty: false, preopenName: "/" });
  }

  bind(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  private view(): DataView {
    return new DataView(this.memory!.buffer);
  }
  private u8(): Uint8Array {
    return new Uint8Array(this.memory!.buffer);
  }
  private readString(ptr: number, len: number): string {
    return new TextDecoder().decode(this.u8().subarray(ptr, ptr + len));
  }
  private resolve(base: string, rel: string): string {
    return rel.startsWith("/") ? normalize(rel) : normalize(`${base}/${rel}`);
  }

  private fileWrite(f: Fd, data: Uint8Array): void {
    const buf = f.buffer ?? new Uint8Array(0);
    const end = f.position + data.length;
    let out = buf;
    if (end > buf.length) {
      out = new Uint8Array(end);
      out.set(buf);
    }
    out.set(data, f.position);
    f.buffer = out;
    f.position = end;
    f.dirty = true;
  }

  private writeFilestat(ptr: number, stat: { type: string; size: number; mtimeMs: number }): void {
    const v = this.view();
    v.setBigUint64(ptr, 0n, true); // dev
    v.setBigUint64(ptr + 8, 0n, true); // ino
    v.setUint8(ptr + 16, stat.type === "directory" ? FT.DIRECTORY : stat.type === "symlink" ? FT.SYMLINK : FT.REGULAR);
    v.setBigUint64(ptr + 24, 1n, true); // nlink
    v.setBigUint64(ptr + 32, BigInt(stat.size), true);
    const t = BigInt(Math.floor(stat.mtimeMs * 1e6));
    v.setBigUint64(ptr + 40, t, true);
    v.setBigUint64(ptr + 48, t, true);
    v.setBigUint64(ptr + 56, t, true);
  }

  /** The import object to instantiate a module with. Unknown calls → ENOSYS. */
  get imports(): WebAssembly.ModuleImports {
    return new Proxy(this.impls(), {
      get: (target, key: string) => (key in target ? target[key] : () => E.NOSYS),
    });
  }

  private impls(): Record<string, (...args: number[]) => number> {
    const o = this.opts;
    return {
      proc_exit: (code: number): number => {
        this.exitCode = code;
        throw new WasiExit(code);
      },

      args_sizes_get: (argcPtr: number, bufSizePtr: number): number => {
        const v = this.view();
        v.setUint32(argcPtr, o.args.length, true);
        v.setUint32(bufSizePtr, o.args.reduce((n, a) => n + encoder.encode(a).length + 1, 0), true);
        return E.SUCCESS;
      },
      args_get: (argvPtr: number, bufPtr: number): number => {
        const v = this.view();
        const u = this.u8();
        let p = bufPtr;
        o.args.forEach((a, i) => {
          v.setUint32(argvPtr + i * 4, p, true);
          const b = encoder.encode(a);
          u.set(b, p);
          p += b.length;
          u[p++] = 0;
        });
        return E.SUCCESS;
      },
      environ_sizes_get: (countPtr: number, bufSizePtr: number): number => {
        const entries = Object.entries(o.env);
        const v = this.view();
        v.setUint32(countPtr, entries.length, true);
        v.setUint32(bufSizePtr, entries.reduce((n, [k, val]) => n + encoder.encode(`${k}=${val}`).length + 1, 0), true);
        return E.SUCCESS;
      },
      environ_get: (environPtr: number, bufPtr: number): number => {
        const v = this.view();
        const u = this.u8();
        let p = bufPtr;
        Object.entries(o.env).forEach(([k, val], i) => {
          v.setUint32(environPtr + i * 4, p, true);
          const b = encoder.encode(`${k}=${val}`);
          u.set(b, p);
          p += b.length;
          u[p++] = 0;
        });
        return E.SUCCESS;
      },

      fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number => {
        const f = this.fds.get(fd);
        if (!f || !f.writable) return E.BADF;
        const v = this.view();
        const u = this.u8();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const base = v.getUint32(iovsPtr + i * 8, true);
          const len = v.getUint32(iovsPtr + i * 8 + 4, true);
          chunks.push(u.slice(base, base + len));
          total += len;
        }
        const data = concat(chunks);
        if (f.type === "stdout") o.writeStdout(data);
        else if (f.type === "stderr") o.writeStderr(data);
        else this.fileWrite(f, data);
        v.setUint32(nwrittenPtr, total, true);
        return E.SUCCESS;
      },
      fd_read: (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number => {
        const f = this.fds.get(fd);
        if (!f || !f.readable) return E.BADF;
        const src = f.buffer ?? new Uint8Array(0);
        const v = this.view();
        const u = this.u8();
        let read = 0;
        for (let i = 0; i < iovsLen; i++) {
          const base = v.getUint32(iovsPtr + i * 8, true);
          const len = v.getUint32(iovsPtr + i * 8 + 4, true);
          const avail = Math.min(len, src.length - f.position);
          if (avail <= 0) break;
          u.set(src.subarray(f.position, f.position + avail), base);
          f.position += avail;
          read += avail;
        }
        v.setUint32(nreadPtr, read, true);
        return E.SUCCESS;
      },
      fd_close: (fd: number): number => {
        const f = this.fds.get(fd);
        if (!f) return E.BADF;
        if (f.type === "file" && f.dirty && f.path) {
          try {
            o.fs.writeFile(f.path, f.buffer ?? new Uint8Array(0));
          } catch (err) {
            return mapError(err);
          }
        }
        this.fds.delete(fd);
        return E.SUCCESS;
      },
      fd_seek: (fd: number, offset: number | bigint, whence: number, newOffsetPtr: number): number => {
        const f = this.fds.get(fd);
        if (!f) return E.BADF;
        const off = Number(offset);
        const size = f.buffer?.length ?? 0;
        f.position = whence === 0 ? off : whence === 1 ? f.position + off : size + off;
        this.view().setBigUint64(newOffsetPtr, BigInt(Math.max(0, f.position)), true);
        return E.SUCCESS;
      },
      fd_fdstat_get: (fd: number, bufPtr: number): number => {
        const f = this.fds.get(fd);
        if (!f) return E.BADF;
        const ft = f.type === "dir" || f.type === "preopen" ? FT.DIRECTORY : f.type === "file" ? FT.REGULAR : FT.CHAR;
        const v = this.view();
        v.setUint8(bufPtr, ft);
        v.setUint16(bufPtr + 2, 0, true);
        v.setBigUint64(bufPtr + 8, 0xffffffffffffffffn, true);
        v.setBigUint64(bufPtr + 16, 0xffffffffffffffffn, true);
        return E.SUCCESS;
      },
      fd_fdstat_set_flags: (): number => E.SUCCESS,
      fd_prestat_get: (fd: number, bufPtr: number): number => {
        const f = this.fds.get(fd);
        if (!f || f.type !== "preopen") return E.BADF;
        const v = this.view();
        v.setUint8(bufPtr, 0); // tag: dir
        v.setUint32(bufPtr + 4, encoder.encode(f.preopenName!).length, true);
        return E.SUCCESS;
      },
      fd_prestat_dir_name: (fd: number, pathPtr: number, pathLen: number): number => {
        const f = this.fds.get(fd);
        if (!f || f.type !== "preopen") return E.BADF;
        this.u8().set(encoder.encode(f.preopenName!).subarray(0, pathLen), pathPtr);
        return E.SUCCESS;
      },
      fd_filestat_get: (fd: number, bufPtr: number): number => {
        const f = this.fds.get(fd);
        if (!f || !f.path) return E.BADF;
        try {
          this.writeFilestat(bufPtr, o.fs.stat(f.path));
          return E.SUCCESS;
        } catch (err) {
          return mapError(err);
        }
      },

      path_open: (
        dirfd: number,
        _dirflags: number,
        pathPtr: number,
        pathLen: number,
        oflags: number,
        _rb: number,
        _ri: number,
        _fdflags: number,
        fdPtr: number,
      ): number => {
        const dir = this.fds.get(dirfd);
        if (!dir) return E.BADF;
        const abs = this.resolve(dir.path ?? "/", this.readString(pathPtr, pathLen));
        const fs = o.fs;
        const wantDir = (oflags & 0x2) !== 0;
        const creat = (oflags & 0x1) !== 0;
        const excl = (oflags & 0x4) !== 0;
        const trunc = (oflags & 0x8) !== 0;
        try {
          const exists = fs.exists(abs);
          if (exists && fs.stat(abs).type === "directory") {
            const fd = this.nextFd++;
            this.fds.set(fd, { type: "dir", path: abs, position: 0, readable: true, writable: false, dirty: false });
            this.view().setUint32(fdPtr, fd, true);
            return E.SUCCESS;
          }
          if (wantDir) return exists ? E.NOTDIR : E.NOENT;
          if (!exists) {
            if (!creat) return E.NOENT;
            fs.writeFile(abs, new Uint8Array(0));
          } else if (excl) {
            return E.EXIST;
          }
          const buffer = trunc ? new Uint8Array(0) : fs.readFile(abs);
          if (trunc) fs.writeFile(abs, buffer);
          const fd = this.nextFd++;
          this.fds.set(fd, { type: "file", path: abs, buffer, position: 0, readable: true, writable: true, dirty: trunc });
          this.view().setUint32(fdPtr, fd, true);
          return E.SUCCESS;
        } catch (err) {
          return mapError(err);
        }
      },
      path_filestat_get: (dirfd: number, _flags: number, pathPtr: number, pathLen: number, bufPtr: number): number => {
        const dir = this.fds.get(dirfd);
        if (!dir) return E.BADF;
        const abs = this.resolve(dir.path ?? "/", this.readString(pathPtr, pathLen));
        try {
          this.writeFilestat(bufPtr, o.fs.stat(abs));
          return E.SUCCESS;
        } catch (err) {
          return mapError(err);
        }
      },
      path_create_directory: (dirfd: number, pathPtr: number, pathLen: number): number => {
        const dir = this.fds.get(dirfd);
        if (!dir) return E.BADF;
        const abs = this.resolve(dir.path ?? "/", this.readString(pathPtr, pathLen));
        try {
          o.fs.mkdir(abs, { recursive: true });
          return E.SUCCESS;
        } catch (err) {
          return mapError(err);
        }
      },
      path_unlink_file: (dirfd: number, pathPtr: number, pathLen: number): number => {
        const dir = this.fds.get(dirfd);
        if (!dir) return E.BADF;
        const abs = this.resolve(dir.path ?? "/", this.readString(pathPtr, pathLen));
        try {
          o.fs.rm(abs);
          return E.SUCCESS;
        } catch (err) {
          return mapError(err);
        }
      },
      path_remove_directory: (dirfd: number, pathPtr: number, pathLen: number): number => {
        const dir = this.fds.get(dirfd);
        if (!dir) return E.BADF;
        const abs = this.resolve(dir.path ?? "/", this.readString(pathPtr, pathLen));
        try {
          o.fs.rm(abs, { recursive: true });
          return E.SUCCESS;
        } catch (err) {
          return mapError(err);
        }
      },

      clock_time_get: (_id: number, _precision: number, timePtr: number): number => {
        const ns = BigInt(Math.floor((o.now?.() ?? 0) * 1e6));
        this.view().setBigUint64(timePtr, ns, true);
        return E.SUCCESS;
      },
      random_get: (bufPtr: number, len: number): number => {
        const b = new Uint8Array(len);
        (o.random ?? fillRandom)(b);
        this.u8().set(b, bufPtr);
        return E.SUCCESS;
      },
      sched_yield: (): number => E.SUCCESS,
      fd_datasync: (): number => E.SUCCESS,
      fd_sync: (): number => E.SUCCESS,
      // Preview1 dirent stream: each record is a 24-byte dirent header
      // (d_next u64 | d_ino u64 | d_namlen u32 | d_type u8 + padding) followed
      // by the raw name bytes (no NUL). `cookie` is the index to resume from
      // (0 = start); each record's d_next is the cookie of the record after it.
      // Per the spec, when the buffer is too small the final record is written
      // truncated so bufused == buf_len — callers treat bufused < buf_len as
      // end-of-directory and otherwise resume with the last complete d_next.
      // Listings include "." and ".." first (both directories), matching the
      // preview1 host convention (e.g. wasmtime). d_ino is 0, consistent with
      // fd_filestat_get above (this host has no inode numbers).
      fd_readdir: (fd: number, bufPtr: number, bufLen: number, cookie: number | bigint, bufUsedPtr: number): number => {
        const f = this.fds.get(fd);
        if (!f) return E.BADF;
        if (f.type !== "dir" && f.type !== "preopen") return E.NOTDIR;
        let entries: { name: string; type: number }[];
        try {
          entries = [
            { name: ".", type: FT.DIRECTORY },
            { name: "..", type: FT.DIRECTORY },
            ...o.fs.readdir(f.path!).map((e) => ({
              name: e.name,
              type: e.type === "directory" ? FT.DIRECTORY : e.type === "symlink" ? FT.SYMLINK : FT.REGULAR,
            })),
          ];
        } catch (err) {
          return mapError(err);
        }
        const u = this.u8();
        let used = 0;
        for (let i = Number(cookie); i < entries.length && used < bufLen; i++) {
          const nameBytes = encoder.encode(entries[i]!.name);
          const record = new Uint8Array(24 + nameBytes.length);
          const rv = new DataView(record.buffer);
          rv.setBigUint64(0, BigInt(i + 1), true); // d_next
          rv.setBigUint64(8, 0n, true); // d_ino
          rv.setUint32(16, nameBytes.length, true); // d_namlen
          rv.setUint8(20, entries[i]!.type); // d_type
          record.set(nameBytes, 24);
          const n = Math.min(record.length, bufLen - used);
          u.set(record.subarray(0, n), bufPtr + used);
          used += n;
        }
        this.view().setUint32(bufUsedPtr, used, true);
        return E.SUCCESS;
      },
    };
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
