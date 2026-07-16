import { describe, it, expect } from "vitest";
import { runConformance } from "@erdou/conformance";
import { VmRuntime } from "./vm-runtime.js";
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
});
