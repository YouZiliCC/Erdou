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

  it("grep treats the pattern as a regex, not a literal substring", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/data", "foo\nbar\nbaz\n");

    let r = shell.execute("grep '^foo' /data");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("foo\n");

    r = shell.execute("grep 'foo|bar' /data");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("foo\nbar\n");

    r = shell.execute("grep 'b.z' /data");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("baz\n");

    // -i still applies, as a regex flag rather than a lowercase compare.
    r = shell.execute("grep -i '^BA.$' /data");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("bar\nbaz\n");
  });

  it("grep fails loudly on an unsupported option instead of dropping it", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/data", "foo\n");
    const r = shell.execute("grep -Q foo /data");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toBe("grep: unsupported option '-Q' (supported: -i, -n, -v)\n");
    expect(await r.stdout.text()).toBe("");
  });

  it("grep uses exit 2, never 1, for a usage error — 1 must stay readable as 'no match'", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/data", "foo\n");
    // The whole point of rejecting unknown flags is that the agent stops reading
    // a silent failure as "the string is absent". Exit 1 would be invisible in
    // `grep -r foo . || echo absent`, so a usage error must not share it with
    // the genuine no-match below.
    const bad = shell.execute("grep -r foo /data");
    expect(await bad.wait()).toBe(2);
    const noMatch = shell.execute("grep zzz /data");
    expect(await noMatch.wait()).toBe(1);
  });

  it("grep honours -- as end-of-options so a dash-leading pattern is greppable", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/data", "-foo\nbar\n");

    let r = shell.execute("grep -- -foo /data");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("-foo\n");
    expect(await r.stderr.text()).toBe("");

    // Flags before -- still apply; operands after it are never re-scanned for flags.
    r = shell.execute("grep -n -- -foo /data");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("1:-foo\n");

    // A dash-leading FILE after -- is a filename, not a flag.
    vfs.writeFile("/-dashfile", "bar\n");
    r = shell.execute("grep -- bar /-dashfile");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("bar\n");
  });

  it("grep fails loudly on an uncompilable pattern instead of matching literally", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/data", "a(b\n");
    const r = shell.execute("grep 'a(b' /data");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toContain("grep: invalid pattern 'a(b':");
    expect(await r.stdout.text()).toBe("");
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
