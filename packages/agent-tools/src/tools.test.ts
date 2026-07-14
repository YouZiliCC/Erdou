import { describe, it, expect, beforeEach } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { createTools } from "./tools.js";
import type { ToolDef } from "./types.js";

function byName(name: string): ToolDef {
  const tool = createTools().find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe("agent tools", () => {
  let runtime: BrowserRuntime;
  beforeEach(async () => {
    runtime = new BrowserRuntime({ clock: () => 0 });
    await runtime.boot();
  });

  it("write_file then read_file round-trips", async () => {
    const write = await byName("write_file").execute({ runtime }, { path: "/a.txt", content: "hello" });
    expect(write.ok).toBe(true);
    const read = await byName("read_file").execute({ runtime }, { path: "/a.txt" });
    expect(read).toEqual({ ok: true, output: "hello" });
  });

  it("read_file on a missing file returns an error result, not a throw", async () => {
    const read = await byName("read_file").execute({ runtime }, { path: "/nope" });
    expect(read.ok).toBe(false);
    expect(read.output).toMatch(/ENOENT/);
  });

  it("make_dir + list_dir", async () => {
    await byName("make_dir").execute({ runtime }, { path: "/proj/src" });
    await byName("write_file").execute({ runtime }, { path: "/proj/src/i.ts", content: "x" });
    const list = await byName("list_dir").execute({ runtime }, { path: "/proj/src" });
    expect(list.output).toContain("i.ts");
  });

  it("run_shell reports stdout and exit code", async () => {
    await byName("write_file").execute({ runtime }, { path: "/data", content: "foo\nbar\n" });
    const res = await byName("run_shell").execute({ runtime }, { command: "grep bar /data" });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("bar");
    expect(res.output).toContain("[exit 0]");
  });

  it("run_shell surfaces a non-zero exit", async () => {
    const res = await byName("run_shell").execute({ runtime }, { command: "cat /missing" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("[exit 1]");
    expect(res.output).toContain("ENOENT");
  });

  it("validates argument types", async () => {
    const res = await byName("write_file").execute({ runtime }, { path: 5, content: "x" });
    expect(res.ok).toBe(false);
  });
});
