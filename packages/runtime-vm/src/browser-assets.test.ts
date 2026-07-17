import { describe, it, expect, vi } from "vitest";
import { loadBrowserInputs, type IdbBlobStore } from "./browser-assets.js";

function fakeIdb(): IdbBlobStore & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, d) { store.set(k, d); },
    async keys() { return [...store.keys()]; },
    async delete(k) { store.delete(k); },
  };
}

// A tiny gzip of "STATE" so DecompressionStream has something real to inflate.
// (Built once with node:zlib in the test setup — see below.)
import { gzipSync } from "node:zlib";
const STATE_RAW = new TextEncoder().encode("STATE-BYTES");
const STATE_GZ = new Uint8Array(gzipSync(STATE_RAW));

// Real Response objects: the state fetch streams via res.body.getReader(), so
// a bare { ok, arrayBuffer } stub is no longer enough. Map values may also be
// a Response factory for tests that need custom chunking/headers.
function fakeFetch(map: Record<string, Uint8Array | (() => Response)>): typeof fetch {
  return (async (url: string) => {
    const key = String(url);
    const body = map[key.slice(key.lastIndexOf("/") + 1)];
    if (!body) return new Response(null, { status: 404 });
    return typeof body === "function" ? body() : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

/** A 200 Response whose body arrives as the given chunks (one read() each). */
function chunkedResponse(chunks: Uint8Array[], contentLength?: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
  });
  return new Response(stream, {
    status: 200,
    headers: contentLength !== undefined ? { "content-length": String(contentLength) } : {},
  });
}

describe("loadBrowserInputs", () => {
  const assets = {
    "seabios.bin": new Uint8Array([1, 2]),
    "vgabios.bin": new Uint8Array([3, 4]),
    "kernel.bin": new Uint8Array([5, 6]),
    "state-base.zst": STATE_GZ,
  };

  it("fetches + gzip-decompresses state-<profile>.zst and returns V86BootInputs", async () => {
    const idb = fakeIdb();
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
      fetchImpl: fakeFetch(assets), idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(new Uint8Array(inputs.kernel)).toEqual(assets["kernel.bin"]);
    expect(inputs.wasmUrl).toBe("https://x/v86.wasm");
    expect(inputs.memoryMB).toBe(512);
    // the compressed state got cached under the 3-part profile:version key
    expect(idb.store.get("state:base:v1")).toEqual(STATE_GZ);
  });

  it("serves the state from IndexedDB on a second load without fetching state-<profile>.zst", async () => {
    const idb = fakeIdb();
    idb.store.set("state:base:v1", STATE_GZ);
    const fetchSpy = vi.fn(fakeFetch({ ...assets, "state-base.zst": new Uint8Array() })); // state fetch would give empty
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
      fetchImpl: fetchSpy as unknown as typeof fetch, idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW); // decompressed from cache, not the empty fetch
    const fetchedState = fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("state-base.zst"));
    expect(fetchedState).toBe(false);
  });

  it("re-fetches when the cached blob is corrupt (decompress fails), then repairs the cache", async () => {
    const idb = fakeIdb();
    idb.store.set("state:base:v1", new Uint8Array([0, 1, 2, 3])); // not valid gzip
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
      fetchImpl: fakeFetch(assets), idb, // fakeFetch returns the REAL gzip for state-base.zst
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW); // recovered from the network
    expect(idb.store.get("state:base:v1")).toEqual(STATE_GZ); // cache repaired
  });

  it("evicts only SAME-profile stale versions on put — sibling profiles survive", async () => {
    const idb = fakeIdb();
    idb.store.set("state:base:old", new Uint8Array([9])); // same lineage, older bake
    idb.store.set("state:node:v9", new Uint8Array([8]));  // sibling profile — ~40MB in real life, must survive
    idb.store.set("state:sci:v9", new Uint8Array([7]));
    await loadBrowserInputs({ baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1", fetchImpl: fakeFetch(assets), idb });
    expect(idb.store.has("state:base:old")).toBe(false); // old same-profile version evicted
    expect(idb.store.has("state:base:v1")).toBe(true);
    expect(idb.store.has("state:node:v9")).toBe(true);   // siblings untouched
    expect(idb.store.has("state:sci:v9")).toBe(true);
  });

  it("sweeps legacy pre-R13 2-part state:<version> keys on put (would pin ~40MB forever)", async () => {
    const idb = fakeIdb();
    idb.store.set("state:alpine-3.24.1-r12-lo-baked", new Uint8Array([9]));
    await loadBrowserInputs({ baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1", fetchImpl: fakeFetch(assets), idb });
    expect(idb.store.has("state:alpine-3.24.1-r12-lo-baked")).toBe(false);
    expect(idb.store.has("state:base:v1")).toBe(true);
  });

  const metaOf = (m: object): Uint8Array => new TextEncoder().encode(JSON.stringify(m));

  it("fail-fasts on a meta version mismatch (stale state image) without caching anything", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state-base.meta.json": metaOf({ version: "v1-old-bake", profile: "base" }) }), idb,
    })).rejects.toThrow(/stale state-base\.zst on disk.*pnpm --filter @erdou\/runtime-vm bake --profile base/);
    expect(idb.store.size).toBe(0); // the old bytes must NOT land under the new key
  });

  it("fail-fasts on a meta PROFILE mismatch (cross-linked assets) without caching anything", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state-base.meta.json": metaOf({ version: "v2", profile: "node" }) }), idb,
    })).rejects.toThrow(/profile "node".*expected "base".*bake --profile base/);
    expect(idb.store.size).toBe(0);
  });

  it("fail-fasts when state-<profile>.meta.json has no version field and expectedStateVersion is set", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state-base.meta.json": metaOf({ alpine: "3.24.1" }) }), idb,
    })).rejects.toThrow(/stale state-base\.zst on disk/);
    expect(idb.store.size).toBe(0);
  });

  it("surfaces the instructive re-bake error when the meta fetch 404s (unlinked/misconfigured assets)", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch(assets), idb, // no state-base.meta.json served -> fetch 404s
    })).rejects.toThrow(/re-run `pnpm --filter @erdou\/runtime-vm bake --profile base`/);
    expect(idb.store.size).toBe(0);
  });

  it("surfaces the instructive re-bake error when the meta body is not JSON (SPA index fallback)", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state-base.meta.json": new TextEncoder().encode("<!doctype html>") }), idb,
    })).rejects.toThrow(/re-run `pnpm --filter @erdou\/runtime-vm bake --profile base`/);
    expect(idb.store.size).toBe(0);
  });

  it("caches and boots as before when the meta version + profile match", async () => {
    const idb = fakeIdb();
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state-base.meta.json": metaOf({ version: "v2", profile: "base" }) }), idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(idb.store.get("state:base:v2")).toEqual(STATE_GZ);
  });

  it("loads sibling profiles from their own files and keys", async () => {
    const idb = fakeIdb();
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "node", version: "n1",
      fetchImpl: fakeFetch({ ...assets, "state-node.zst": STATE_GZ }), idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(idb.store.get("state:node:n1")).toEqual(STATE_GZ);
  });

  it("skips the meta check on a cache hit (validated when written)", async () => {
    const idb = fakeIdb();
    idb.store.set("state:base:v2", STATE_GZ);
    const fetchSpy = vi.fn(fakeFetch(assets)); // no state-base.meta.json served — a meta fetch would 404-throw
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fetchSpy as unknown as typeof fetch, idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("state-base.meta.json"))).toBe(false);
  });

  it("does not fetch the meta when expectedStateVersion is not set (old behavior)", async () => {
    const idb = fakeIdb();
    const fetchSpy = vi.fn(fakeFetch(assets)); // no state-base.meta.json served
    await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
      fetchImpl: fetchSpy as unknown as typeof fetch, idb,
    });
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("state-base.meta.json"))).toBe(false);
    expect(idb.store.get("state:base:v1")).toEqual(STATE_GZ);
  });

  describe("state download progress (onStateDownload)", () => {
    const gzChunks = [STATE_GZ.slice(0, 5), STATE_GZ.slice(5, 9), STATE_GZ.slice(9)];

    it("streams the state blob and reports cumulative bytes with the Content-Length total", async () => {
      const idb = fakeIdb();
      const onStateDownload = vi.fn();
      const inputs = await loadBrowserInputs({
        baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
        fetchImpl: fakeFetch({ ...assets, "state-base.zst": () => chunkedResponse(gzChunks, STATE_GZ.byteLength) }),
        idb, onStateDownload,
      });
      // one callback per chunk, cumulative bytes, constant total from Content-Length
      expect(onStateDownload.mock.calls).toEqual([
        [5, STATE_GZ.byteLength],
        [9, STATE_GZ.byteLength],
        [STATE_GZ.byteLength, STATE_GZ.byteLength],
      ]);
      // the streamed bytes reassemble losslessly: decompress + cache both see the full blob
      expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
      expect(idb.store.get("state:base:v1")).toEqual(STATE_GZ);
    });

    it("reports a null total when Content-Length is missing — bytes still stream intact", async () => {
      const idb = fakeIdb();
      const onStateDownload = vi.fn();
      const inputs = await loadBrowserInputs({
        baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
        fetchImpl: fakeFetch({ ...assets, "state-base.zst": () => chunkedResponse(gzChunks) }),
        idb, onStateDownload,
      });
      expect(onStateDownload.mock.calls).toEqual([[5, null], [9, null], [STATE_GZ.byteLength, null]]);
      expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
      expect(idb.store.get("state:base:v1")).toEqual(STATE_GZ);
    });

    it("never fires on a cache hit (nothing is downloaded)", async () => {
      const idb = fakeIdb();
      idb.store.set("state:base:v1", STATE_GZ);
      const onStateDownload = vi.fn();
      await loadBrowserInputs({
        baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
        fetchImpl: fakeFetch(assets), idb, onStateDownload,
      });
      expect(onStateDownload).not.toHaveBeenCalled();
    });

    it("fail-fasts with the URL when an ok response has no body stream", async () => {
      const idb = fakeIdb();
      await expect(loadBrowserInputs({
        baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", profile: "base", version: "v1",
        fetchImpl: fakeFetch({ ...assets, "state-base.zst": () => new Response(null, { status: 200 }) }), idb,
      })).rejects.toThrow(/state-base\.zst -> 200 but the response has no body stream/);
    });
  });
});
