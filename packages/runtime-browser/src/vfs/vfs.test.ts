import { describe, it, expect } from "vitest";
import { Vfs } from "./vfs.js";
import type { RuntimeEvent } from "@erdou/runtime-contract";

function make() {
  const events: RuntimeEvent[] = [];
  let t = 1000;
  const vfs = new Vfs({ clock: () => t++, onEvent: (e) => events.push(e) });
  return { vfs, events };
}

describe("Vfs files", () => {
  it("round-trips bytes and utf-8 strings", () => {
    const { vfs } = make();
    vfs.writeFile("/a.txt", "hello");
    expect(new TextDecoder().decode(vfs.readFile("/a.txt"))).toBe("hello");
    vfs.writeFile("/b.bin", new Uint8Array([1, 2, 3]));
    expect([...vfs.readFile("/b.bin")]).toEqual([1, 2, 3]);
  });

  it("readFile on a missing path throws ENOENT with path + syscall", () => {
    const { vfs } = make();
    try {
      vfs.readFile("/missing");
      throw new Error("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
      expect(err.path).toBe("/missing");
      expect(err.syscall).toBe("open");
    }
  });

  it("does NOT auto-create parent directories (no fallback)", () => {
    const { vfs } = make();
    expect(() => vfs.writeFile("/a/b/c.txt", "x")).toThrow(/ENOENT/);
  });

  it("readFile on a directory throws EISDIR", () => {
    const { vfs } = make();
    vfs.mkdir("/d");
    expect(() => vfs.readFile("/d")).toThrow(/EISDIR/);
  });

  it("appendFile creates then appends", () => {
    const { vfs } = make();
    vfs.appendFile("/log", "a");
    vfs.appendFile("/log", "b");
    expect(vfs.readFileText("/log")).toBe("ab");
  });

  it("returned bytes are copies — mutating them does not corrupt the file", () => {
    const { vfs } = make();
    vfs.writeFile("/x", "abc");
    const bytes = vfs.readFile("/x");
    bytes[0] = 0;
    expect(vfs.readFileText("/x")).toBe("abc");
  });
});

describe("Vfs directories", () => {
  it("mkdir recursive creates the whole chain; existing is a no-op", () => {
    const { vfs } = make();
    vfs.mkdir("/a/b/c", { recursive: true });
    expect(vfs.stat("/a/b/c").type).toBe("directory");
    expect(() => vfs.mkdir("/a/b/c", { recursive: true })).not.toThrow();
  });

  it("mkdir non-recursive with missing parent throws ENOENT; existing throws EEXIST", () => {
    const { vfs } = make();
    expect(() => vfs.mkdir("/a/b")).toThrow(/ENOENT/);
    vfs.mkdir("/a");
    expect(() => vfs.mkdir("/a")).toThrow(/EEXIST/);
  });

  it("readdir returns sorted entries; on a file throws ENOTDIR", () => {
    const { vfs } = make();
    vfs.mkdir("/d");
    vfs.writeFile("/d/z", "1");
    vfs.writeFile("/d/a", "1");
    vfs.mkdir("/d/m");
    expect(vfs.readdir("/d")).toEqual([
      { name: "a", type: "file" },
      { name: "m", type: "directory" },
      { name: "z", type: "file" },
    ]);
    expect(() => vfs.readdir("/d/a")).toThrow(/ENOTDIR/);
  });

  it("rm honors recursive, force and ENOTEMPTY", () => {
    const { vfs } = make();
    vfs.mkdir("/d");
    vfs.writeFile("/d/f", "1");
    expect(() => vfs.rm("/d")).toThrow(/ENOTEMPTY/);
    expect(() => vfs.rm("/missing")).toThrow(/ENOENT/);
    expect(() => vfs.rm("/missing", { force: true })).not.toThrow();
    vfs.rm("/d", { recursive: true });
    expect(vfs.exists("/d")).toBe(false);
  });
});

describe("Vfs rename / stat / symlinks", () => {
  it("rename moves a file and a directory subtree", () => {
    const { vfs } = make();
    vfs.mkdir("/src", { recursive: true });
    vfs.writeFile("/src/f", "hi");
    vfs.rename("/src/f", "/g");
    expect(vfs.readFileText("/g")).toBe("hi");
    expect(vfs.exists("/src/f")).toBe(false);
    vfs.rename("/src", "/dst");
    expect(vfs.stat("/dst").type).toBe("directory");
  });

  it("stat follows symlinks, lstat does not", () => {
    const { vfs } = make();
    vfs.writeFile("/target", "data");
    vfs.symlink("/target", "/link");
    expect(vfs.stat("/link").type).toBe("file");
    expect(vfs.lstat("/link").type).toBe("symlink");
    expect(vfs.readFileText("/link")).toBe("data");
    expect(vfs.readlink("/link")).toBe("/target");
  });
});

describe("rename", () => {
  it("mv into an existing directory keeps the source name (the reported bug)", () => {
    const fs = new Vfs();
    fs.mkdir("/1", { recursive: true });
    fs.mkdir("/1/src", { recursive: true });
    fs.writeFile("/1/src/a.txt", "hi");
    // `mv /1/src /`  — destination is the root directory
    fs.rename("/1/src", "/");
    expect(fs.exists("/src")).toBe(true);
    expect(fs.exists("/src/a.txt")).toBe(true);
    expect(fs.exists("/1/src")).toBe(false);
    // no phantom entry literally named "/"
    expect(fs.readdir("/").map((e) => e.name).sort()).toEqual(["1", "src"]);
  });

  it("mv a file into a directory with a trailing form", () => {
    const fs = new Vfs();
    fs.mkdir("/dir", { recursive: true });
    fs.writeFile("/a.txt", "x");
    fs.rename("/a.txt", "/dir");
    expect(fs.exists("/dir/a.txt")).toBe(true);
    expect(fs.exists("/a.txt")).toBe(false);
  });

  it("mv a dir onto an existing dir moves it inside", () => {
    const fs = new Vfs();
    fs.mkdir("/a", { recursive: true });
    fs.mkdir("/b", { recursive: true });
    fs.rename("/a", "/b");
    expect(fs.exists("/b/a")).toBe(true);
  });

  it("mv rejects moving a directory into itself or a descendant", () => {
    const fs = new Vfs();
    fs.mkdir("/a", { recursive: true });
    expect(() => fs.rename("/a", "/a")).toThrow(/EINVAL/);
    fs.mkdir("/a/b", { recursive: true });
    expect(() => fs.rename("/a", "/a/b")).toThrow(/EINVAL/);
  });

  it("plain rename (destination absent) still works", () => {
    const fs = new Vfs();
    fs.writeFile("/a.txt", "x");
    fs.rename("/a.txt", "/b.txt");
    expect(fs.exists("/b.txt")).toBe(true);
    expect(fs.exists("/a.txt")).toBe(false);
  });
});

describe("Vfs events", () => {
  it("emits file.changed for create, modify and delete", () => {
    const { vfs, events } = make();
    vfs.writeFile("/f", "1");
    vfs.writeFile("/f", "2");
    vfs.rm("/f");
    expect(events).toEqual([
      { type: "file.changed", path: "/f", kind: "create" },
      { type: "file.changed", path: "/f", kind: "modify" },
      { type: "file.changed", path: "/f", kind: "delete" },
    ]);
  });
});
