import { describe, it, expect } from "vitest";
import { makeShell } from "../shell/harness.js";

describe("awk: records and fields", () => {
  it("a bare /RE/ pattern prints matching records", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "foo x\nbar y\n");
    const r = shell.execute("awk '/foo/' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("foo x\n");
  });

  it("{print} with no arguments prints $0", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a b\nc d\n");
    const r = shell.execute("awk '{print}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a b\nc d\n");
  });

  it("selects fields split on whitespace runs by default", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "  a   b\tc  \n");
    const r = shell.execute("awk '{print $2}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });

  it("NR and NF print with comma-separated print (OFS is a space)", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a b\nc\n");
    const r = shell.execute("awk '{print NR, NF}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("1 2\n2 1\n");
  });

  it("$NF and $(NF-1) address fields dynamically", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a b c\n");
    let r = shell.execute("awk '{print $NF}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("c\n");
    r = shell.execute("awk '{print $(NF-1)}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });

  it("a field past NF is the empty string", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\n");
    const r = shell.execute("awk '{print $5 \"x\"}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("x\n");
  });

  it("empty records have NF 0", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "\na b\n");
    const r = shell.execute("awk '{print NF}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("0\n2\n");
  });

  it("reads stdin when no files are given (pipeline)", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo 'a b' | awk '{print $2}'");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("b\n");
  });
});

describe("awk: -F and FS", () => {
  it("-F with a single character splits literally", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "root:x:0\n");
    const r = shell.execute("awk -F: '{print $1}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("root\n");
  });

  it("-F with a separate argument works too", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a,b,c\n");
    const r = shell.execute("awk -F ',' '{print $2}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });

  it("-F with more than one character is a regex ('\\t' matches a tab)", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a::b\n");
    let r = shell.execute("awk -F '::' '{print $2}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
    vfs.writeFile("/t", "a\tb\n");
    r = shell.execute("awk -F '\\t' '{print $2}' /t");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });

  it("a non-capturing group FS regex splits without interleaving separators", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a,b;c\n");
    const r = shell.execute("awk -F '(?:,|;)' '{print $2}' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("b\n");
  });

  it("FS assigned in BEGIN takes effect for every record", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a,b\n");
    const r = shell.execute("awk 'BEGIN{FS=\",\"} {print $2}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });
});

describe("awk: BEGIN and END", () => {
  it("BEGIN runs first, END runs last", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "x\ny\n");
    const r = shell.execute("awk 'BEGIN{print \"s\"} {n = n + 1} END{print n}' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("s\n2\n");
  });

  it("a BEGIN-only program reads no input and needs no files", async () => {
    const { shell } = makeShell();
    const r = shell.execute("awk 'BEGIN{print 1+2}'");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("3\n");
  });

  it("END sees the final record and the total NR", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\n");
    const r = shell.execute("awk 'END{print NR; print}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("2\nb\n");
  });

  it("FNR resets per file while NR keeps counting", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f1", "a\n");
    vfs.writeFile("/f2", "b\n");
    const r = shell.execute("awk '{print NR, FNR}' /f1 /f2");
    await r.wait();
    expect(await r.stdout.text()).toBe("1 1\n2 1\n");
  });
});

describe("awk: patterns", () => {
  it("NR comparison selects records", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\nb\nc\n");
    const r = shell.execute("awk 'NR == 2' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b\n");
  });

  it("compares numerically when both sides look numeric (10 > 9)", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "9\n10\n");
    const r = shell.execute("awk '$1 > 9' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("10\n");
  });

  it("compares as strings when a side is non-numeric", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "apple\nbanana\n");
    const r = shell.execute("awk '$1 != \"apple\"' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("banana\n");
  });

  it("NF comparisons work", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a b\nc\n");
    const r = shell.execute("awk 'NF < 2' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("c\n");
  });

  it("~ and !~ match a field or record against a regex", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "abc\nxyz\n");
    let r = shell.execute("awk '$1 ~ /^ab/' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("abc\n");
    r = shell.execute("awk '$0 !~ \"b\"' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("xyz\n");
  });

  it("a pattern with an action runs the action on matches only", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "b1 z\na q\n");
    const r = shell.execute("awk '/b/ {print $1}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("b1\n");
  });
});

