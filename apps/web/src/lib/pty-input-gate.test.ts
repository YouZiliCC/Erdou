import { describe, it, expect, vi } from "vitest";
import { makePtyInputGate } from "./pty-input-gate.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const decoded = (sink: ReturnType<typeof vi.fn>) =>
  sink.mock.calls.map(([b]) => new TextDecoder().decode(b as Uint8Array));

describe("makePtyInputGate", () => {
  it("forwards input directly once open", () => {
    const gate = makePtyInputGate();
    const sink = vi.fn();
    gate.open(sink);
    gate.input(bytes("x"));
    expect(decoded(sink)).toEqual(["x"]);
  });

  it("queues input while pending and flushes in order on open()", () => {
    const gate = makePtyInputGate();
    gate.input(bytes("ls"));
    gate.input(bytes("\r"));
    const sink = vi.fn();
    gate.open(sink);
    expect(decoded(sink)).toEqual(["ls", "\r"]);
    gate.input(bytes("pwd")); // post-open input goes straight through
    expect(decoded(sink)).toEqual(["ls", "\r", "pwd"]);
  });

  it("close() before open() drops the queue; a later open() and input() are no-ops", () => {
    const gate = makePtyInputGate();
    gate.input(bytes("dropped"));
    gate.close(); // openPty rejected
    const sink = vi.fn();
    gate.open(sink);
    gate.input(bytes("late"));
    expect(sink).not.toHaveBeenCalled();
  });

  it("close() after open() stops forwarding (unmount)", () => {
    const gate = makePtyInputGate();
    const sink = vi.fn();
    gate.open(sink);
    gate.close();
    gate.input(bytes("x"));
    expect(sink).not.toHaveBeenCalled();
  });
});
