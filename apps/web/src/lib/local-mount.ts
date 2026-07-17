import type { FileSystemApi } from "@erdou/runtime-contract";

// Loose structural types for the File System Access API — mockable for tests.
export interface FileHandleLike {
  kind: "file";
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; lastModified: number }>;
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }>;
}
export interface DirHandleLike {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, FileHandleLike | DirHandleLike]>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  /** Optional only because some test doubles predate it — every real
   *  FileSystemDirectoryHandle has it. `mirrorVfsToFolder` fails fast if absent. */
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(opts?: { mode?: string }): Promise<PermissionState>;
  requestPermission?(opts?: { mode?: string }): Promise<PermissionState>;
}

// ".erdou" is session metadata written directly to the handle by folder-state.ts,
// never a project file — keep it out of the VFS and the file tree.
const SKIP = new Set([".git", "node_modules", ".erdou"]);
const joinP = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** vfsPath -> lastModified, as reported by the local disk file at last load/save/rescan. */
export type MountMtimes = Map<string, number>;

/** Load a local directory's files into the VFS under `mountPath`. Returns the file count. */
export async function loadFolderIntoVfs(
  dir: DirHandleLike,
  fs: FileSystemApi,
  mountPath: string,
  mtimes?: MountMtimes,
): Promise<number> {
  fs.mkdir(mountPath, { recursive: true });
  let count = 0;
  for await (const [name, handle] of dir.entries()) {
    if (SKIP.has(name)) continue;
    const child = joinP(mountPath, name);
    if (handle.kind === "directory") {
      count += await loadFolderIntoVfs(handle, fs, child, mtimes);
    } else {
      const file = await handle.getFile();
      fs.writeFile(child, new Uint8Array(await file.arrayBuffer()));
      mtimes?.set(child, file.lastModified);
      count++;
    }
  }
  return count;
}

/** Outcome of a folder save. `conflicts` are vfs paths that were NOT written
 *  because the disk copy changed externally since the last recorded sync
 *  (mtime mismatch) AND its bytes differ from the workspace copy — overwriting
 *  would clobber a fresh external edit (e.g. from VS Code). Callers should
 *  surface these and advise Pull-from-disk; the background rescan will pull
 *  the external edit on its next tick since the recorded mtime stays stale. */
export interface FolderSaveResult {
  written: string[];
  conflicts: string[];
}

