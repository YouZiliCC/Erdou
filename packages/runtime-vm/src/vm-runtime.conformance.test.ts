import { describe, it, expect } from "vitest";
import { runConformance } from "@erdou/conformance";
import { VmRuntime } from "./vm-runtime.js";
import { V86Host } from "./v86-host.js";
import { assetsPresent, defaultAssets, loadNodeInputs } from "./node.js";

const RUN = assetsPresent() && process.env.ERDOU_VM_E2E === "1";
const makeInputs = () => loadNodeInputs(defaultAssets());

// Gated: needs the baked asset (pnpm --filter @erdou/runtime-vm bake) AND
// ERDOU_VM_E2E=1. Keeps the default `pnpm test` hermetic and fast.
describe.skipIf(!RUN)("VmRuntime (gated e2e)", () => {
  // Each conformance test gets a FRESH VM booted from the self-contained state.
  runConformance("VmRuntime", () => new VmRuntime(makeInputs, { clock: () => 0 }));

  // VM-specific checks the shared suite doesn't cover:
  it("runs real python3 in the guest", async () => {
    const rt = new VmRuntime(makeInputs);
    await rt.boot();
    const p = await rt.exec("python3 -c 'print(6*7)'");
    expect((await p.stdout.text()).trim()).toBe("42");
    await rt.shutdown();
  });

  it("snapshot captures only the workspace, not the 37MB Alpine system", async () => {
    const rt = new VmRuntime(makeInputs);
    await rt.boot();
    await rt.writeFile("/only.txt", "x");
    const snap = await rt.createSnapshot();
    const json = JSON.stringify(snap);
    expect(json.length).toBeLessThan(100_000); // workspace-scoped, nowhere near 37MB
    expect(json).toContain("only.txt");
    await rt.shutdown();
  });

  it("kills a long-running guest process", async () => {
    const rt = new VmRuntime(makeInputs);
    await rt.boot();
    const p = await rt.exec("sleep 30");
    await rt.kill(p.pid, "SIGKILL");
    const status = await rt.wait(p.pid);
    expect(status.signal ?? status.code).toBeTruthy();
    await rt.shutdown();
  });

  it("syncFs() and the async bridge share one fs9p (a syncFs write is readable via readFile)", async () => {
    const rt = new VmRuntime(makeInputs);
    await rt.boot();
    rt.syncFs().writeFile("/sf.txt", "x");
    const data = await rt.readFile("/sf.txt");
    expect(new TextDecoder().decode(data)).toBe("x");
    await rt.shutdown();
  });

  it("restores the networked state cleanly: eth0 has 192.168.86.100", async () => {
    const rt = new VmRuntime(makeInputs);
    await rt.boot();
    // `ip` is not a standalone binary in the Alpine guest chroot's PATH; busybox
    // provides it as an applet (`busybox ip …`). This proves the restored state
    // booted with eth0 already DHCP-addressed (192.168.86.100), no per-boot setup.
    const p = await rt.exec("busybox ip -o addr show eth0");
    expect(await p.stdout.text()).toContain("192.168.86.100");
    await rt.shutdown();
  });

  it("V86Host.networkAdapter() is live after boot from the networked state", async () => {
    const host = new V86Host();
    await host.boot(await makeInputs(), { bootTimeoutMs: 30_000 });
    host.run();
    const net = host.networkAdapter();
    expect(net).toBeDefined();
    expect(typeof net.tcp_probe).toBe("function");
    expect(typeof net.connect).toBe("function");
    await host.destroy();
  });

  it("dispatch reverse-proxies to a real guest HTTP server bound to 0.0.0.0", async () => {
    const rt = new VmRuntime(makeInputs);
    await rt.boot();
    await rt.writeFile("/index.html", "hello-from-guest-dispatch");
    // Detached: exec resolves on process START; the server binds after cold-start.
    await rt.exec("python3 -m http.server 8000 --bind 0.0.0.0");
    const get = () => rt.dispatch(8000, { method: "GET", url: "/index.html", headers: {}, body: new Uint8Array() });
    let ok: import("@erdou/runtime-contract").HttpResponse | undefined;
    const deadline = Date.now() + 40_000; // python cold-start ~16s — poll generously
    while (Date.now() < deadline) {
      const r = await get();
      if (r.status === 200) { ok = r; break; }
      await new Promise((res) => setTimeout(res, 1000));
    }
    expect(ok).toBeDefined();
    expect(new TextDecoder().decode(ok!.body)).toContain("hello-from-guest-dispatch");
    // Leak fix (conn.close()): many sequential dispatches must NOT grow the
    // emulator's retained TCP-connection table. Each guest FIN parks the conn in
    // `close-wait`; dispatch()'s conn.close() completes the passive close →
    // v86 release() → delete network_adapter.tcp_conn[tuple]. Without the fix the
    // table would hold ~N entries after N dispatches (leaked forever).
    const net = (rt as unknown as { host: V86Host }).host.networkAdapter() as unknown as { tcp_conn: Record<string, unknown> };
    const N = 6;
    for (let i = 0; i < N; i++) {
      const r = await get();
      expect(r.status).toBe(200); // reuse still works after close() (fix didn't break dispatch)
    }
    // Bounded, not N: at most a couple may still be finishing their last-ack.
    expect(Object.keys(net.tcp_conn).length).toBeLessThan(N);
    // A closed port probes false → 502, no hang.
    const closed = await rt.dispatch(9999, { method: "GET", url: "/", headers: {}, body: new Uint8Array() });
    expect(closed.status).toBe(502);
    await rt.shutdown();
  }, 90_000);
});
