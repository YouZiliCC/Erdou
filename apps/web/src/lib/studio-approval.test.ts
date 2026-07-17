import { describe, it, expect } from "vitest";
import { Studio } from "./studio.js";
import type { ApprovalRequest } from "@erdou/agent-core";

// `makeApprove` is the private seam that builds the agent's `approve` callback.
// We drive it directly (a "scripted approve call") so the pending-approval /
// autoAllow / notify lifecycle is exercised without a live model run.
type Internals = {
  makeApprove(mode: "auto" | "confirm"): ((req: ApprovalRequest) => Promise<"allow" | "deny">) | undefined;
  autoAllow: Set<string>;
};

const shell = (command: string): ApprovalRequest => ({ tool: "run_shell", command, args: { command } });

describe("Studio approval plumbing", () => {
  it("Auto mode passes no approve callback (autonomous behavior preserved)", () => {
    const studio = new Studio();
    expect((studio as unknown as Internals).makeApprove("auto")).toBeUndefined();
  });

  it("Confirm: parks a pendingApproval and notifies, then Allow/Deny resolves + clears", async () => {
    const studio = new Studio();
    (studio as unknown as Internals).autoAllow = new Set(); // as startRun does per run
    let notifications = 0;
    studio.subscribe(() => notifications++);
    const approve = (studio as unknown as Internals).makeApprove("confirm")!;

    // Deny path.
    const denied = approve(shell("rm -rf /"));
    expect(studio.pendingApproval?.req.command).toBe("rm -rf /");
    expect(notifications).toBe(1); // notified so the UI shows the prompt
    studio.pendingApproval!.resolve("deny");
    expect(await denied).toBe("deny");
    expect(studio.pendingApproval).toBeNull(); // cleared
    expect(notifications).toBe(2); // notified again on resolve

    // Allow path.
    const allowed = approve(shell("ls -la"));
    expect(studio.pendingApproval?.req.command).toBe("ls -la");
    studio.pendingApproval!.resolve("allow");
    expect(await allowed).toBe("allow");
    expect(studio.pendingApproval).toBeNull();
  });

  it("Confirm: switch_environment is parked for approval like other gated tools", async () => {
    const studio = new Studio();
    (studio as unknown as Internals).autoAllow = new Set();
    const approve = (studio as unknown as Internals).makeApprove("confirm")!;

    const decision = approve({ tool: "switch_environment", args: { target: "vm:node" } });
    expect(studio.pendingApproval?.req.tool).toBe("switch_environment");
    expect(studio.pendingApproval?.req.args).toEqual({ target: "vm:node" });
    studio.pendingApproval!.resolve("allow");
    expect(await decision).toBe("allow");
    expect(studio.pendingApproval).toBeNull();
  });

  it("Confirm: Always allow remembers the tool for the rest of the run", async () => {
    const studio = new Studio();
    (studio as unknown as Internals).autoAllow = new Set();
    const approve = (studio as unknown as Internals).makeApprove("confirm")!;

    const first = approve(shell("echo one"));
    studio.pendingApproval!.allowAlways();
    expect(await first).toBe("allow");
    expect(studio.pendingApproval).toBeNull();

    // A subsequent run_shell resolves immediately — no prompt is parked.
    const second = approve(shell("echo two"));
    expect(studio.pendingApproval).toBeNull();
    expect(await second).toBe("allow");
  });
});
