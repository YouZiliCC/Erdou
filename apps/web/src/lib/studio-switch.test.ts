import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio, eventsSettled } from "./studio.js";
import { Vfs, BrowserRuntime } from "@erdou/runtime-browser";
import { DEFAULT_MODEL } from "./model-config.js";
import type { Runtime, RuntimeEvent } from "@erdou/runtime-contract";

vi.mock("./local-mount.js", async (o) => ({
  ...(await o<typeof import("./local-mount.js")>()),
  persistHandle: vi.fn(async () => {}),
  loadPersistedHandle: vi.fn(async () => null),
  clearPersistedHandle: vi.fn(async () => {}),
}));

describe("Studio.switchKernel", () => {
  it("switches to a (fake) vm kernel, copies the workspace, and swaps", async () => {
    const studio = new Studio();
    await studio.boot();
    await studio.fs.mkdir?.("/p", { recursive: true });
    studio.fs.writeFile("/keep.txt", "follows-me");
    // inject a fake vm kernel with its OWN fs (distinct Vfs) so the copy is
    // actually asserted, not just a shared-reference illusion.
    const vmFs = new Vfs();
    const fakeVm = {
      kind: "vm" as const,
      runtime: studio.runtime,
      fs: vmFs,
      openShell: () => studio.shell,
      openPty: async () => ({}) as any,
    };
    await studio.switchKernel("vm", {
      makeKernel: async ({ onProgress }) => {
        onProgress?.("boot");
        return fakeVm;
      },
    });
    expect(studio.kernelKind).toBe("vm");
    // the workspace file was copied into the vm kernel's (distinct) fs
    expect(new TextDecoder().decode(studio.fs.readFile("/keep.txt"))).toBe("follows-me");
    expect(studio.fs).toBe(vmFs);
  });

  it("switching back to browser reuses the cached browser kernel and copies the workspace back", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/a.txt", "one");
    const browserFs = studio.fs;

    const vmFs = new Vfs();
    const fakeVm = {
      kind: "vm" as const,
      runtime: studio.runtime,
      fs: vmFs,
      openShell: () => studio.shell,
      openPty: async () => ({}) as any,
    };
    await studio.switchKernel("vm", { makeKernel: async () => fakeVm });
    expect(studio.kernelKind).toBe("vm");

    // Mutate in the vm kernel, then switch back — the change should follow.
    studio.fs.writeFile("/b.txt", "two");
    await studio.switchKernel("browser");
    expect(studio.kernelKind).toBe("browser");
    expect(studio.fs).toBe(browserFs);
    expect(new TextDecoder().decode(studio.fs.readFile("/a.txt"))).toBe("one");
    expect(new TextDecoder().decode(studio.fs.readFile("/b.txt"))).toBe("two");

    // Switching to "vm" again reuses the cached vm kernel (no second makeKernel call).
    const makeKernel = vi.fn(async () => fakeVm);
    await studio.switchKernel("vm", { makeKernel });
    expect(makeKernel).not.toHaveBeenCalled();
    expect(studio.fs).toBe(vmFs);
  });

  it("vm→vm (one-VM-alive): boots B, shuts the outgoing VM down LAST, copies the workspace, remounts the terminal", async () => {
    const studio = new Studio();
    await studio.boot();

    const baseFs = new Vfs();
    const baseShutdown = vi.fn(async () => {});
    const fakeBase = {
      kind: "vm" as const,
      profile: "base" as const,
      runtime: stubRuntime(),
      fs: baseFs,
      openShell: () => studio.shell,
      openPty: async () => ({}) as any,
      shutdown: baseShutdown,
    };
    await studio.switchEnvironment("vm:base", { makeKernel: async () => fakeBase });
    expect(studio.currentEnvId).toBe("vm:base");
    studio.fs.writeFile("/w.txt", "carried");
    const genBefore = studio.kernelGeneration;

    const nodeFs = new Vfs();
    const nodeShutdown = vi.fn(async () => {});
    const fakeNode = {
      kind: "vm" as const,
      profile: "node" as const,
      runtime: stubRuntime(),
      fs: nodeFs,
      openShell: () => studio.shell,
      openPty: async () => ({}) as any,
      shutdown: nodeShutdown,
    };
    const makeNode = vi.fn(async ({ profile }: { profile: string }) => {
      expect(profile).toBe("node"); // switchEnvironment resolves the target profile
      return fakeNode;
    });
    await studio.switchEnvironment("vm:node", { makeKernel: makeNode });

    expect(studio.currentEnvId).toBe("vm:node");
    expect(studio.kernelKind).toBe("vm");
    expect(makeNode).toHaveBeenCalledTimes(1);
    expect(baseShutdown).toHaveBeenCalledTimes(1); // outgoing VM torn down (one-VM-alive)
    expect(nodeShutdown).not.toHaveBeenCalled(); // the incoming VM stays alive
    // the workspace followed A → B
    expect(new TextDecoder().decode(studio.fs.readFile("/w.txt"))).toBe("carried");
    expect(studio.fs).toBe(nodeFs);
    // C2: the PTY remount key advances so TerminalPanel re-opens on the new guest.
    expect(studio.kernelGeneration).toBeGreaterThan(genBefore);
  });

  it("vm→browser KEEPS the VM cached alive (no shutdown), then reuses it on switch-back", async () => {
    const studio = new Studio();
    await studio.boot();
    const vmFs = new Vfs();
    const vmShutdown = vi.fn(async () => {});
    const fakeVm = {
      kind: "vm" as const,
      profile: "base" as const,
      runtime: stubRuntime(),
      fs: vmFs,
      openShell: () => studio.shell,
      shutdown: vmShutdown,
    };
    const makeVm = vi.fn(async () => fakeVm);
    await studio.switchEnvironment("vm:base", { makeKernel: makeVm });
    await studio.switchEnvironment("browser");
    expect(studio.kernelKind).toBe("browser");
    expect(vmShutdown).not.toHaveBeenCalled(); // vm→browser must not tear the guest down

    await studio.switchEnvironment("vm:base", { makeKernel: makeVm });
    expect(makeVm).toHaveBeenCalledTimes(1); // reused the cached guest (no re-boot)
    expect(studio.fs).toBe(vmFs);
    expect(vmShutdown).not.toHaveBeenCalled();
  });

  it("an unbaked profile fails LOUD at boot and keeps the user on the working kernel", async () => {
    const studio = new Studio();
    await studio.boot();
    const before = studio.kernelKind;
    // makeKernel is where the missing-asset boot lives — simulate its loud failure.
    await studio.switchEnvironment("vm:sci", {
      makeKernel: async () => {
        throw new Error("state-sci.zst not found — run: pnpm --filter @erdou/runtime-vm bake --profile sci");
      },
    });
    expect(studio.kernelKind).toBe(before); // unchanged — the existing catch keeps us here
    expect(studio.switchingKernel).toBeNull();
    const log = studio.systemLog.map((l) => `${l.text} ${l.detail ?? ""}`).join("\n");
    expect(log).toMatch(/bake --profile sci/);
  });

  it("is a no-op when a run is active, when already on the target kernel, or mid-switch", async () => {
    const studio = new Studio();
    await studio.boot();

    // Already on "browser": switching to "browser" is a no-op.
    await studio.switchKernel("browser");
    expect(studio.kernelKind).toBe("browser");

    // Simulate a run in progress.
    (studio as unknown as { running: boolean }).running = true;
    await studio.switchKernel("vm", { makeKernel: async () => ({ kind: "vm" as const, runtime: studio.runtime, fs: new Vfs(), openShell: () => studio.shell }) });
    expect(studio.kernelKind).toBe("browser"); // guarded: no switch while running
    (studio as unknown as { running: boolean }).running = false;
  });

  // Final-review Fix 1: the boot-await window (~40 MB fetch + boot) is long
  // enough for a run to start on the OLD kernel while switchKernel is still
  // awaiting the new one — the entry guard above only catches a run already in
  // progress at the moment the switch was requested. Close that window three
  // ways; these two tests cover the Studio-level halves (startRun/replyToRun
  // refusing to start, and switchKernel aborting the swap).
  it("startRun and replyToRun are no-ops while a kernel switch is mid-boot", async () => {
    const studio = new Studio();
    await studio.boot();

    let resolveMake: (k: unknown) => void = () => {};
    const pending = new Promise((res) => {
      resolveMake = res;
    });
    const vmFs = new Vfs();

    const switchPromise = studio.switchKernel("vm", { makeKernel: async () => pending as any });
    // switchKernel sets `switchingKernel` synchronously, before awaiting the boot.
    expect(studio.switchingKernel).not.toBeNull();

    await studio.startRun("write a file", DEFAULT_MODEL, "auto");
    expect(studio.running).toBe(false);
    expect(studio.runs.length).toBe(0); // no run was created
    expect(studio.activeRun).toBeUndefined();

    // replyToRun's guard fires before it even looks up the run.
    await studio.replyToRun("does-not-exist", "reply", DEFAULT_MODEL, "auto");
    expect(studio.running).toBe(false);

    // Resolve the switch so it finishes cleanly (no dangling promise/timer).
    resolveMake({ kind: "vm" as const, runtime: studio.runtime, fs: vmFs, openShell: () => studio.shell });
    await switchPromise;
    expect(studio.kernelKind).toBe("vm");
    expect(studio.switchingKernel).toBeNull();
  });

  it("switchKernel aborts the swap if a run starts during the boot-await window (stays on the old kernel; the booted vm is still cached for next time)", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/keep.txt", "original");
    const browserFs = studio.fs;

    let resolveMake: (k: unknown) => void = () => {};
    const pending = new Promise((res) => {
      resolveMake = res;
    });
    const vmFs = new Vfs();
    const fakeVm = { kind: "vm" as const, runtime: studio.runtime, fs: vmFs, openShell: () => studio.shell };

    const switchPromise = studio.switchKernel("vm", { makeKernel: async () => pending as any });
    // Simulate a run starting during the cold-boot await window (the race this fix closes).
    (studio as unknown as { running: boolean }).running = true;
    resolveMake(fakeVm);
    await switchPromise;

    expect(studio.kernelKind).toBe("browser"); // aborted — never swapped to the vm kernel
    expect(studio.fs).toBe(browserFs);
    expect(studio.switchingKernel).toBeNull(); // cleared by the `finally`

    // The freshly-booted vm kernel stays cached even though the swap was
    // aborted: a later switch (once the run has ended) reuses it instead of
    // booting a second one.
    (studio as unknown as { running: boolean }).running = false;
    const makeKernel = vi.fn(async () => fakeVm);
    await studio.switchKernel("vm", { makeKernel });
    expect(makeKernel).not.toHaveBeenCalled();
    expect(studio.kernelKind).toBe("vm");
    expect(studio.fs).toBe(vmFs);
  });
});

