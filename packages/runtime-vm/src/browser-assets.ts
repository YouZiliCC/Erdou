import type { V86BootInputs } from "./v86-host.js";

export interface IdbBlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  keys(): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface BrowserAssetOptions {
  baseUrl: string;      // dir holding seabios.bin/vgabios.bin/kernel.bin/state-<profile>.zst
  wasmUrl: string;      // served v86.wasm (pass new URL("...v86.wasm", import.meta.url).href)
  profile: string;      // VM image profile — selects state-<profile>.zst and its cache lineage
  version: string;      // cache key for the state blob; bump on re-bake
  /** When set, a cache-miss fetch first checks (baseUrl)/state-<profile>.meta.json
   *  and throws unless its `version` (and stamped `profile`) equal these — binds
   *  the fetched BYTES to the cache key, so a stale or cross-linked on-disk state
   *  image (assets are gitignored) fail-fasts instead of being cached under the
   *  new key forever. Cache hits skip the check (validated when written). */
  expectedStateVersion?: string;
  memoryMB?: number;    // default 512 (must equal the baked state's)
  /** Byte progress for the state-blob download (cache-miss path only): called
   *  after every network chunk with cumulative bytes received; totalBytes is
   *  the Content-Length, or null when the server omits it. Not throttled —
   *  UI-facing callers rate-limit their own rendering. */
  onStateDownload?: (loadedBytes: number, totalBytes: number | null) => void;
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

/** Stream a large download chunk-by-chunk, reporting cumulative bytes so a
 *  40-90MB state blob shows byte progress instead of a silent arrayBuffer()
 *  stall. Fail-fast on a bodyless response — this path MUST stream. */
async function fetchStateBytes(
  f: typeof fetch,
  url: string,
  onChunk?: (loadedBytes: number, totalBytes: number | null) => void,
): Promise<Uint8Array> {
  const r = await f(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  if (!r.body) throw new Error(`fetch ${url} -> ${r.status} but the response has no body stream to read`);
  const rawLen = r.headers.get("content-length");
  const total = rawLen !== null && /^\d+$/.test(rawLen) ? Number(rawLen) : null;
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onChunk?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Load browser boot inputs: state-<profile>.zst is cache-first (IndexedDB, by
 *  profile:version) then gzip-decompressed; bios/kernel are small and fetched
 *  fresh each boot. */
export async function loadBrowserInputs(opts: BrowserAssetOptions): Promise<V86BootInputs> {
  const f = opts.fetchImpl ?? fetch;
  const idb = opts.idb ?? openIdbBlobStore();
  const stateFile = `state-${opts.profile}`;
  const stateKey = `state:${opts.profile}:${opts.version}`;

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
    const bakeHint = `re-run \`pnpm --filter @erdou/runtime-vm bake --profile ${opts.profile}\` before booting`;
    if (opts.expectedStateVersion !== undefined) {
      let meta: { version?: string; profile?: string };
      try {
        meta = JSON.parse(new TextDecoder().decode(await fetchBytes(f, `${opts.baseUrl}/${stateFile}.meta.json`))) as { version?: string; profile?: string };
      } catch (e) { // 404 / SPA index fallback must still explain the fix, not just fail
        throw new Error(
          `cannot verify ${stateFile}.zst version — ${stateFile}.meta.json unreadable (${e instanceof Error ? e.message : String(e)}): ` +
          `stale or unlinked assets — ${bakeHint}`,
        );
      }
      if (meta.version !== opts.expectedStateVersion) {
        throw new Error(
          `${stateFile}.meta.json version ${JSON.stringify(meta.version ?? null)} != expected ${JSON.stringify(opts.expectedStateVersion)}: ` +
          `stale ${stateFile}.zst on disk — ${bakeHint}`,
        );
      }
      if (meta.profile !== opts.profile) { // bakes stamp their profile — catches cross-linked files
        throw new Error(
          `${stateFile}.meta.json is a profile ${JSON.stringify(meta.profile ?? null)} bake, expected ${JSON.stringify(opts.profile)}: ` +
          `cross-linked assets — ${bakeHint}`,
        );
      }
    }
    stateGz = await fetchStateBytes(f, `${opts.baseUrl}/${stateFile}.zst`, opts.onStateDownload);
    state = await decompressGzip(stateGz);
    await idb.put(stateKey, stateGz).catch(() => {}); // caching is best-effort
    for (const k of await idb.keys().catch(() => [])) {
      // Evict ONLY this profile's stale versions — sibling profiles' ~40MB blobs
      // survive a cross-profile switch (per-lineage cache, ≤3 blobs by design).
      // Also a one-time sweep of the pre-R13 2-part `state:<version>` key, which
      // would otherwise pin ~40MB forever.
      const stale = (k.startsWith(`state:${opts.profile}:`) && k !== stateKey) || /^state:[^:]+$/.test(k);
      if (stale) await idb.delete(k).catch(() => {});
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
