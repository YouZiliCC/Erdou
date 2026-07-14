import type { FileSystemApi } from "@erdou/runtime-contract";

// Loose structural types for the File System Access API — mockable for tests.
export interface FileHandleLike {
  kind: "file";
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
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

const SKIP = new Set([".git", "node_modules"]);
const joinP = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** Load a local directory's files into the VFS under `mountPath`. Returns the file count. */
export async function loadFolderIntoVfs(dir: DirHandleLike, fs: FileSystemApi, mountPath: string): Promise<number> {
  fs.mkdir(mountPath, { recursive: true });
  let count = 0;
  for await (const [name, handle] of dir.entries()) {
    if (SKIP.has(name)) continue;
    const child = joinP(mountPath, name);
    if (handle.kind === "directory") {
      count += await loadFolderIntoVfs(handle, fs, child);
    } else {
      const file = await handle.getFile();
      fs.writeFile(child, new Uint8Array(await file.arrayBuffer()));
      count++;
    }
  }
  return count;
}

/** Write the VFS subtree at `vfsPath` back into the local directory (create/overwrite;
 *  does not delete files that exist only in the folder). */
export async function saveVfsToFolder(fs: FileSystemApi, dir: DirHandleLike, vfsPath: string): Promise<void> {
  for (const entry of fs.readdir(vfsPath)) {
    if (SKIP.has(entry.name)) continue;
    const child = joinP(vfsPath, entry.name);
    if (entry.type === "directory") {
      const sub = await dir.getDirectoryHandle(entry.name, { create: true });
      await saveVfsToFolder(fs, sub, child);
    } else if (entry.type === "file") {
      const fh = await dir.getFileHandle(entry.name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(fs.readFile(child));
      await writable.close();
    }
  }
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
