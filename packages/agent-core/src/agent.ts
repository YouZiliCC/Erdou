import type { ChatMessage, ToolSpec } from "@erdou/model-gateway";
import { createTools, type ToolDef } from "@erdou/agent-tools";
import type { AgentOptions, AgentRunResult, AgentEvent } from "./types.js";
import { buildSystemPrompt } from "./prompt.js";

const GATED_TOOLS = new Set(["run_shell", "remove_path"]);

/**
 * The reference Coding Agent. It drives a Runtime through agent-tools using a
 * model (via the gateway), looping plan → act → observe until the model
 * finishes with a tool-free reply or the step budget is exhausted. All
 * task-level judgment lives here; the runtime only reports facts.
 */
export class CodingAgent {
  private readonly tools: ToolDef[];
  private readonly toolByName: Map<string, ToolDef>;
  private readonly toolSpecs: ToolSpec[];
  private readonly maxSteps: number;

  constructor(private readonly opts: AgentOptions) {
    this.tools = opts.tools ?? createTools();
    this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    this.toolSpecs = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    this.maxSteps = opts.maxSteps ?? 20;
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  async run(task: string, priorMessages?: ChatMessage[]): Promise<AgentRunResult> {
    let messages: ChatMessage[];
    if (priorMessages && priorMessages.length > 0) {
      // priorMessages already contains the system message + prior turns — don't prepend another.
      messages = [...priorMessages, { role: "user", content: task }];
    } else {
      const systemPrompt =
        this.opts.systemPrompt ??
        buildSystemPrompt(this.opts.environment ?? {}, await this.opts.runtime.getCapabilities());
      messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: task },
      ];
    }

    for (let step = 1; step <= this.maxSteps; step++) {
      this.emit({ type: "step", step });
      const result = await this.opts.gateway.chat(this.opts.model, messages, { tools: this.toolSpecs });

      if (result.toolCalls.length === 0) {
        // No tool call → the model considers the task done.
        messages.push({ role: "assistant", content: result.content });
        this.emit({ type: "assistant", content: result.content });
        this.emit({ type: "done", reason: "done", summary: result.content });
        return { steps: step, finalMessage: result.content, stoppedReason: "done", transcript: messages };
      }

      // Record the assistant turn (content may be empty when only calling tools).
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      if (result.content.length > 0) this.emit({ type: "assistant", content: result.content });

      for (const call of result.toolCalls) {
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          args = call.arguments.trim().length > 0 ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
        } catch {
          parseError = `invalid JSON arguments for ${call.name}: ${call.arguments}`;
        }
        this.emit({ type: "tool_call", name: call.name, args });

        if (parseError) {
          this.emit({ type: "tool_result", name: call.name, ok: false, output: parseError });
          messages.push({ role: "tool", toolCallId: call.id, content: parseError });
          continue;
        }

        if (this.opts.approve && GATED_TOOLS.has(call.name)) {
          const decision = await this.opts.approve({
            tool: call.name,
            command: typeof args.command === "string" ? args.command : undefined,
            args,
          });
          if (decision === "deny") {
            const output = "Denied by the user.";
            this.emit({ type: "tool_result", name: call.name, ok: false, output });
            messages.push({ role: "tool", toolCallId: call.id, content: output });
            continue;
          }
        }

        const { output, ok } = await this.executeTool(call.name, args);
        this.emit({ type: "tool_result", name: call.name, ok, output });
        messages.push({ role: "tool", toolCallId: call.id, content: output });
      }
    }

    const finalMessage = "Reached the maximum number of steps before completing the task.";
    this.emit({ type: "done", reason: "max_steps", summary: finalMessage });
    return { steps: this.maxSteps, finalMessage, stoppedReason: "max_steps", transcript: messages };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ output: string; ok: boolean }> {
    const tool = this.toolByName.get(name);
    if (!tool) return { ok: false, output: `unknown tool: ${name}` };
    const result = await tool.execute({ runtime: this.opts.runtime }, args);
    return { ok: result.ok, output: result.output };
  }
}
