import type { V86BootInputs } from "./v86-host.js";

export interface IdbBlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  keys(): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface BrowserAssetOptions {
  baseUrl: string;      // dir holding seabios.bin/vgabios.bin/kernel.bin/state.zst
  wasmUrl: string;      // served v86.wasm (pass new URL("...v86.wasm", import.meta.url).href)
  version: string;      // cache key for the state blob; bump on re-bake
  memoryMB?: number;    // default 512 (must equal the baked state's)
  fetchImpl?: typeof fetch;
  idb?: IdbBlobStore;   // default openIdbBlobStore()
}

/** Inflate a gzip blob using the native DecompressionStream. */
export async function decompressGzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchBytes(f: typeof fetch, url: string): Promise<Uint8Array> {
  const r = await f(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Load browser boot inputs: state.zst is cache-first (IndexedDB, by version) then
 *  gzip-decompressed; bios/kernel are small and fetched fresh each boot. */
export async function loadBrowserInputs(opts: BrowserAssetOptions): Promise<V86BootInputs> {
  const f = opts.fetchImpl ?? fetch;
  const idb = opts.idb ?? openIdbBlobStore();
  const stateKey = `state:${opts.version}`;

  let stateGz = await idb.get(stateKey);
  let state: Uint8Array | undefined;
  if (stateGz) {
    try {
      state = await decompressGzip(stateGz);
    } catch {
      await idb.delete(stateKey).catch(() => {}); // poisoned cache — re-fetch
      stateGz = null;
    }
  }
  if (!stateGz) {
    stateGz = await fetchBytes(f, `${opts.baseUrl}/state.zst`);
    state = await decompressGzip(stateGz);
    await idb.put(stateKey, stateGz).catch(() => {}); // caching is best-effort
    for (const k of await idb.keys().catch(() => [])) { // evict other versions
      if (k.startsWith("state:") && k !== stateKey) await idb.delete(k).catch(() => {});
    }
  }
  const [bios, vga, kernel] = await Promise.all([
    fetchBytes(f, `${opts.baseUrl}/seabios.bin`),
    fetchBytes(f, `${opts.baseUrl}/vgabios.bin`),
    fetchBytes(f, `${opts.baseUrl}/kernel.bin`),
  ]);
  const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
  return { bios: ab(bios), vgaBios: ab(vga), kernel: ab(kernel), state: ab(state!), wasmUrl: opts.wasmUrl, memoryMB: opts.memoryMB ?? 512 };
}

/** A real IndexedDB-backed blob store (browser only). */
export function openIdbBlobStore(dbName = "erdou-vm-assets"): IdbBlobStore {
  const STORE = "blobs";
  const open = (): Promise<IDBDatabase> =>
    new Promise((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const tx = <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then((db) => new Promise<T>((res, rej) => {
      const t = db.transaction(STORE, mode);
      const rq = run(t.objectStore(STORE));
      let out: T;
      rq.onsuccess = () => (out = rq.result);
      t.oncomplete = () => { db.close(); res(out); };
      t.onerror = () => rej(t.error);
    }));
  return {
    async get(key) { const v = await tx<ArrayBuffer | undefined>("readonly", (s) => s.get(key)); return v ? new Uint8Array(v) : null; },
    async put(key, data) { await tx("readwrite", (s) => s.put(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), key)); },
    async keys() { return (await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys())) as string[]; },
    async delete(key) { await tx("readwrite", (s) => s.delete(key)); },
  };
}