describe("awk: expressions and statements", () => {
  it("concatenation by juxtaposition", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a b\n");
    const r = shell.execute("awk '{print $1 \"-\" $2}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("a-b\n");
  });

  it("concatenation binds looser than arithmetic (1+2 \"x\" is 3x)", async () => {
    const { shell } = makeShell();
    const r = shell.execute("awk 'BEGIN{print 1+2 \"x\"}'");
    await r.wait();
    expect(await r.stdout.text()).toBe("3x\n");
  });

  it("arithmetic with standard precedence, %, and unary minus", async () => {
    const { shell } = makeShell();
    const r = shell.execute("awk 'BEGIN{print 2+3*4, 7%4, -3+5}'");
    await r.wait();
    expect(await r.stdout.text()).toBe("14 3 2\n");
  });

  it("field arithmetic coerces strings to numbers", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "3 4\n");
    const r = shell.execute("awk '{print $1 + $2}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("7\n");
  });

  it("non-integer results print with ~%.6g, integers stay integers", async () => {
    const { shell } = makeShell();
    const r = shell.execute("awk 'BEGIN{print 10/4, 1/3, 6/2}'");
    await r.wait();
    expect(await r.stdout.text()).toBe("2.5 0.333333 3\n");
  });

  it("variables accumulate across records; uninitialized reads are 0 in arithmetic", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "1\n2\n3\n");
    const r = shell.execute("awk '{s = s + $1} END{print s}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("6\n");
  });

  it("multiple statements per action separated by ;", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "q\n");
    const r = shell.execute("awk '{x = $1; print x x}' /f");
    await r.wait();
    expect(await r.stdout.text()).toBe("qq\n");
  });

  it("# comments are skipped", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/f", "a\n");
    const r = shell.execute("awk '{print $1} # trailing comment' /f");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("a\n");
  });
});

