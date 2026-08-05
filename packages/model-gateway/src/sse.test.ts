import { describe, it, expect } from "vitest";
import { parseSSE } from "./sse.js";

describe("parseSSE", () => {
  it("cancels the underlying stream when the consumer exits early", async () => {
    let cancelled = false;
    // A live stream that never ends on its own — like a server mid-response.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const payload of parseSSE(body)) {
      expect(payload).toBe("x");
      break; // consumer bails out mid-stream (user stop, [DONE], thrown error)
    }
    expect(cancelled).toBe(true);
  });

  it("cancels the underlying stream when the consumer throws mid-iteration", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const run = async (): Promise<void> => {
      for await (const payload of parseSSE(body)) {
        throw new Error(`boom on ${payload}`);
      }
    };
    await expect(run()).rejects.toThrow("boom on x");
    expect(cancelled).toBe(true);
  });
});
