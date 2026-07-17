import type { ToolDef, ToolResult } from "./types.js";

export interface SwitchEnvironmentOptions {
  /** Environment ids the tool may target, e.g. ["browser", "vm:base", "vm:node"]. */
  environments: string[];
}

/**
 * Builds the switch_environment tool. The switch itself is performed by the
 * app-provided callback (agent-tools stays contract-only — no dependency on
 * the app), which resolves to a brief of the new environment: the system
 * prompt is built once at run start, so the tool result is the model's only
 * in-band way to learn what changed.
 */
export function createSwitchEnvironmentTool(
  cb: (target: string) => Promise<string>,
  opts: SwitchEnvironmentOptions,
): ToolDef {
  const { environments } = opts;
  const list = environments.join(", ");
  return {
    name: "switch_environment",
    description:
      `Switch the active execution environment to one of: ${list}. ` +
      "Use this when the task needs an interpreter or package manager the current environment lacks. " +
      "The workspace follows: your files are copied into the new environment. " +
      "The result describes the new environment — trust it over the original brief.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: environments, description: "The environment id to switch to." },
      },
      required: ["target"],
    },
    async execute(_ctx, args): Promise<ToolResult> {
      const target = args.target;
      if (typeof target !== "string" || !environments.includes(target)) {
        return { ok: false, output: `unknown environment: ${String(target)} (expected one of: ${list})` };
      }
      try {
        return { ok: true, output: await cb(target) };
      } catch (err) {
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
