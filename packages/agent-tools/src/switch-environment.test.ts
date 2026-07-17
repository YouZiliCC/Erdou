import { describe, it, expect, vi } from "vitest";
import { createSwitchEnvironmentTool } from "./switch-environment.js";
import type { ToolContext } from "./types.js";

// The tool never touches ctx.runtime — the switch is performed by the app-bound callback.
const ctx = {} as ToolContext;
const environments = ["browser", "vm:base", "vm:node"];

describe("createSwitchEnvironmentTool", () => {
  it("shapes the ToolDef: name, target enum schema, when-to-switch + workspace-follows description", () => {
    const tool = createSwitchEnvironmentTool(async () => "", { environments });
    expect(tool.name).toBe("switch_environment");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        target: { type: "string", enum: environments, description: expect.any(String) },
      },
      required: ["target"],
    });
    expect(tool.description).toMatch(/workspace/i);
    expect(tool.description).toContain("browser, vm:base, vm:node");
  });

  it("invokes the callback with the target and returns its brief as the output", async () => {
    const cb = vi.fn(async (target: string) => `now on ${target}`);
    const tool = createSwitchEnvironmentTool(cb, { environments });
    const res = await tool.execute(ctx, { target: "vm:node" });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("vm:node");
    expect(res).toEqual({ ok: true, output: "now on vm:node" });
  });

  it("rejects an unknown target without invoking the callback", async () => {
    const cb = vi.fn(async () => "");
    const tool = createSwitchEnvironmentTool(cb, { environments });
    const res = await tool.execute(ctx, { target: "vm:gpu" });
    expect(cb).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.output).toContain("vm:gpu");
    expect(res.output).toContain("browser, vm:base, vm:node");
  });

  it("returns a callback failure as { ok: false }, never throws (ToolDef contract)", async () => {
    const tool = createSwitchEnvironmentTool(
      async () => {
        throw new Error("no baked assets for vm:node — run bake --profile node");
      },
      { environments },
    );
    const res = await tool.execute(ctx, { target: "vm:node" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("bake --profile node");
  });
});
