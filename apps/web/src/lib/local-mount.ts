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

/** Write the VFS subtree at `vfsPath` back into the local directory (create/overwrite;
 *  does not delete files that exist only in the folder). */
export async function saveVfsToFolder(
  fs: FileSystemApi,
  dir: DirHandleLike,
  vfsPath: string,
  mtimes?: MountMtimes,
): Promise<void> {
  for (const entry of fs.readdir(vfsPath)) {
    if (SKIP.has(entry.name)) continue;
    const child = joinP(vfsPath, entry.name);
    if (entry.type === "directory") {
      const sub = await dir.getDirectoryHandle(entry.name, { create: true });
      await saveVfsToFolder(fs, sub, child, mtimes);
    } else if (entry.type === "file") {
      const fh = await dir.getFileHandle(entry.name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(fs.readFile(child));
      await writable.close();
      if (mtimes) mtimes.set(child, (await fh.getFile()).lastModified);
    }
  }
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
