import { describe, it, expect } from "vitest";
import { ErrnoError, enoent } from "./errors.js";

describe("ErrnoError", () => {
  it("formats a POSIX-style message with code, syscall and path", () => {
    const err = new ErrnoError("ENOENT", { syscall: "open", path: "/foo/bar" });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ENOENT");
    expect(err.path).toBe("/foo/bar");
    expect(err.syscall).toBe("open");
    expect(err.message).toBe("ENOENT: no such file or directory, open '/foo/bar'");
  });

  it("formats with only a path (no syscall)", () => {
    const err = new ErrnoError("EISDIR", { path: "/dir" });
    expect(err.message).toBe("EISDIR: illegal operation on a directory '/dir'");
  });

  it("formats a bare code with no context", () => {
    expect(new ErrnoError("EINVAL").message).toBe("EINVAL: invalid argument");
  });

  it("includes an empty-string path in the message (consistent with the stored field)", () => {
    const err = new ErrnoError("EINVAL", { syscall: "parse", path: "" });
    expect(err.path).toBe("");
    expect(err.message).toBe("EINVAL: invalid argument, parse ''");
  });

  it("enoent factory produces a fully-formed ENOENT error", () => {
    const err = enoent("/x", "stat");
    expect(err.code).toBe("ENOENT");
    expect(err.message).toBe("ENOENT: no such file or directory, stat '/x'");
  });
});