// The incoming stub only needs `subscribe` — that's all subscribeRuntime /
// setPreviewRuntime touch post-swap.
const stubRuntime = (): Runtime => ({ subscribe: () => () => {} }) as unknown as Runtime;

// M1 (S4 critical): the agent is handed a STABLE delegating Runtime whose every
// method forwards to `this.kernel.runtime` at CALL time. Capturing the concrete
// `this.runtime` once at construction (the bug) would keep every post-switch
// tool hitting the OLD kernel.
describe("Studio agent-runtime facade", () => {
  it("forwards to the active kernel at call time, not the kernel captured at construction", async () => {
    const studio = new Studio();
    await studio.boot();
    const facade = (studio as unknown as { agentRuntime: Runtime }).agentRuntime;

    // On the browser kernel: a write through the facade lands in the browser fs.
    await facade.writeFile("/on-browser.txt", "b");
    expect(studio.fs.exists("/on-browser.txt")).toBe(true);

    // Switch to a fake VM kernel with its OWN runtime + fs.
    const vmRt = new BrowserRuntime();
    await vmRt.boot();
    const vmWrite = vi.spyOn(vmRt, "writeFile");
    await studio.switchEnvironment("vm:base", {
      makeKernel: async () => ({
        kind: "vm" as const,
        profile: "base" as const,
        runtime: vmRt,
        fs: vmRt.fs,
        openShell: () => vmRt.openShell(),
        shutdown: async () => {},
      }),
    });

    // The SAME facade object now forwards to the NEW kernel's runtime.
    await facade.writeFile("/after-switch.txt", "v");
    expect(vmWrite.mock.calls.some((c) => c[0] === "/after-switch.txt" && c[1] === "v")).toBe(true);
    expect(vmRt.fs.exists("/after-switch.txt")).toBe(true);
    expect(studio.fs).toBe(vmRt.fs);
  });
});