describe("awk: fail-fast error paths", () => {
  async function expectError(src: string, pattern: RegExp, file?: string): Promise<void> {
    const { shell, vfs } = makeShell();
    if (file !== undefined) vfs.writeFile("/f", file);
    const r = shell.execute(src);
    expect(await r.wait()).toBe(1);
    expect(await r.stderr.text()).toMatch(pattern);
  }

  it("rejects printf", async () => {
    await expectError("awk '{printf \"%s\", $1}' /f", /awk: unsupported: printf/, "x\n");
  });

  it("rejects control flow keywords", async () => {
    await expectError("awk '{if (1) print}' /f", /awk: unsupported keyword 'if'/, "x\n");
    await expectError("awk '{for (x) print}' /f", /awk: unsupported keyword 'for'/, "x\n");
    await expectError("awk '{while (1) print}' /f", /awk: unsupported keyword 'while'/, "x\n");
  });

  it("rejects getline and functions", async () => {
    await expectError("awk '{getline}' /f", /awk: unsupported keyword 'getline'/, "x\n");
    await expectError("awk 'function f() {}' /f", /awk: unsupported keyword 'function'/, "x\n");
  });

  it("rejects arrays", async () => {
    await expectError("awk '{a[1] = 2}' /f", /awk: unsupported: arrays/, "x\n");
  });

  it("rejects single-argument built-in calls instead of mis-parsing them as concatenation", async () => {
    // Regression: these used to parse as `uninitialized-var ("") . (expr)` and
    // silently pass the input through (length($0) printed $0, int(25/10)
    // printed 2.5) with exit 0 — the exact opposite of the fail-fast contract.
    await expectError("awk '{print length($0)}' /f", /awk: unsupported: function call 'length\(/, "hello world\n");
    await expectError("awk '{print int($1/10)}' /f", /awk: unsupported: function call 'int\(/, "25\n");
    await expectError("awk '{print toupper($1)}' /f", /awk: unsupported: function call 'toupper\(/, "x\n");
    await expectError("awk '{print sqrt($1)}' /f", /awk: unsupported: function call 'sqrt\(/, "9\n");
    await expectError('awk \'{print sprintf("%d", $1)}\' /f', /awk: unsupported: function call 'sprintf\(/, "1\n");
  });

  it("rejects function calls in pattern position", async () => {
    await expectError("awk 'length($0) > 5' /f", /awk: unsupported: function call 'length\(/, "hello world\n");
  });

  it("rejects function calls in statement position", async () => {
    await expectError('awk \'{split($0, a, ",")}\' /f', /awk: unsupported: function call 'split\(/, "a,b\n");
    await expectError("awk 'BEGIN{srand()}'", /awk: unsupported: function call 'srand\(/);
  });

  it("rejects calls to unknown (user-defined) function names too", async () => {
    await expectError("awk '{print foo(1)}' /f", /awk: unsupported: function call 'foo\(/, "x\n");
  });

  it("rejects bare built-in function names used as identifiers", async () => {
    await expectError("awk '{print length}' /f", /awk: unsupported: built-in function 'length'/, "hello\n");
    await expectError("awk 'BEGIN{x = 1 + rand}'", /awk: unsupported: built-in function 'rand'/);
  });

  it("rejects assignment to a built-in function name", async () => {
    await expectError("awk '{length = 5}' /f", /awk: unsupported: assignment to built-in function name 'length'/, "x\n");
  });

  it("rejects capturing groups in an FS regex (String.split would interleave captures)", async () => {
    // Regression: -F'(,|;)' on "a,b" used to make $2 the SEPARATOR ",".
    await expectError("awk -F '(,|;)' '{print $2}' /f", /awk: unsupported: capturing group in field separator/, "a,b\n");
    await expectError('awk \'BEGIN{FS="(,|;)"} {print $2}\' /f', /awk: unsupported: capturing group in field separator/, "a,b\n");
  });

  it("rejects ++ and compound assignment operators", async () => {
    await expectError("awk '{i++}' /f", /awk: unsupported operator '\+\+'/, "x\n");
    await expectError("awk '{i += 1}' /f", /awk: unsupported operator '\+='/, "x\n");
  });

  it("rejects && || and ternary", async () => {
    await expectError("awk 'NR==1 && NR==2' /f", /awk: unsupported operator '&&'/, "x\n");
    await expectError("awk 'BEGIN{x = 1 ? 2 : 3}'", /awk: unsupported operator '\?:'/);
  });

  it("rejects exponentiation", async () => {
    await expectError("awk 'BEGIN{print 2^3}'", /awk: unsupported operator '\^'/);
  });

  it("rejects assignment to NR and to fields", async () => {
    await expectError("awk '{NR = 5}' /f", /awk: unsupported: assignment to NR/, "x\n");
    await expectError("awk '{$1 = 2}' /f", /fields cannot be assigned/, "x\n");
  });

  it("rejects the fixed output-format specials", async () => {
    await expectError("awk 'BEGIN{OFS=\",\"}'", /awk: unsupported special variable 'OFS'/);
    await expectError("awk '{print ORS}' /f", /awk: unsupported special variable 'ORS'/, "x\n");
  });

  it("rejects print redirection", async () => {
    await expectError("awk '{print $1 > \"out\"}' /f", /awk: unsupported: print redirection/, "x\n");
  });

  it("rejects unsupported options like -v", async () => {
    await expectError("awk -v x=1 '{print}' /f", /awk: unsupported option '-v'/, "x\n");
  });

  it("rejects a missing program", async () => {
    await expectError("awk", /awk: missing program/);
  });

  it("rejects an unterminated action and an unterminated string", async () => {
    await expectError("awk '{print' /f", /awk: unterminated action/, "x\n");
    await expectError("awk '{print \"a}' /f", /awk: unterminated string/, "x\n");
  });

  it("rejects a regex outside pattern/~ positions", async () => {
    await expectError("awk '{x = /y/}' /f", /awk: unsupported: \/regex\/ inside an expression/, "x\n");
  });

  it("rejects bare-expression patterns", async () => {
    await expectError("awk 'NR' /f", /awk: unsupported pattern/, "x\n");
  });

  it("errors on division by zero instead of Infinity/NaN", async () => {
    await expectError("awk 'BEGIN{print 1/0}'", /awk: division by zero/);
    await expectError("awk 'BEGIN{print 1%0}'", /awk: division by zero in %/);
  });

  it("rejects an empty field separator", async () => {
    await expectError("awk 'BEGIN{FS=\"\"} {print}' /f", /awk: unsupported: empty field separator/, "x\n");
  });

  it("rejects an invalid -F regex with a precise message", async () => {
    await expectError("awk -F '((' '{print}' /f", /awk: invalid field separator/, "x\n");
  });

  it("rejects the '-' stdin operand", async () => {
    await expectError("awk '{print}' -", /awk: unsupported operand '-'/);
  });

  it("fails with ENOENT on a missing file", async () => {
    await expectError("awk '{print}' /missing", /ENOENT/);
  });
});