/** A mirror save additionally deletes disk entries absent from the VFS. */
export interface FolderMirrorResult extends FolderSaveResult {
  deleted: string[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A create-less `getFileHandle` on a missing file rejects with a
 *  "NotFoundError" DOMException in the real File System Access API; test
 *  doubles and node-flavored shims throw ENOENT. Anything else is a real
 *  failure and must propagate to the caller untouched. */
function isNotFound(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "NotFoundError";
  return err instanceof Error && err.message.includes("ENOENT");
}

/** Write the VFS subtree at `vfsPath` back into the local directory (create/overwrite;
 *  does not delete files that exist only in the folder — see `mirrorVfsToFolder`).
 *  A file whose disk mtime no longer matches the recorded one is only overwritten
 *  when its bytes already equal the workspace copy; otherwise it is skipped and
 *  reported in `conflicts` (never clobber an external edit with stale VFS bytes).
 *  A workspace file DELETED on disk externally is recreated with its workspace
 *  content — the disk handle is probed without `{ create: true }` before the
 *  conflict check, so an external delete can never materialize an empty file
 *  that the check would freeze in place for the rescan to pull into the VFS.
 *  `rootSkip` — additional entry names to skip, but ONLY at the workspace root
 *  (`vfsPath === "/"`): the VM kernel's six empty bind-mount stub dirs
 *  (bin/lib/usr/proc/dev/tmp) show up in `readdir("/")` but are image-owned, not
 *  project files, so a folder save must not write them to the user's disk (they'd
 *  falsely look like real project dirs and desync a `.git`-tracked folder). A
 *  same-named directory nested deeper in the project (e.g. `/src/bin/`) is a real
 *  project dir and is never skipped. */
export async function saveVfsToFolder(
  fs: FileSystemApi,
  dir: DirHandleLike,
  vfsPath: string,
  mtimes?: MountMtimes,
  rootSkip?: ReadonlySet<string>,
): Promise<FolderSaveResult> {
  const result: FolderSaveResult = { written: [], conflicts: [] };
  for (const entry of fs.readdir(vfsPath)) {
    if (SKIP.has(entry.name)) continue;
    if (vfsPath === "/" && rootSkip?.has(entry.name)) continue;
    const child = joinP(vfsPath, entry.name);
    if (entry.type === "directory") {
      const sub = await dir.getDirectoryHandle(entry.name, { create: true });
      const nested = await saveVfsToFolder(fs, sub, child, mtimes);
      result.written.push(...nested.written);
      result.conflicts.push(...nested.conflicts);
    } else if (entry.type === "file") {
      const bytes = fs.readFile(child);
      let fh: FileHandleLike | undefined;
      if (mtimes) {
        const recorded = mtimes.get(child);
        if (recorded !== undefined) {
          // Probe WITHOUT { create: true }: creating first would resurrect an
          // externally-deleted file as an empty 0-byte handle with a fresh
          // mtime, which the check below would then misread as an external
          // edit conflict — and the next background rescan would pull the
          // empty ghost into the VFS, destroying the content in both places.
          try {
            fh = await dir.getFileHandle(entry.name);
          } catch (err) {
            if (!isNotFound(err)) throw err;
            // Deleted on disk externally while still in the workspace: fall
            // through and recreate it WITH its workspace content — the save is
            // additive by contract (deleting in the VFS + an explicit Push via
            // `mirrorVfsToFolder` is the one way to delete from disk).
          }
          if (fh) {
            const disk = await fh.getFile();
            if (disk.lastModified !== recorded) {
              // The disk copy changed externally since the last sync.
              if (!bytesEqual(new Uint8Array(await disk.arrayBuffer()), bytes)) {
                result.conflicts.push(child);
                continue;
              }
              // Same bytes — adopt the external mtime; a rewrite would only churn
              // the disk (and retrigger external file watchers) for no change.
              mtimes.set(child, disk.lastModified);
              continue;
            }
          }
        }
      }
      fh ??= await dir.getFileHandle(entry.name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(bytes);
      await writable.close();
      if (mtimes) mtimes.set(child, (await fh.getFile()).lastModified);
      result.written.push(child);
    }
  }
  return result;
}

/** Count real user files in the VFS subtree, honoring the same SKIP/rootSkip
 *  rules as `saveVfsToFolder` — the mirror-delete fail-safe input. */
function countUserFiles(fs: FileSystemApi, vfsPath: string, rootSkip?: ReadonlySet<string>): number {
  let n = 0;
  for (const entry of fs.readdir(vfsPath)) {
    if (SKIP.has(entry.name)) continue;
    if (vfsPath === "/" && rootSkip?.has(entry.name)) continue;
    if (entry.type === "directory") n += countUserFiles(fs, joinP(vfsPath, entry.name), rootSkip);
    else if (entry.type === "file") n++;
  }
  return n;
}

/** Drop every recorded mtime at `prefix` or inside it (after a disk delete). */
function dropMtimesUnder(mtimes: MountMtimes | undefined, prefix: string): void {
  if (!mtimes) return;
  const dirPrefix = `${prefix}/`;
  for (const key of [...mtimes.keys()]) {
    if (key === prefix || key.startsWith(dirPrefix)) mtimes.delete(key);
  }
}

/** Delete disk entries that no longer exist in the VFS, honoring SKIP at every
 *  level and `rootSkip` at the folder root only (same rules as the save walk —
 *  .git/node_modules/.erdou and image-owned root dirs are never touched). */
async function pruneDiskOnly(
  fs: FileSystemApi,
  dir: DirHandleLike,
  vfsPath: string,
  mtimes: MountMtimes | undefined,
  rootSkip: ReadonlySet<string> | undefined,
  deleted: string[],
): Promise<void> {
  if (!dir.removeEntry) {
    throw new Error(
      `Cannot mirror-delete in "${dir.name}": this directory handle has no removeEntry() — ` +
        `the File System Access API in this browser is too old for Push-to-disk mirroring.`,
    );
  }
  // Snapshot the listing first: deleting while iterating entries() of a live
  // FileSystemDirectoryHandle is undefined behavior.
  const diskEntries: [string, FileHandleLike | DirHandleLike][] = [];
  for await (const e of dir.entries()) diskEntries.push(e);
  const vfsTypes = new Map(fs.readdir(vfsPath).map((e) => [e.name, e.type]));
  for (const [name, handle] of diskEntries) {
    if (SKIP.has(name)) continue;
    if (vfsPath === "/" && rootSkip?.has(name)) continue;
    const child = joinP(vfsPath, name);
    if (handle.kind === "directory") {
      if (vfsTypes.get(name) === "directory") {
        await pruneDiskOnly(fs, handle, child, mtimes, rootSkip, deleted);
      } else {
        await dir.removeEntry(name, { recursive: true });
        dropMtimesUnder(mtimes, child);
        deleted.push(child);
      }
    } else if (vfsTypes.get(name) !== "file") {
      await dir.removeEntry(name);
      mtimes?.delete(child);
      deleted.push(child);
    }
  }
}

/** EXPLICIT Push-to-disk as a true mirror: `saveVfsToFolder` (create/overwrite,
 *  conflict-skipping) and then delete disk entries absent from the workspace,
 *  honoring the same SKIP/rootSkip sets. The debounced background auto-save
 *  stays the additive `saveVfsToFolder` on purpose — only a deliberate Push may
 *  delete from the user's real disk.
 *
 *  Data fail-safe: refuses outright when the workspace has zero user files —
 *  mirroring an empty workspace would delete the entire folder (e.g. after a
 *  mis-ordered mount or a cleared VFS). */
export async function mirrorVfsToFolder(
  fs: FileSystemApi,
  dir: DirHandleLike,
  mtimes?: MountMtimes,
  rootSkip?: ReadonlySet<string>,
): Promise<FolderMirrorResult> {
  if (countUserFiles(fs, "/", rootSkip) === 0) {
    throw new Error(
      `Refusing to mirror an empty workspace onto "${dir.name}" — that would delete every file in the folder. ` +
        `Pull from disk first, or add files before pushing.`,
    );
  }
  const saved = await saveVfsToFolder(fs, dir, "/", mtimes, rootSkip);
  const deleted: string[] = [];
  await pruneDiskOnly(fs, dir, "/", mtimes, rootSkip, deleted);
  return { ...saved, deleted };
}

/** Pull disk files that changed externally into the VFS. Additive — never deletes VFS files
 *  that vanished on disk. Returns the vfs paths that were pulled. */
export async function rescanFolder(
  dir: DirHandleLike,
  fs: FileSystemApi,
  mtimes: MountMtimes,
  mountPath = "/",
): Promise<string[]> {
  const pulled: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (SKIP.has(name)) continue;
    const child = joinP(mountPath, name);
    if (handle.kind === "directory") {
      pulled.push(...(await rescanFolder(handle, fs, mtimes, child)));
    } else {
      const file = await handle.getFile();
      if (mtimes.get(child) !== file.lastModified) {
        fs.writeFile(child, new Uint8Array(await file.arrayBuffer()));
        mtimes.set(child, file.lastModified);
        pulled.push(child);
      }
    }
  }
  return pulled;
}

// --- persist the directory handle so a mount survives reloads ---
const DB = "erdou-mount";
const STORE = "handles";
const KEY = "folder";

function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      let result: T;
      req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function persistHandle(handle: DirHandleLike): Promise<void> {
  await withStore("readwrite", (s) => s.put(handle, KEY));
}
export async function loadPersistedHandle(): Promise<DirHandleLike | null> {
  const h = await withStore<DirHandleLike | undefined>("readonly", (s) => s.get(KEY));
  return h ?? null;
}
export async function clearPersistedHandle(): Promise<void> {
  await withStore("readwrite", (s) => s.delete(KEY));
}