describe("Studio.switchKernel port hygiene", () => {
  it("kills the tracked serve pid and closes tracked ports on the OUTGOING runtime, then clears them", async () => {
    const studio = new Studio();
    await studio.boot();
    const oldRuntime = studio.runtime;
    await oldRuntime.exposePort(8000); // emits port.opened → a chip in openPorts
    await eventsSettled();
    expect(studio.openPorts).toEqual([{ port: 8000 }]);
    studio.servePid = 123; // what PreviewPanel records after a detached VM serve

    const kill = vi.spyOn(oldRuntime, "kill").mockResolvedValue(undefined);
    const close = vi.spyOn(oldRuntime, "closePort");

    await studio.switchKernel("vm", {
      makeKernel: async () => ({ kind: "vm" as const, runtime: stubRuntime(), fs: new Vfs(), openShell: () => studio.shell }),
    });

    expect(studio.kernelKind).toBe("vm");
    expect(kill).toHaveBeenCalledWith(123);   // killed on the OLD runtime, pre-swap
    expect(close).toHaveBeenCalledWith(8000); // freed for a later switch-back re-serve
    expect(studio.servePid).toBeNull();
    expect(studio.openPorts).toEqual([]);     // no stale chips from the other kernel
  });

  it("port events from the NEW kernel repopulate openPorts after the switch", async () => {
    const studio = new Studio();
    await studio.boot();
    const listeners = new Set<(e: RuntimeEvent) => void>();
    const vmRuntime = {
      subscribe: (l: (e: RuntimeEvent) => void) => { listeners.add(l); return () => listeners.delete(l); },
    } as unknown as Runtime;
    await studio.switchKernel("vm", {
      makeKernel: async () => ({ kind: "vm" as const, runtime: vmRuntime, fs: new Vfs(), openShell: () => studio.shell }),
    });
    for (const l of listeners) l({ type: "port.opened", port: 5000, url: "/__port__/5000/" });
    expect(studio.openPorts).toEqual([{ port: 5000 }]);
  });

  it("an aborted swap (run started mid-boot) leaves openPorts and servePid untouched", async () => {
    const studio = new Studio();
    await studio.boot();
    await studio.runtime.exposePort(8000);
    await eventsSettled();
    studio.servePid = 123;
    const kill = vi.spyOn(studio.runtime, "kill").mockResolvedValue(undefined);

    let resolveMake: (k: unknown) => void = () => {};
    const pending = new Promise((res) => { resolveMake = res; });
    const switchPromise = studio.switchKernel("vm", { makeKernel: async () => pending as any });
    (studio as unknown as { running: boolean }).running = true;
    resolveMake({ kind: "vm" as const, runtime: stubRuntime(), fs: new Vfs(), openShell: () => studio.shell });
    await switchPromise;

    expect(studio.kernelKind).toBe("browser");
    expect(kill).not.toHaveBeenCalled();        // still-current kernel's preview untouched
    expect(studio.servePid).toBe(123);
    expect(studio.openPorts).toEqual([{ port: 8000 }]);
  });
});

