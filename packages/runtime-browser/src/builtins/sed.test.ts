import { describe, it, expect } from "vitest";
import { makeShell } from "../shell/harness.js";

const read = (vfs: { readFile(p: string): Uint8Array }, path: string): string =>
  new TextDecoder().decode(vfs.readFile(path));

describe("sed: substitution", () => {
  it("replaces only the first occurrence per line without g", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "aa bb aa\n");
    const r = shell.execute("sed 's/aa/X/' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("X bb aa\n");
  });

  it("g flag replaces every occurrence", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "aa bb aa\n");
    const r = shell.execute("sed 's/aa/X/g' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("X bb X\n");
  });

  it("i flag matches case-insensitively", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "FOO bar\n");
    const r = shell.execute("sed 's/foo/x/i' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("x bar\n");
  });

  it("& inserts the whole match", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "abbbc\n");
    const r = shell.execute("sed 's/b+/[&]/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a[bbb]c\n");
  });

  it("\\1-\\9 backreferences reorder capture groups", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "aabb\n");
    const r = shell.execute("sed 's/(a+)(b+)/\\2\\1/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("bbaa\n");
  });

  it("\\n and \\t escapes work in the replacement", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a,b\n");
    let r = shell.execute("sed 's/,/\\n/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\nb\n");
    r = shell.execute("sed 's/,/\\t/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\tb\n");
  });

  it("supports any delimiter after s", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "/usr/lib\n");
    const r = shell.execute("sed 's#/usr#/opt#' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("/opt/lib\n");
  });

  it("an escaped delimiter is a literal character", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a/b\n");
    const r = shell.execute("sed 's/a\\/b/X/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("X\n");
  });

  it("zero-width global matches terminate and insert between characters", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "abc\n");
    const r = shell.execute("sed 's/x*/-/g' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("-a-b-c-\n");
  });

  it("a null match immediately after a non-null match is suppressed under g (GNU rule)", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "baaad\n");
    const r = shell.execute("sed 's/a*/X/g' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("XbXdX\n"); // GNU/busybox; naive exec loop yields XbXXdX
  });

  it("a whole-line match emits no extra replacement for the trailing null match", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "aaa\n");
    const r = shell.execute("sed 's/a*/X/g' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("X\n");
  });

  it("s with the p flag under -n prints only substituted lines", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "apple\nbanana\n");
    const r = shell.execute("sed -n 's/apple/X/p' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("X\n");
  });
});

describe("sed: p/d and addresses", () => {
  it("p without -n duplicates lines", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\n");
    const r = shell.execute("sed 'p' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\na\n");
  });

  it("a numeric address selects one line", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    const r = shell.execute("sed '2d' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\nc\n");
  });

  it("$ addresses the last line", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    const r = shell.execute("sed '$d' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\nb\n");
  });

  it("/RE/ addresses matching lines", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    const r = shell.execute("sed '/b/d' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\nc\n");
  });

  it("N,M and N,$ ranges", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    let r = shell.execute("sed '1,2d' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("c\n");
    r = shell.execute("sed '2,$d' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\n");
  });

  it("an empty range (M < N) still matches line N, like GNU sed", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\nd\n");
    const r = shell.execute("sed '3,2d' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a\nb\nd\n");
  });

  it("-n with an addressed p extracts a line", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    const r = shell.execute("sed -n '2p' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });

  it("an address restricts an s command", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "aa\nbb\ncc\n");
    const r = shell.execute("sed '2s/./X/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("aa\nXb\ncc\n");
  });
});

