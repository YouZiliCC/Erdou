import { describe, it, expect } from "vitest";
import { V86Host, type V86BootInputs } from "./v86-host.js";
import { EGRESS_SHIM_MARKER, type UpstreamResponse } from "./egress-shim.js";

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
});