// Final-review Finding 1: an in-flight preview serve is not mutually excluded
// with switchKernel — `runServeCommand` can await `port.opened` for seconds
// (VM python cold start), long enough for a switch to complete mid-flight.
// `stopTrackedServe` only sees ALREADY-recorded state (servePid is assigned on
// settle), so it kills nothing; the settle would then record the OLD kernel's
// pid against the new one. Studio owns the serve lifecycle (`runServe`) so the
// settle can be checked against the kernel captured at start.
describe("Studio.runServe vs switchKernel (serve/switch race)", () => {
  /** A realOs (VM-path) fake kernel: `exec` resolves a detached handle that
   *  never exits (a live server); the `port.opened` that settles the serve is
   *  emitted manually via `emit`, so a test controls WHEN it settles. */
  function fakeVmKernel(pid: number) {
    const listeners = new Set<(e: RuntimeEvent) => void>();
    const kill = vi.fn(async (_pid: number) => {});
    const runtime = {
      subscribe(l: (e: RuntimeEvent) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getCapabilities: async () => ({ realOs: true }),
      exec: async () => ({
        pid,
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        stdin: { write() {}, end() {} },
        wait: () => new Promise<never>(() => {}), // a live server never exits
        kill: async () => {},
      }),
      kill,
      closePort: async () => {},
    } as unknown as Runtime;
    const kernel = {
      kind: "vm" as const,
      runtime,
      fs: new Vfs(),
      openShell: () => ({
        cwd: "/",
        exec: async (): Promise<never> => {
          throw new Error("shell must not be used on the VM path");
        },
      }),
    };
    const emit = (e: RuntimeEvent): void => {
      for (const l of [...listeners]) l(e);
    };
    return { kernel, kill, emit };
  }

  it("a serve settling AFTER a switch is stale: pid killed on the CAPTURED runtime, servePid never assigned, nothing recorded", async () => {
    const studio = new Studio();
    await studio.boot();
    const vm = fakeVmKernel(4242);
    await studio.switchKernel("vm", { makeKernel: async () => vm.kernel });
    expect(studio.kernelKind).toBe("vm");

    const pending = studio.runServe("python3 -m http.server 8080 --bind 0.0.0.0 -d /dist");
    await eventsSettled(); // the detached exec + its event subscription are in place

    // The switch completes while the serve is still awaiting port.opened —
    // stopTrackedServe sees servePid === null and kills nothing (the bug's window).
    await studio.switchKernel("browser");
    expect(studio.kernelKind).toBe("browser");
    expect(vm.kill).not.toHaveBeenCalled();
    const browserKill = vi.spyOn(studio.runtime, "kill");

    // The guest server binds NOW — the detached serve settles on the OLD runtime.
    vm.emit({ type: "port.opened", port: 8080, url: "/__port__/8080/" });
    const result = await pending;

    expect(result.stale).toBe(true);
    expect(result.ok).toBe(false); // the panel records nothing for a stale result
    expect(studio.servePid).toBeNull(); // never assigned cross-kernel
    expect(vm.kill).toHaveBeenCalledTimes(1);
    expect(vm.kill).toHaveBeenCalledWith(4242); // killed on the CAPTURED (owning) runtime…
    expect(browserKill).not.toHaveBeenCalled(); // …never on the new kernel's
    expect(studio.openPorts).toEqual([]); // the old kernel's port.opened was not recorded
  });

  it("refuses to start a serve while a kernel switch is in flight (the reverse window)", async () => {
    const studio = new Studio();
    await studio.boot();
    let resolveMake: (k: unknown) => void = () => {};
    const pendingKernel = new Promise((res) => { resolveMake = res; });
    const switchPromise = studio.switchKernel("vm", { makeKernel: async () => pendingKernel as any });
    expect(studio.switchingKernel).not.toBeNull();

    const r = await studio.runServe("erdou serve / --spa");
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("switch"); // a clear refusal, not a throw
    expect(studio.servePid).toBeNull();
    expect(studio.openPorts).toEqual([]); // nothing actually ran against the outgoing kernel

    resolveMake({ kind: "vm" as const, runtime: stubRuntime(), fs: new Vfs(), openShell: () => studio.shell });
    await switchPromise;
    expect(studio.kernelKind).toBe("vm");
  });

  it("normal path: a serve settling on the still-active kernel assigns servePid and records the port (regression)", async () => {
    const studio = new Studio();
    await studio.boot();
    const vm = fakeVmKernel(777);
    await studio.switchKernel("vm", { makeKernel: async () => vm.kernel });

    const pending = studio.runServe("python3 -m http.server 8080 --bind 0.0.0.0");
    await eventsSettled();
    vm.emit({ type: "port.opened", port: 8080, url: "/__port__/8080/" });
    const result = await pending;
    await eventsSettled(); // studio's own subscription records the port

    expect(result.ok).toBe(true);
    expect(result.stale).toBeUndefined();
    expect(result.openedPorts).toEqual([8080]);
    expect(studio.servePid).toBe(777);
    expect(vm.kill).not.toHaveBeenCalled();
    expect(studio.openPorts).toEqual([{ port: 8080 }]);
  });
});
