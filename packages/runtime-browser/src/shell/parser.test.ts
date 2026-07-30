import { describe, it, expect } from "vitest";
import { parse } from "./parser.js";

describe("parse", () => {
  it("parses a pipeline of two commands", () => {
    const list = parse("echo hi | grep h");
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.op).toBeNull();
    expect(list.items[0]!.pipeline.commands).toHaveLength(2);
  });

  it("encodes list operators on the following item", () => {
    const list = parse("a && b || c");
    expect(list.items.map((it) => it.op)).toEqual([null, "&&", "||"]);
  });

  it("attaches redirects to the command", () => {
    const list = parse("echo x > f.txt");
    const cmd = list.items[0]!.pipeline.commands[0]!;
    expect(cmd.redirects).toEqual([
      { fd: 1, op: ">", target: { parts: [{ t: "lit", v: "f.txt" }] } },
    ]);
  });

  it("attaches a fd duplication as a redirect that consumes no word", () => {
    const cmd = parse("cmd 2>&1 arg").items[0]!.pipeline.commands[0]!;
    expect(cmd.redirects).toEqual([{ fd: 2, op: ">&", from: 1 }]);
    // The `1` is part of the operator, so `arg` is still the command's argument.
    expect(cmd.words).toHaveLength(2);
  });

  it("desugars `&> f` into `> f` followed by `2>&1`", () => {
    // Order matters: the dup must come AFTER the file redirect, because it
    // copies fd 1's target as it stands at that point.
    const cmd = parse("cmd &> log").items[0]!.pipeline.commands[0]!;
    expect(cmd.redirects).toEqual([
      { fd: 1, op: ">", target: { parts: [{ t: "lit", v: "log" }] } },
      { fd: 2, op: ">&", from: 1 },
    ]);
    expect(parse("cmd &>> log").items[0]!.pipeline.commands[0]!.redirects[0]).toEqual({
      fd: 1,
      op: ">>",
      target: { parts: [{ t: "lit", v: "log" }] },
    });
  });

  it("detects a trailing background &", () => {
    const list = parse("sleep 1 &");
    expect(list.background).toBe(true);
    expect(list.items[0]!.pipeline.commands[0]!.words).toHaveLength(2);
  });

  it("a trailing & backgrounds a whole pipeline / list", () => {
    let list = parse("echo hi | grep h &");
    expect(list.background).toBe(true);
    expect(list.items[0]!.pipeline.commands).toHaveLength(2);

    list = parse("a && b &");
    expect(list.background).toBe(true);
    expect(list.items).toHaveLength(2);
  });

  it("rejects a non-trailing & with EINVAL (only 'cmd &' is supported)", () => {
    expect(() => parse("echo a & echo b")).toThrow(/EINVAL/);
    expect(() => parse("echo a & echo b")).toThrow(/'cmd1 & cmd2' is not/);
  });

  it("keeps glob words unexpanded in the AST", () => {
    const cmd = parse("ls *.ts").items[0]!.pipeline.commands[0]!;
    expect(cmd.words[1]).toEqual({ parts: [{ t: "glob", v: "*.ts" }] });
  });

  it("throws EINVAL on a dangling operator", () => {
    expect(() => parse("echo x &&")).toThrow(/EINVAL/);
  });
});
