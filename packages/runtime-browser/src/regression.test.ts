import { describe, it, expect, vi } from "vitest";
import { Vfs } from "./vfs/vfs.js";
import { EventBus } from "./core/event-bus.js";
import { ProcessTable } from "./process/process-table.js";
import type { Program } from "./process/program.js";
import { expandWord } from "./shell/expand.js";
import type { Word } from "./shell/ast.js";
import { makeShell } from "./shell/harness.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const w = (...parts: Word["parts"]): Word => ({ parts });

function table(programs: Record<string, Program>, bus = new EventBus()) {
  return new ProcessTable({
    vfs: new Vfs({ clock: () => 0 }),
    bus,
    registry: new Map(Object.entries(programs)),
    clock: () => 0,
    serve: () => {},
  });
}

describe("regression: VFS", () => {
  it("#1 rename refuses to move a directory into its own subtree (EINVAL)", () => {
    const vfs = new Vfs({ clock: () => 0 });
    vfs.mkdir("/a");
    expect(() => vfs.rename("/a", "/a/b")).toThrow(/EINVAL/);
    expect(vfs.stat("/a").type).toBe("directory"); // still intact
  });

  it("#7 writeFile through a dangling symlink creates the target, not clobbers the link", () => {
    const vfs = new Vfs({ clock: () => 0 });
    vfs.symlink("/target", "/link");
    vfs.writeFile("/link", "data");
    expect(vfs.lstat("/link").type).toBe("symlink");
    expect(vfs.readFileText("/target")).toBe("data");
  });

  it("#9 rm -f swallows a missing ancestor directory", () => {
    const vfs = new Vfs({ clock: () => 0 });
    expect(() => vfs.rm("/nope/deep/file", { force: true })).not.toThrow();
  });

  it("#16 copy of a directory INTO an existing directory nests it", () => {
    const vfs = new Vfs({ clock: () => 0 });
    vfs.mkdir("/src");
    vfs.writeFile("/src/f", "x");
    vfs.mkdir("/dst");
    vfs.copy("/src", "/dst");
    expect(vfs.readFileText("/dst/src/f")).toBe("x");
  });
});

describe("regression: process", () => {
  it("#2 a process killed before its body starts never runs the body", async () => {
    let ran = false;
    const t = table({ side: async () => { ran = true; return 0; } });
    const rec = t.spawn({ cmd: "side" });
    rec.kill("SIGKILL");
    expect(await rec.wait()).toEqual({ code: 137, signal: "SIGKILL" });
    await flush();
    expect(ran).toBe(false);
  });

  it("#5 env is snapshotted at spawn, not aliased to the caller's object", async () => {
    const env = { A: "1" };
    const t = table({ readA: async (ctx) => { ctx.stdout.write(ctx.env["A"] ?? ""); return 0; } });
    const rec = t.spawn({ cmd: "readA", env });
    env.A = "2"; // mutate after spawn
    await rec.wait();
    expect(await rec.stdout.text()).toBe("1");
  });

  it("#10 a throwing event listener does not hang wait() and others still receive events", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => { if (e.type === "process.exited") throw new Error("boom"); });
    bus.subscribe((e) => seen.push(e.type));
    const t = table({ ok: async () => 0 }, bus);
    const rec = t.spawn({ cmd: "ok" });
    expect((await rec.wait()).code).toBe(0);
    await flush();
    expect(seen).toContain("process.exited");
    spy.mockRestore();
  });
});

describe("regression: shell + builtins", () => {
  it("#3 a backgrounded command's output surfaces via jobs (real backgrounding superseded the interim foreground-&)", async () => {
    const { shell, table } = makeShell();
    const r = shell.execute("echo hi &");
    await r.wait();
    const pid = Number((await r.stdout.text()).match(/^\[(\d+)\]/)![1]);
    await table.wait(pid);
    const j = shell.execute("jobs");
    await j.wait();
    expect(await j.stdout.text()).toBe(`[${pid}] done (0)  echo hi\nhi\n`);
  });

  it("#19 a non-trailing & errors loudly instead of silently sequencing", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo a & echo b");
    expect(await r.wait()).toBe(2);
    expect(await r.stdout.text()).toBe("");
    expect(await r.stderr.text()).toMatch(/EINVAL/);
  });

  it("#4 tail -n 0 prints nothing", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    const r = shell.execute("tail -n 0 /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("");
  });

  it("#12 grep on empty input yields no phantom line and exits 1", async () => {
    const { shell } = makeShell();
    const r = shell.execute('echo -n "" | grep -v x');
    expect(await r.wait()).toBe(1);
    expect(await r.stdout.text()).toBe("");
  });

  it("#20 ls -l uses '-' for files and 'd' for directories", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/d");
    vfs.writeFile("/d/file", "x");
    vfs.mkdir("/d/sub");
    const r = shell.execute("ls -l /d");
    await r.wait();
    const lines = (await r.stdout.text()).trim().split("\n").sort();
    expect(lines[0]!.startsWith("- ")).toBe(true); // file
    expect(lines[1]!.startsWith("d ")).toBe(true); // sub
  });
});

describe("regression: glob", () => {
  it("#18 * does not match dotfiles, but an explicit dot does", () => {
    const vfs = new Vfs({ clock: () => 0 });
    vfs.writeFile("/.hidden", "1");
    vfs.writeFile("/visible", "1");
    expect(expandWord(w({ t: "glob", v: "*" }), {}, vfs, "/")).toEqual(["visible"]);
    expect(expandWord(w({ t: "glob", v: ".*" }), {}, vfs, "/")).toEqual([".hidden"]);
  });
});
