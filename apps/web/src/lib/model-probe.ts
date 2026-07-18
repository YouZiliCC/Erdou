import type { ChatMessage, ModelConfig, ModelGateway, ToolSpec } from "@erdou/model-gateway";

/**
 * Outcome of probing a model endpoint (see `probeModel`). `detail` is the one
 * human-readable line the Settings dialog renders: a success summary, the
 * tools warning, or — on chat failure — the gateway's VERBATIM error message
 * (the gateway's errors already carry status + response body; rewrapping them
 * would only bury the signal).
 */
export interface ProbeResult {
  /** The minimal chat round-trip succeeded. */
  chatOk: boolean;
  /** Wall-clock ms of the chat round-trip — recorded even when it fails. */
  latencyMs: number;
  /** The model answered the ping-tool probe with an actual tool call. */
  toolsOk: boolean;
  /** One renderable line describing the outcome (see interface doc). */
  detail: string;
}

/** A hung endpoint must become a precise error, not a forever-spinning Test button. */
const PROBE_TIMEOUT_MS = 20_000;

/** Minimal chat round-trip: tiny prompt, tiny answer — the cheapest possible call. */
const CHAT_PROBE: ChatMessage[] = [{ role: "user", content: "Reply with the single word: ok" }];

/**
 * The tool-call probe. A provider that silently drops the `tools` field (the
 * Anthropic path was once inert for exactly this reason) still returns a
 * plausible chat answer — only an explicit "did a tool call come back?" check
 * catches it, and without tool calls the agent is structurally inert.
 */
const PING_TOOL: ToolSpec = {
  name: "ping",
  description: "Connectivity check. Call this tool with no arguments.",
  parameters: { type: "object", properties: {}, required: [] },
};
const TOOL_PROBE: ChatMessage[] = [
  { role: "user", content: "Call the ping tool now. Do not answer with text." },
];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stale-result guard for the Settings dialog: config fields stay EDITABLE
 * while a probe is in flight (up to ~40 s across the two request timeouts), so
 * a result resolving after an edit would render a verdict for values it never
 * tested — exactly the silently-wrong-output class this module exists to
 * close. The dialog calls `invalidate()` on every config edit; `run()` then
 * resolves null (drop the verdict) instead of the stale result. A plain
 * generation counter suffices — the Test button is disabled while probing, so
 * runs never overlap.
 */
export interface ProbeSession {
  /** Call on every config edit: any in-flight probe's verdict is dropped. */
  invalidate(): void;
  /** `probeModel`, unless `invalidate` fired mid-flight — then resolves null. */
  run(gateway: ModelGateway, config: ModelConfig): Promise<ProbeResult | null>;
}

export function createProbeSession(): ProbeSession {
  let generation = 0;
  return {
    invalidate() {
      generation++;
    },
    async run(gateway, config) {
      const started = ++generation;
      const result = await probeModel(gateway, config);
      return generation === started ? result : null;
    },
  };
}

/**
 * Probe the configured endpoint with the SAME gateway the app uses for runs
 * (studio's `new ModelGateway()` + per-call ModelConfig — no parallel client):
 * (1) a minimal chat round-trip for reachability + latency, then (2) a
 * ping-tool round-trip for tool calling. Never rejects — every failure mode
 * becomes a structured ProbeResult. The tool probe is a separate request so a
 * provider that ERRORS on the `tools` field still gets a clean chat verdict.
 */
export async function probeModel(gateway: ModelGateway, config: ModelConfig): Promise<ProbeResult> {
  const started = performance.now();
  try {
    await gateway.chat(config, CHAT_PROBE, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    // Verbatim pass-through — the gateway's message already names the
    // provider, HTTP status and response body.
    return {
      chatOk: false,
      latencyMs: Math.round(performance.now() - started),
      toolsOk: false,
      detail: message(err),
    };
  }
  const latencyMs = Math.round(performance.now() - started);

  try {
    const res = await gateway.chat(config, TOOL_PROBE, {
      tools: [PING_TOOL],
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.toolCalls.length === 0) {
      return {
        chatOk: true,
        latencyMs,
        toolsOk: false,
        detail: `Endpoint reachable (${latencyMs} ms), but tool calling did not work — the agent cannot act without it.`,
      };
    }
  } catch (err) {
    // Chat worked but the tools request itself failed (e.g. 400 on `tools`) —
    // same inert-agent verdict, with the gateway's error appended verbatim.
    return {
      chatOk: true,
      latencyMs,
      toolsOk: false,
      detail:
        `Endpoint reachable (${latencyMs} ms), but tool calling did not work — the agent cannot act without it. ` +
        message(err),
    };
  }
  return {
    chatOk: true,
    latencyMs,
    toolsOk: true,
    detail: `Endpoint reachable (${latencyMs} ms) — chat and tool calling both work.`,
  };
}
