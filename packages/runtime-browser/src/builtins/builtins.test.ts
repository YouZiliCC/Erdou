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

  it("head prints ==> name <== headers when given multiple file operands", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/a.log", "a1\na2\na3\n");
    vfs.writeFile("/b.log", "b1\nb2\nb3\n");
    const r = shell.execute("head -n 2 /a.log /b.log");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("==> /a.log <==\na1\na2\n\n==> /b.log <==\nb1\nb2\n");
  });

  it("tail prints ==> name <== headers when given multiple file operands", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/a.log", "a1\na2\na3\n");
    vfs.writeFile("/b.log", "b1\nb2\nb3\n");
    const r = shell.execute("tail -n 2 /a.log /b.log");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("==> /a.log <==\na2\na3\n\n==> /b.log <==\nb2\nb3\n");
  });

  it("head continues past an unreadable operand and exits 1", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/a.log", "a1\n");
    const r = shell.execute("head -n 1 /missing /a.log");
    expect(await r.wait()).toBe(1);
    expect(await r.stderr.text()).toContain("ENOENT");
    expect(await r.stdout.text()).toBe("==> /a.log <==\na1\n");
  });

  it("head/tail reject a non-numeric -n loudly instead of degrading", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/lines", "a\nb\nc\n");

    const h = shell.execute("head -n garbage /lines");
    expect(await h.wait()).toBe(2);
    expect(await h.stderr.text()).toBe("head: invalid line count 'garbage' (usage: head [-n N] [FILE...])\n");
    expect(await h.stdout.text()).toBe("");

    const t = shell.execute("tail -n garbage /lines");
    expect(await t.wait()).toBe(2);
    expect(await t.stderr.text()).toBe("tail: invalid line count 'garbage' (usage: tail [-n N] [FILE...])\n");
    expect(await t.stdout.text()).toBe("");
  });

  it("kill rejects an unsupported signal flag loudly without signaling", async () => {
    const { shell } = makeShell();
    // Pid 999 does not exist: had SIGTERM been silently substituted and sent,
    // stderr would carry ESRCH and the exit code would be 1.
    const r = shell.execute("kill -USR1 999");
    expect(await r.wait()).toBe(2);
    expect(await r.stderr.text()).toBe("kill: unsupported signal '-USR1' (supported: HUP, INT, KILL, TERM)\n");

    const ok = shell.execute("kill -9 999");
    expect(await ok.wait()).toBe(1);
    expect(await ok.stderr.text()).toContain("ESRCH");
  });

  it("find -type accepts only f and d, rejecting anything else loudly", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/x");
    vfs.writeFile("/x/f.txt", "1");
    vfs.mkdir("/x/sub");

    let r = shell.execute("find /x -type f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("/x/f.txt\n");

    r = shell.execute("find /x -type d");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("/x\n/x/sub\n");

    r = shell.execute("find /x -type l");
    expect(await r.wait()).toBe(1);
    expect(await r.stderr.text()).toBe("find: unsupported -type 'l' (supported: f, d)\n");
    expect(await r.stdout.text()).toBe("");
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
