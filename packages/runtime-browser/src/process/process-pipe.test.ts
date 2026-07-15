import { describe, it, expect } from "vitest";
import { ProcessTable } from "./process-table.js";
import type { Program, ProgramRegistry } from "./program.js";
import { Vfs } from "../vfs/vfs.js";
import { EventBus } from "../core/event-bus.js";

const decoder = new TextDecoder();

const echo: Program = async (ctx) => {
  ctx.stdout.write(ctx.argv.slice(1).join(" "));
  return 0;
};

// Minimal grep-over-stdin for the pipeline test.
const grep: Program = async (ctx) => {
  const needle = ctx.argv[1] ?? "";
  const parts: Uint8Array[] = [];
  for await (const chunk of ctx.stdin.read()) parts.push(chunk);
  const text = decoder.decode(concat(parts));
  for (const line of text.split("\n")) {
    if (line.includes(needle)) ctx.stdout.write(line + "\n");
  }
  return 0;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function make(programs: Record<string, Program>) {
  const registry: ProgramRegistry = new Map(Object.entries(programs));
  const vfs = new Vfs({ clock: () => 0 });
  const bus = new EventBus();
  return new ProcessTable({ vfs, bus, registry, clock: () => 0, serve: () => {} });
}

describe("pipelines", () => {
  it("streams stdout of one stage into the next", async () => {
    const table = make({ echo, grep });
    const stages = table.spawnPiped([
      { cmd: "echo", args: ["hi\nbye"] },
      { cmd: "grep", args: ["hi"] },
    ]);
    const last = stages[stages.length - 1]!;
    await last.wait();
    expect(await last.stdout.text()).toBe("hi\n");
  });

  it("registers a new program under a command name", async () => {
    const table = make({});
    table.register("hi", async (ctx) => {
      ctx.stdout.write("hi from a registered program");
      return 0;
    });
    const rec = table.spawn({ cmd: "hi" });
    await rec.wait();
    expect(await rec.stdout.text()).toBe("hi from a registered program");
  });
});
