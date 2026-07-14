import type { ChatMessage, ToolSpec } from "@erdou/model-gateway";
import { createTools, type ToolDef } from "@erdou/agent-tools";
import type { AgentOptions, AgentRunResult, AgentEvent } from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `You are Erdou, an autonomous coding agent operating a browser-based virtual filesystem and shell.

Accomplish the user's task by calling the provided tools. Rules:
- Paths are absolute and start with "/". The filesystem starts empty at "/".
- Create parent directories with make_dir before writing files into them.
- After making changes, verify them (list_dir, read_file, or run_shell).
- Do not ask the user questions — make reasonable decisions and proceed.
- When the task is fully complete, reply with a short plain-text summary and DO NOT call any tool.`;

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
  private readonly systemPrompt: string;

  constructor(private readonly opts: AgentOptions) {
    this.tools = opts.tools ?? createTools();
    this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    this.toolSpecs = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    this.maxSteps = opts.maxSteps ?? 20;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  async run(task: string): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: task },
    ];

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
        const { args, output, ok } = await this.runTool(call.name, call.arguments);
        this.emit({ type: "tool_call", name: call.name, args });
        this.emit({ type: "tool_result", name: call.name, ok, output });
        messages.push({ role: "tool", toolCallId: call.id, content: output });
      }
    }

    const finalMessage = "Reached the maximum number of steps before completing the task.";
    this.emit({ type: "done", reason: "max_steps", summary: finalMessage });
    return { steps: this.maxSteps, finalMessage, stoppedReason: "max_steps", transcript: messages };
  }

  private async runTool(
    name: string,
    rawArgs: string,
  ): Promise<{ args: Record<string, unknown>; output: string; ok: boolean }> {
    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim().length > 0 ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return { args: {}, ok: false, output: `invalid JSON arguments for ${name}: ${rawArgs}` };
    }
    const tool = this.toolByName.get(name);
    if (!tool) {
      return { args, ok: false, output: `unknown tool: ${name}` };
    }
    const result = await tool.execute({ runtime: this.opts.runtime }, args);
    return { args, ok: result.ok, output: result.output };
  }
}
