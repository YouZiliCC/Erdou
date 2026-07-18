// Hermetic tests for the asset ensure/verify contract (scripts/lib/
// ensure-asset.mjs — plain JS so download-assets.mjs can import it without
// tsx; vitest only collects src/**, hence this file lives here). Locks the
// reproducible-clone guarantees: a present blob is verified in place, a
// missing blob is fetched + sha256-checked + atomically installed, bad
// downloaded bytes delete the temp and never create the dest, bad staged
// bytes fail loudly but stay for inspection, and re-runs are idempotent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore — untyped plain-JS helper (scripts/, outside the TS program)
import { ensureAsset, sha256Hex } from "../scripts/lib/ensure-asset.mjs";

const GOOD = Buffer.from("pinned kernel bytes");
const GOOD_SHA = sha256Hex(GOOD) as string;
const BAD = Buffer.from("corrupted mirror bytes");
const BAD_SHA = sha256Hex(BAD) as string;
const URL_ = "https://pin.example/kernel.bin";

let dir: string;
let dest: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erdou-vm-assets-"));
  dest = path.join(dir, "kernel.bin");
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ensureAsset", () => {
  it("downloads a missing blob, verifies, and atomically installs it (no temp left)", async () => {
    const fetchMock = vi.fn(async () => new Response(GOOD));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureAsset({ dest, url: URL_, sha256: GOOD_SHA })).resolves.toBe("downloaded");
    expect(fetchMock).toHaveBeenCalledWith(URL_);
    expect(fs.readFileSync(dest)).toEqual(GOOD);
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
  });

  it("verifies a present blob in place without fetching, and re-runs are idempotent", async () => {
    const fetchMock = vi.fn(async () => new Response(GOOD));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureAsset({ dest, url: URL_, sha256: GOOD_SHA })).resolves.toBe("downloaded");
    await expect(ensureAsset({ dest, url: URL_, sha256: GOOD_SHA })).resolves.toBe("verified");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bad downloaded bytes: deletes the temp, never creates dest, reports both hashes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(BAD)));
    await expect(ensureAsset({ dest, url: URL_, sha256: GOOD_SHA })).rejects.toThrow(
      new RegExp(`E_ASSET_HASH.*${GOOD_SHA}.*${BAD_SHA}`)
    );
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
  });

  it("bad staged bytes: fails loudly with both hashes, keeps the file for inspection", async () => {
    fs.writeFileSync(dest, BAD);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(GOOD)));
    await expect(ensureAsset({ dest, url: URL_, sha256: GOOD_SHA })).rejects.toThrow(
      new RegExp(`E_ASSET_HASH.*staged.*${GOOD_SHA}.*${BAD_SHA}`)
    );
    expect(fs.readFileSync(dest)).toEqual(BAD);
  });

  it("missing blob with no pinned url errors with a manifest pointer", async () => {
    await expect(ensureAsset({ dest, url: undefined, sha256: GOOD_SHA })).rejects.toThrow(/E_ASSET_URL.*manifest/);
  });

  it("missing sha256 pin refuses to fetch at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureAsset({ dest, url: URL_, sha256: "" })).rejects.toThrow(/E_ASSET_PIN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("non-2xx fetch fails with the status, nothing written", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(ensureAsset({ dest, url: URL_, sha256: GOOD_SHA })).rejects.toThrow(/E_ASSET_FETCH.*404/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
  });
});
