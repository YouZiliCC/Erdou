import { describe, it, expect } from "vitest";
import { normalize, join, dirname, basename, split } from "./path.js";

describe("path", () => {
  it("normalizes . and .. and trailing slashes", () => {
    expect(normalize("/a/./b/../c")).toBe("/a/c");
    expect(normalize("/a/b/")).toBe("/a/b");
    expect(normalize("/")).toBe("/");
    expect(normalize("//a///b")).toBe("/a/b");
  });

  it("cannot escape the root with ..", () => {
    expect(normalize("/a/../..")).toBe("/");
    expect(normalize("/..")).toBe("/");
  });

  it("rejects relative paths with EINVAL", () => {
    expect(() => normalize("a/b")).toThrow(/EINVAL/);
  });

  it("joins segments then normalizes", () => {
    expect(join("/a", "b", "../c")).toBe("/a/c");
  });

  it("dirname/basename/split", () => {
    expect(dirname("/a/b/c")).toBe("/a/b");
    expect(dirname("/a")).toBe("/");
    expect(basename("/a/b/c")).toBe("c");
    expect(basename("/")).toBe("/");
    expect(split("/a/b")).toEqual(["a", "b"]);
    expect(split("/")).toEqual([]);
  });
});
