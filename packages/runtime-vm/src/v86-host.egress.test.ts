import { describe, it, expect } from "vitest";
import { V86Host, type V86BootInputs } from "./v86-host.js";
import { EGRESS_SHIM_MARKER, type UpstreamFetch, type UpstreamResponse } from "./egress-shim.js";

function fakeFs9p(): Record<string, unknown> {
  const o: Record<string, unknown> = { inodes: [] };
  for (const m of ["GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile", "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file"]) o[m] = () => {};
  return o;
}

const SIMPLE_JSON =
  '{"files":[{"url":"https://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl"}],' +
  '"project":"https://pypi.org/simple/six/"}';

/** A fake v86 whose network_adapter serves a canned pypi simple-API response —
 *  proves boot() installs the egress shim on the REAL adapter seam (I4). */
function makeFakeHost() {
  const fetched: { url: string; init?: unknown }[] = [];
  const upstream = async (url: string, init?: unknown): Promise<UpstreamResponse> => {
    fetched.push({ url, init });
    return {
      status: 200,
      statusText: "OK",
      url,
      redirected: false,
      headers: new Headers({ "content-type": "application/vnd.pypi.simple.v1+json" }),
      body: null,
      text: async () => SIMPLE_JSON,
      arrayBuffer: async () => new TextEncoder().encode(SIMPLE_JSON).buffer,
    };
  };
  // One adapter object across boots (the real V86 makes a fresh one per
  // construction; sharing it here also exercises install idempotence).
  const adapter = {
    tcp_probe: async () => false,
    connect: () => { throw new Error("not under test"); },
    fetch: upstream,
  };
  class FakeHost extends V86Host {
    protected makeEmulator(): any {
      return {
        add_listener: (ev: string, cb: () => void) => { if (ev === "emulator-ready") cb(); },
        fs9p: fakeFs9p(),
        network_adapter: adapter,
        destroy: async () => {},
      };
    }
  }
  return { host: new FakeHost(), adapter, upstream, fetched };
}

/** A fake v86 that SWAPS its `network_adapter` for a fresh, bare-fetch object at
 *  emulator-ready — modeling the OBSERVED post-restore behavior: the live adapter
 *  the relay ends up using is NOT the one present when boot() runs the pre-ready
 *  wrap, so only the post-ready re-install reaches it. The pre-ready `preReady`
 *  object is wrapped but discarded; `postReady` is what networkAdapter() returns. */
function makeReconstructingHost() {
  const bareAdapter = (): { fetch: UpstreamFetch } => ({
    // A no-op fetch is enough — installEgressShim only wraps, never calls it.
    fetch: (async () => { throw new Error("not under test"); }) as UpstreamFetch,
  });
  const preReady = bareAdapter();
  const postReady = bareAdapter();
  const emu: any = {
    network_adapter: preReady,
    fs9p: fakeFs9p(),
    destroy: async () => {},
    add_listener(ev: string, cb: () => void) {
      // Reconstruct the adapter BEFORE signaling ready, so the live object at the
      // post-ready install (v86-host line 141) differs from the pre-ready one.
      if (ev === "emulator-ready") { emu.network_adapter = postReady; cb(); }
    },
  };
  class FakeHost extends V86Host {
    protected makeEmulator(): any { return emu; }
  }
  return { host: new FakeHost(), preReady, postReady };
}

const inputs: V86BootInputs = { bios: new ArrayBuffer(8), vgaBios: new ArrayBuffer(8), kernel: new ArrayBuffer(8), wasmUrl: "x", memoryMB: 512 };

describe("V86Host.boot installs the pypi egress shim on the NAT adapter", () => {
  it("wraps adapter.fetch at boot (marker present, original replaced)", async () => {
    const { host, upstream } = makeFakeHost();
    await host.boot(inputs);
    const f = host.networkAdapter().fetch as ((url: string) => unknown) & { [EGRESS_SHIM_MARKER]?: true };
    expect(f).not.toBe(upstream);
    expect(f[EGRESS_SHIM_MARKER]).toBe(true);
  });

  it("a pypi simple-API response comes back link-rewritten through the booted adapter (url https-upgraded in Node)", async () => {
    const { host, fetched } = makeFakeHost();
    await host.boot(inputs);
    const out = await host.networkAdapter().fetch("http://pypi.org/simple/six/");
    expect(fetched.map((c) => c.url)).toEqual(["https://pypi.org/simple/six/"]);
    const text = new TextDecoder().decode(new Uint8Array(await out.arrayBuffer()));
    expect(text).toContain("http://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl");
    expect(text).toContain("http://pypi.org/simple/six/");
    expect(text).not.toContain("https://");
  });

  it("boot after destroy() does not stack a second wrap on the same adapter", async () => {
    const { host, adapter } = makeFakeHost();
    await host.boot(inputs);
    const first = adapter.fetch;
    await host.destroy();
    await host.boot(inputs);
    expect(adapter.fetch).toBe(first);
  });

  it("re-installs on the adapter swapped in at emulator-ready (post-ready install reaches the LIVE object)", async () => {
    // Bite for the SECOND, post-emulator-ready installEgress() (v86-host line 141):
    // when the live adapter is reconstructed after the pre-ready wrap, only the
    // re-install carries the shim onto the object the relay actually uses. Reverting
    // that call leaves postReady.fetch bare → this fails.
    const { host, preReady, postReady } = makeReconstructingHost();
    await host.boot(inputs);
    expect(host.networkAdapter()).toBe(postReady); // the live adapter is the reconstructed one
    const live = postReady.fetch as UpstreamFetch & { [EGRESS_SHIM_MARKER]?: true };
    expect(live[EGRESS_SHIM_MARKER]).toBe(true);
    // The pre-ready wrap did happen (idempotent), just on the now-discarded object.
    expect((preReady.fetch as { [EGRESS_SHIM_MARKER]?: true })[EGRESS_SHIM_MARKER]).toBe(true);
  });
});
