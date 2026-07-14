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

  it("detects a trailing background &", () => {
    const list = parse("sleep 1 &");
    expect(list.background).toBe(true);
    expect(list.items[0]!.pipeline.commands[0]!.words).toHaveLength(2);
  });

  it("keeps glob words unexpanded in the AST", () => {
    const cmd = parse("ls *.ts").items[0]!.pipeline.commands[0]!;
    expect(cmd.words[1]).toEqual({ parts: [{ t: "glob", v: "*.ts" }] });
  });

  it("throws EINVAL on a dangling operator", () => {
    expect(() => parse("echo x &&")).toThrow(/EINVAL/);
  });
});
