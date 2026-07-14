import { describe, it, expect } from "vitest";
import { resolvePath } from "./resolve.js";
import { newDir, newFile, newSymlink, type DirInode } from "./inode.js";

const NOW = 1000;

function tree(): DirInode {
  // /a           (dir)
  // /a/b         (dir)
  // /a/f         (file "hi")
  // /a/link      (symlink -> b)      relative
  // /a/self      (symlink -> /a/self) self-referential
  const root = newDir(NOW);
  const a = newDir(NOW);
  const b = newDir(NOW);
  const f = newFile(new TextEncoder().encode("hi"), NOW);
  root.children.set("a", a);
  a.children.set("b", b);
  a.children.set("f", f);
  a.children.set("link", newSymlink("b", NOW));
  a.children.set("self", newSymlink("/a/self", NOW));
  return root;
}

describe("resolvePath", () => {
  it("resolves an existing file to its parent, name and node", () => {
    const r = resolvePath(tree(), "/a/f", { followSymlinks: true });
    expect(r.name).toBe("f");
    expect(r.node?.type).toBe("file");
    expect(r.parent.type).toBe("directory");
  });

  it("returns node undefined for a missing final component", () => {
    const r = resolvePath(tree(), "/a/missing", { followSymlinks: true });
    expect(r.name).toBe("missing");
    expect(r.node).toBeUndefined();
    expect(r.parent.children.has("f")).toBe(true); // parent is /a
  });

  it("throws ENOTDIR when descending into a file", () => {
    expect(() => resolvePath(tree(), "/a/f/x", { followSymlinks: true })).toThrow(/ENOTDIR/);
  });

  it("throws ENOENT when an intermediate directory is missing", () => {
    expect(() => resolvePath(tree(), "/nope/x", { followSymlinks: true })).toThrow(/ENOENT/);
  });

  it("follows a symlink to a directory when followSymlinks is set", () => {
    const followed = resolvePath(tree(), "/a/link", { followSymlinks: true });
    expect(followed.node?.type).toBe("directory");
    const notFollowed = resolvePath(tree(), "/a/link", { followSymlinks: false });
    expect(notFollowed.node?.type).toBe("symlink");
  });

  it("throws ELOOP on a self-referential symlink", () => {
    expect(() => resolvePath(tree(), "/a/self", { followSymlinks: true })).toThrow(/ELOOP/);
  });

  it("resolves the root itself", () => {
    const root = tree();
    const r = resolvePath(root, "/", { followSymlinks: true });
    expect(r.node).toBe(root);
  });
});
