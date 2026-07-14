import { describe, it, expect } from "vitest";
import { makeShell } from "../shell/harness.js";

describe("builtins", () => {
  it("grep -v inverts and exits 1 on no match", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/data", "foo\nbar\n");
    let r = shell.execute("grep -v foo /data");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("bar\n");

    r = shell.execute("grep zzz /data");
    expect(await r.wait()).toBe(1);
  });

  it("grep -n prefixes line numbers", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/data", "a\nmatch\nb\n");
    const r = shell.execute("grep -n match /data");
    await r.wait();
    expect(await r.stdout.text()).toBe("2:match\n");
  });

  it("head -n 2 takes the first two lines", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/lines", "a\nb\nc\nd\n");
    const r = shell.execute("head -n 2 /lines");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\nb\n");
  });

  it("tail -n 2 takes the last two lines", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/lines", "a\nb\nc\nd\n");
    const r = shell.execute("tail -n 2 /lines");
    await r.wait();
    expect(await r.stdout.text()).toBe("c\nd\n");
  });

  it("find -name walks recursively", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/x");
    vfs.writeFile("/x/a.ts", "1");
    vfs.writeFile("/x/b.js", "1");
    vfs.mkdir("/x/sub");
    vfs.writeFile("/x/sub/c.ts", "1");
    const r = shell.execute("find /x -name '*.ts'");
    await r.wait();
    expect(await r.stdout.text()).toBe("/x/a.ts\n/x/sub/c.ts\n");
  });

  it("ls -a shows dotfiles that ls hides", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/d");
    vfs.writeFile("/d/.hidden", "1");
    vfs.writeFile("/d/visible", "1");
    let r = shell.execute("ls /d");
    await r.wait();
    expect(await r.stdout.text()).toBe("visible\n");
    r = shell.execute("ls -a /d");
    await r.wait();
    expect(await r.stdout.text()).toBe(".hidden\nvisible\n");
  });

  it("cat on a missing file exits 1 with an ENOENT message on stderr", async () => {
    const { shell } = makeShell();
    const r = shell.execute("cat /missing");
    expect(await r.wait()).toBe(1);
    expect(await r.stderr.text()).toContain("ENOENT");
  });

  it("which finds a builtin and fails on an unknown name", async () => {
    const { shell } = makeShell();
    let r = shell.execute("which grep");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("grep\n");
    r = shell.execute("which nope");
    expect(await r.wait()).toBe(1);
  });
});
