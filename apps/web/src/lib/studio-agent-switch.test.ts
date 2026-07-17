import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio } from "./studio.js";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { ModelGateway } from "@erdou/model-gateway";
import { DEFAULT_MODEL } from "./model-config.js";
import type { Kernel } from "./kernel.js";

vi.mock("./local-mount.js", async (o) => ({
  ...(await o<typeof import("./local-mount.js")>()),
  persistHandle: vi.fn(async () => {}),
  loadPersistedHandle: vi.fn(async () => null),
  clearPersistedHandle: vi.fn(async () => {}),
}));

// A scripted model (the agent.test.ts idiom): a fake `fetch` feeding a REAL
// ModelGateway one OpenAI-shaped response per turn, so the whole agent loop
// (tool dispatch, approval gate, transcript) runs unmodified.
function toolCall(name: string, args: unknown, id = "c1"): unknown {
  return {
    choices: [
      { message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
    ],
  };
}
const final = (content: string): unknown => ({ choices: [{ message: { content } }] });
function scriptedGateway(responses: unknown[]): ModelGateway {
  let i = 0;
  const fetch = (async () => new Response(JSON.stringify(responses[i++] ?? final("done")), { status: 200 })) as typeof globalThis.fetch;
  return new ModelGateway({ fetch });
}

/** A fake VM kernel backed by a real BrowserRuntime — a working writeFile +
 *  subscribe + distinct fs — so the seeded kernel behaves like a real one and
 *  the facade/repointRunDiff plumbing is exercised for real. */
async function fakeVmKernel(profile: "base" | "node" | "sci"): Promise<Kernel> {
  const runtime = new BrowserRuntime();
  await runtime.boot();
  return {
    kind: "vm",
    profile,
    runtime,
    fs: runtime.fs,
    openShell: () => runtime.openShell(),
    shutdown: async () => {},
  };
}

describe("Studio — agent mid-run switch_environment (C2)", () => {
  it("the post-switch tool executes on the NEW runtime and its edit lands in run.changes", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/pre.txt", "seeded"); // proves the workspace follows the switch

    // Pre-seed the per-envId VM kernel cache with a FAKE vm:node kernel
    // (distinct fs + spied runtime) via the internals cast, BEFORE the run —
    // the run-initiated switch reuses it because the profile matches.
    const fakeNode = await fakeVmKernel("node");
    const nodeWrite = vi.spyOn(fakeNode.runtime, "writeFile");
    (studio as unknown as { vmKernel: Kernel | null }).vmKernel = fakeNode;
    const browserWrite = vi.spyOn(studio.runtime, "writeFile");

    (studio as unknown as { gateway: ModelGateway }).gateway = scriptedGateway([
      toolCall("switch_environment", { target: "vm:node" }),
      toolCall("write_file", { path: "/post.txt", content: "after-switch" }, "c2"),
      final("done"),
    ]);

    await studio.startRun("switch then write", DEFAULT_MODEL, "auto");

    // The agent switched to the seeded kernel.
    expect(studio.currentEnvId).toBe("vm:node");
    // The 2nd tool call executed on the SEEDED (node) runtime — the facade
    // forwards to `this.kernel.runtime` at call time (the captured-once bug
    // would have kept it on the browser runtime).
    expect(nodeWrite.mock.calls.some((c) => c[0] === "/post.txt" && c[1] === "after-switch")).toBe(true);
    expect(browserWrite.mock.calls.some((c) => c[0] === "/post.txt")).toBe(false);
    expect(fakeNode.fs.exists("/post.txt")).toBe(true);
    // The workspace followed the switch (copyWorkspace mirrored A → B).
    expect(new TextDecoder().decode(fakeNode.fs.readFile("/pre.txt"))).toBe("seeded");
    // The post-switch edit is in run.changes — proves repointRunDiff kept the
    // run-scoped diff subscription pointed at the new runtime.
    const run = studio.runs[0];
    expect(run).toBeDefined();
    expect(run!.changes.map((c) => c.path)).toContain("/post.txt");
    expect(run!.status).toBe("review");
  });

  it("Confirm mode gates the mid-run switch — the agent parks approval for switch_environment before switching", async () => {
    const studio = new Studio();
    await studio.boot();
    const fakeNode = await fakeVmKernel("node");
    (studio as unknown as { vmKernel: Kernel | null }).vmKernel = fakeNode;

    (studio as unknown as { gateway: ModelGateway }).gateway = scriptedGateway([
      toolCall("switch_environment", { target: "vm:node" }),
      final("switched after approval"),
    ]);

    // Resolve the approval the moment it is parked, recording which tool was
    // gated — proves switch_environment reaches the approval gate at all.
    let gatedTool: string | undefined;
    studio.subscribe(() => {
      const p = studio.pendingApproval;
      if (p && gatedTool === undefined) {
        gatedTool = p.req.tool;
        p.resolve("allow");
      }
    });

    await studio.startRun("switch", DEFAULT_MODEL, "confirm");
    expect(gatedTool).toBe("switch_environment"); // switch_environment is in GATED_TOOLS
    expect(studio.currentEnvId).toBe("vm:node"); // …and the switch proceeded after Allow
  });

  it("a foreign (UI) switchEnvironment is refused while a run is active — the tool callback is the ONLY sanctioned mid-run switch", async () => {
    const studio = new Studio();
    await studio.boot();
    (studio as unknown as { running: boolean }).running = true;
    await studio.switchEnvironment("vm:base", {
      makeKernel: async () => {
        throw new Error("must not boot — UI switch is refused while running");
      },
    });
    expect(studio.currentEnvId).toBe("browser"); // unchanged; makeKernel never called
    (studio as unknown as { running: boolean }).running = false;
  });

  it("a failed mid-run switch throws (→ tool reports ok:false), clears state, and leaves the current kernel intact", async () => {
    const studio = new Studio();
    await studio.boot();
    // Simulate the unbaked-image boot failure from inside the run-initiated path.
    const failingMake = vi.fn(async () => {
      throw new Error("state-sci.zst not found — run: pnpm --filter @erdou/runtime-vm bake --profile sci");
    });
    const forRun = (
      studio as unknown as {
        switchEnvironmentForRun(t: string, m?: () => Promise<Kernel>): Promise<string>;
      }
    ).switchEnvironmentForRun.bind(studio);

    await expect(forRun("vm:sci", failingMake)).rejects.toThrow(/bake --profile sci/);
    expect(studio.currentEnvId).toBe("browser"); // current kernel untouched
    expect(studio.switchingKernel).toBeNull(); // cleared, not stuck mid-switch
  });
});
