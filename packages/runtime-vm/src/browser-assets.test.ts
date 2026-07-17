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

function fakeFetch(map: Record<string, Uint8Array>): typeof fetch {
  return (async (url: string) => {
    const key = String(url);
    const body = map[key.slice(key.lastIndexOf("/") + 1)];
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } as Response;
  }) as unknown as typeof fetch;
}

describe("loadBrowserInputs", () => {
  const assets = {
    "seabios.bin": new Uint8Array([1, 2]),
    "vgabios.bin": new Uint8Array([3, 4]),
    "kernel.bin": new Uint8Array([5, 6]),
    "state.zst": STATE_GZ,
  };

  it("fetches + gzip-decompresses the state and returns V86BootInputs", async () => {
    const idb = fakeIdb();
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1",
      fetchImpl: fakeFetch(assets), idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(new Uint8Array(inputs.kernel)).toEqual(assets["kernel.bin"]);
    expect(inputs.wasmUrl).toBe("https://x/v86.wasm");
    expect(inputs.memoryMB).toBe(512);
    // the compressed state got cached under the version key
    expect(idb.store.get("state:v1")).toEqual(STATE_GZ);
  });

  it("serves the state from IndexedDB on a second load without fetching state.zst", async () => {
    const idb = fakeIdb();
    idb.store.set("state:v1", STATE_GZ);
    const fetchSpy = vi.fn(fakeFetch({ ...assets, "state.zst": new Uint8Array() })); // state fetch would give empty
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1",
      fetchImpl: fetchSpy as unknown as typeof fetch, idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW); // decompressed from cache, not the empty fetch
    const fetchedState = fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("state.zst"));
    expect(fetchedState).toBe(false);
  });

  it("re-fetches when the cached blob is corrupt (decompress fails), then repairs the cache", async () => {
    const idb = fakeIdb();
    idb.store.set("state:v1", new Uint8Array([0, 1, 2, 3])); // not valid gzip
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1",
      fetchImpl: fakeFetch(assets), idb, // fakeFetch returns the REAL gzip for state.zst
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW); // recovered from the network
    expect(idb.store.get("state:v1")).toEqual(STATE_GZ);      // cache repaired
  });

  it("evicts stale state:<version> keys on put", async () => {
    const idb = fakeIdb();
    idb.store.set("state:old", new Uint8Array([9]));
    await loadBrowserInputs({ baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1", fetchImpl: fakeFetch(assets), idb });
    expect(idb.store.has("state:old")).toBe(false); // old version evicted
    expect(idb.store.has("state:v1")).toBe(true);
  });

  const metaOf = (m: object): Uint8Array => new TextEncoder().encode(JSON.stringify(m));

  it("fail-fasts on a meta version mismatch (stale state.zst) without caching anything", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state.meta.json": metaOf({ version: "v1-old-bake" }) }), idb,
    })).rejects.toThrow(/stale state\.zst on disk.*pnpm --filter @erdou\/runtime-vm bake/);
    expect(idb.store.size).toBe(0); // the old bytes must NOT land under the new key
  });

  it("fail-fasts when state.meta.json has no version field and expectedStateVersion is set", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state.meta.json": metaOf({ alpine: "3.24.1" }) }), idb,
    })).rejects.toThrow(/stale state\.zst on disk/);
    expect(idb.store.size).toBe(0);
  });

  it("surfaces the instructive re-bake error when the meta fetch 404s (unlinked/misconfigured assets)", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch(assets), idb, // no state.meta.json served -> fetch 404s
    })).rejects.toThrow(/re-run `pnpm --filter @erdou\/runtime-vm bake`/);
    expect(idb.store.size).toBe(0);
  });

  it("surfaces the instructive re-bake error when the meta body is not JSON (SPA index fallback)", async () => {
    const idb = fakeIdb();
    await expect(loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state.meta.json": new TextEncoder().encode("<!doctype html>") }), idb,
    })).rejects.toThrow(/re-run `pnpm --filter @erdou\/runtime-vm bake`/);
    expect(idb.store.size).toBe(0);
  });

  it("caches and boots as before when the meta version matches", async () => {
    const idb = fakeIdb();
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fakeFetch({ ...assets, "state.meta.json": metaOf({ version: "v2" }) }), idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(idb.store.get("state:v2")).toEqual(STATE_GZ);
  });

  it("skips the meta check on a cache hit (validated when written)", async () => {
    const idb = fakeIdb();
    idb.store.set("state:v2", STATE_GZ);
    const fetchSpy = vi.fn(fakeFetch(assets)); // no state.meta.json served — a meta fetch would 404-throw
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v2", expectedStateVersion: "v2",
      fetchImpl: fetchSpy as unknown as typeof fetch, idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("state.meta.json"))).toBe(false);
  });

  it("does not fetch state.meta.json when expectedStateVersion is not set (old behavior)", async () => {
    const idb = fakeIdb();
    const fetchSpy = vi.fn(fakeFetch(assets)); // no state.meta.json served
    await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1",
      fetchImpl: fetchSpy as unknown as typeof fetch, idb,
    });
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("state.meta.json"))).toBe(false);
    expect(idb.store.get("state:v1")).toEqual(STATE_GZ);
  });
});
