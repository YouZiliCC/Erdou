import { describe, it, expect } from "vitest";
import { PipeStream } from "./byte-stream.js";

describe("PipeStream", () => {
  it("preserves write order and concatenates via text()", async () => {
    const s = new PipeStream();
    s.write("foo");
    s.write("bar");
    s.end();
    expect(await s.text()).toBe("foobar");
  });

  it("delivers a chunk written after a pending read", async () => {
    const s = new PipeStream();
    const iter = s.read();
    const pending = iter.next();
    s.write("late");
    const result = await pending;
    expect(result.done).toBe(false);
    expect(new TextDecoder().decode(result.value)).toBe("late");
  });

  it("read() completes after end()", async () => {
    const s = new PipeStream();
    const iter = s.read();
    s.end();
    expect((await iter.next()).done).toBe(true);
  });

  it("write after end throws EBADF", () => {
    const s = new PipeStream();
    s.end();
    expect(() => s.write("x")).toThrow(/EBADF/);
  });
});