describe("sed: invocation", () => {
  it("runs multiple commands separated by ;", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "ab\n");
    const r = shell.execute("sed 's/a/1/;s/b/2/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("12\n");
  });

  it("accepts multiple -e scripts in order", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "ab\n");
    const r = shell.execute("sed -e 's/a/1/' -e 's/b/2/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("12\n");
  });

  it("reads stdin when no files are given (pipeline)", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo aXb | sed 's/X/-/'");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("a-b\n");
  });

  it("reads stdin from an input redirection", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "abc\n");
    const r = shell.execute("sed 's/b/X/' < /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("aXc\n");
  });

  it("treats multiple files as one stream: line numbers continue and $ is the final line", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f1", "a\nb\n");
    vfs.writeFile("/f2", "c\nd\n");
    let r = shell.execute("sed -n '3p' /f1 /f2");
    await r.wait();
    expect(await r.stdout.text()).toBe("c\n");
    r = shell.execute("sed -n '$p' /f1 /f2");
    await r.wait();
    expect(await r.stdout.text()).toBe("d\n");
  });

  it("a final line without a trailing newline gains one on output", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a");
    const r = shell.execute("sed 's/a/b/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });
});

describe("sed: -i in-place editing", () => {
  it("rewrites the file and prints nothing", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "aa\nba\n");
    const r = shell.execute("sed -i 's/a/X/g' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("");
    expect(read(vfs, "/f")).toBe("XX\nbX\n");
  });

  it("-n -i keeps only printed lines", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    const r = shell.execute("sed -n -i '2p' /f");
    expect(await r.wait()).toBe(0);
    expect(read(vfs, "/f")).toBe("b\n");
  });

  it("processes each file separately, so $ is per-file", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f1", "a\n");
    vfs.writeFile("/f2", "b\nc\n");
    const r = shell.execute("sed -i '$s/./X/' /f1 /f2");
    expect(await r.wait()).toBe(0);
    expect(read(vfs, "/f1")).toBe("X\n");
    expect(read(vfs, "/f2")).toBe("b\nX\n");
  });
});

describe("sed: fail-fast error paths", () => {
  async function expectError(src: string, pattern: RegExp, setup?: (vfs: { writeFile(p: string, d: string): void }) => void): Promise<void> {
    const { shell, vfs } = makeShell();
    setup?.(vfs);
    const r = shell.execute(src);
    expect(await r.wait()).toBe(1);
    expect(await r.stderr.text()).toMatch(pattern);
  }

  it("rejects unsupported commands", async () => {
    await expectError("sed 'q' /f", /sed: unsupported command 'q'/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects ! negation as an unsupported command", async () => {
    await expectError("sed '1!d' /f", /sed: unsupported command '!'/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects unsupported s flags", async () => {
    await expectError("sed 's/a/b/w' /f", /sed: unsupported s flag 'w'/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects regex address ranges", async () => {
    await expectError("sed '/a/,/b/d' /f", /sed: unsupported: regex address ranges/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects ranges starting at $", async () => {
    await expectError("sed '$,3d' /f", /sed: unsupported address range starting at '\$'/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects an unterminated s command", async () => {
    await expectError("sed 's/a/b' /f", /sed: unterminated s command/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects unsupported options", async () => {
    await expectError("sed -r 's/a/b/' /f", /sed: unsupported option '-r'/);
  });

  it("rejects a missing script", async () => {
    await expectError("sed", /sed: missing script/);
  });

  it("rejects -i without file operands", async () => {
    await expectError("sed -i 's/a/b/'", /sed: -i requires at least one file operand/);
  });

  it("rejects backreferences beyond the group count at parse time", async () => {
    await expectError("sed 's/(a)/\\2/' /f", /sed: invalid backreference \\2/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects an empty s regex (no last-regex recall)", async () => {
    await expectError("sed 's//x/' /f", /sed: empty s regex/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects unsupported replacement escapes", async () => {
    await expectError("sed 's/a/\\q/' /f", /sed: unsupported escape '\\q' in replacement/, (v) => v.writeFile("/f", "x\n"));
  });

  it("rejects the '-' stdin operand", async () => {
    await expectError("sed 's/a/b/' -", /sed: unsupported operand '-'/);
  });

  it("rejects line address 0", async () => {
    await expectError("sed '0d' /f", /sed: invalid line address 0/, (v) => v.writeFile("/f", "x\n"));
  });

  it("fails with ENOENT on a missing file", async () => {
    await expectError("sed 's/a/b/' /missing", /ENOENT/);
  });
});
