import { describe, it, expect, vi } from "vitest";
import { loadBrowserInputs, type IdbBlobStore } from "./browser-assets.js";

function fakeIdb(): IdbBlobStore & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return { store, async get(k) { return store.get(k) ?? null; }, async put(k, d) { store.set(k, d); } };
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
});
