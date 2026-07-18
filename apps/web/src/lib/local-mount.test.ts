import { describe, it, expect } from "vitest";
import { Vfs } from "@erdou/runtime-browser";
import {
  loadFolderIntoVfs,
  saveVfsToFolder,
  mirrorVfsToFolder,
  mirrorFolderToVfs,
  rescanFolder,
  type MountMtimes,
} from "./local-mount.js";
import { VM_PRESERVE_DIRS } from "./kernel.js";
import { MockDir, MockFile } from "./test-support/mock-dir.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("local folder mount", () => {
  it("loads a folder into the VFS, then syncs changes back to disk", async () => {
    const root = new MockDir("project");
    root.children.set("README.md", new MockFile(enc.encode("# Hi")));
    const src = new MockDir("src");
    src.children.set("main.ts", new MockFile(enc.encode("console.log(1)")));
    root.children.set("src", src);

    const fs = new Vfs({ clock: () => 0 });
    const count = await loadFolderIntoVfs(root, fs, "/");
    expect(count).toBe(2);
    expect(fs.readFileText("/README.md")).toBe("# Hi");
    expect(fs.readFileText("/src/main.ts")).toBe("console.log(1)");

    // The agent changes a file and adds a new one...
    fs.writeFile("/README.md", "# Changed");
    fs.writeFile("/src/new.ts", "export const x = 1;");
    await saveVfsToFolder(fs, root, "/");

    // ...and it lands back in the (mock) local folder.
    expect(dec.decode((root.children.get("README.md") as MockFile).data)).toBe("# Changed");
    const savedSrc = root.children.get("src") as MockDir;
    expect(dec.decode((savedSrc.children.get("new.ts") as MockFile).data)).toBe("export const x = 1;");
  });

  it("skips .git, node_modules and .erdou on load", async () => {
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("x")));
    root.children.set(".git", new MockDir(".git"));
    root.children.set("node_modules", new MockDir("node_modules"));
    root.children.set(".erdou", new MockDir(".erdou"));
    const fs = new Vfs({ clock: () => 0 });
    await loadFolderIntoVfs(root, fs, "/");
    expect(fs.exists("/a.txt")).toBe(true);
    expect(fs.exists("/.git")).toBe(false);
    expect(fs.exists("/node_modules")).toBe(false);
    expect(fs.exists("/.erdou")).toBe(false);
  });

  it("rescanFolder pulls a file whose disk mtime changed", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);
    expect(fs.readFileText("/a.txt")).toBe("v1");

    // simulate an external edit: same handle, newer content + mtime
    root.children.set("a.txt", new MockFile(enc.encode("v2"), 2000));
    const pulled = await rescanFolder(root, fs, mtimes, "/");
    expect(pulled).toContain("/a.txt");
    expect(fs.readFileText("/a.txt")).toBe("v2");
  });

  it("saveVfsToFolder skips rootSkip entries only at the root — a same-named nested dir is a real project dir and is written", async () => {
    // Final-review Fix 2: the VM kernel's readdir("/") exposes its skeleton
    // bind-mount stub dirs (bin/lib/usr/proc/dev/tmp) alongside real project
    // files. `rootSkip` lets a folder save omit them, but ONLY at the
    // workspace root — a project that happens to have its own `/src/bin/`
    // must still sync normally.
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/bin", { recursive: true });
    fs.writeFile("/bin/skip-me.txt", "should not reach disk");
    fs.mkdir("/src/bin", { recursive: true });
    fs.writeFile("/src/bin/keep-me.txt", "nested bin is a real project dir");
    fs.writeFile("/src/index.ts", "export {}");

    const root = new MockDir("project");
    await saveVfsToFolder(fs, root, "/", undefined, new Set(["bin"]));

    expect(root.children.has("bin")).toBe(false); // top-level "bin" was skipped

    const src = root.children.get("src") as MockDir;
    expect(src).toBeDefined();
    expect(src.children.has("index.ts")).toBe(true); // src/ itself was written

    const nestedBin = src.children.get("bin") as MockDir;
    expect(nestedBin).toBeDefined(); // src/bin/ was written (not root-level)
    expect(dec.decode((nestedBin.children.get("keep-me.txt") as MockFile).data)).toBe(
      "nested bin is a real project dir",
    );
  });

  it("saveVfsToFolder with VM_PRESERVE_DIRS keeps the VM-baked /etc,/root config off the user's real folder", async () => {
    // Round 13 (R12.5 IMP2 class): a VM carries baked /etc/pip.conf +
    // /root/.npmrc IN its 9p workspace root. When a VM has a real folder
    // mounted, the folder save must NOT dump those image-owned config dirs
    // onto the user's disk — studio passes VM_PRESERVE_DIRS (skeleton + etc +
    // root) as `rootSkip` for the VM kernel, not the bare SKELETON_DIRS.
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/etc", { recursive: true });
    fs.writeFile("/etc/pip.conf", "baked");
    fs.mkdir("/root", { recursive: true });
    fs.writeFile("/root/.npmrc", "baked");
    fs.writeFile("/app.py", "print(1)"); // real user file

    const root = new MockDir("project");
    await saveVfsToFolder(fs, root, "/", undefined, new Set(VM_PRESERVE_DIRS));

    expect(root.children.has("etc")).toBe(false); // baked config not written to disk
    expect(root.children.has("root")).toBe(false);
    expect(root.children.has("app.py")).toBe(true); // real user file still synced
  });

  it("rescanFolder does not re-pull a file the browser just wrote back", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);
    fs.writeFile("/a.txt", "local-edit");
    await saveVfsToFolder(fs, root, "/", mtimes); // records the written mtime
    const pulled = await rescanFolder(root, fs, mtimes, "/");
    expect(pulled).toEqual([]); // our own write is not seen as external
  });

  // --- Round 14 A1: never clobber an external edit with stale VFS bytes ---

  it("saveVfsToFolder skips a file edited externally since the last sync and reports it as a conflict", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("app.py", new MockFile(enc.encode("v1"), 1000));
    root.children.set("other.txt", new MockFile(enc.encode("o1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    // The user edits app.py in an external editor (new bytes + newer mtime)...
    root.children.set("app.py", new MockFile(enc.encode("external-edit"), 2000));
    // ...and an unrelated VFS change triggers the debounced whole-tree save.
    fs.writeFile("/other.txt", "o2");

    const result = await saveVfsToFolder(fs, root, "/", mtimes);
    expect(result.conflicts).toEqual(["/app.py"]);
    expect(result.written).toEqual(["/other.txt"]);
    // The external edit survives on disk — it was NOT clobbered by stale "v1".
    expect(dec.decode((root.children.get("app.py") as MockFile).data)).toBe("external-edit");
    // The recorded mtime stays stale on purpose, so the background rescan
    // pulls the external edit into the VFS as the resolution path.
    expect(mtimes.get("/app.py")).toBe(1000);
    const pulled = await rescanFolder(root, fs, mtimes, "/");
    expect(pulled).toContain("/app.py");
    expect(fs.readFileText("/app.py")).toBe("external-edit");
  });

  it("saveVfsToFolder adopts the disk mtime without rewriting when an external touch left identical bytes", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("same"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    // External touch: newer mtime, same bytes (e.g. a formatter no-op save).
    root.children.set("a.txt", new MockFile(enc.encode("same"), 2000));
    const result = await saveVfsToFolder(fs, root, "/", mtimes);
    expect(result.conflicts).toEqual([]);
    expect(result.written).toEqual([]); // no pointless rewrite
    expect(mtimes.get("/a.txt")).toBe(2000); // disk mtime adopted
    expect((root.children.get("a.txt") as MockFile).lastModified).toBe(2000); // untouched
  });

  it("saveVfsToFolder records the fresh disk mtime for every file it writes", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    fs.writeFile("/a.txt", "v2");
    const result = await saveVfsToFolder(fs, root, "/", mtimes);
    expect(result.written).toEqual(["/a.txt"]);
    const disk = root.children.get("a.txt") as MockFile;
    expect(mtimes.get("/a.txt")).toBe(disk.lastModified);
    expect(mtimes.get("/a.txt")).not.toBe(1000);
  });

  it("saveVfsToFolder recreates an externally-deleted file with its workspace content — never an empty conflict ghost", async () => {
    // Review regression (A1 fix wave): getFileHandle({create:true}) BEFORE the
    // conflict check resurrected an externally-deleted file as an EMPTY 0-byte
    // handle with a fresh mtime; the mtime/bytes mismatch then conflict-skipped
    // it, and the next rescan pulled the empty ghost into the VFS — destroying
    // the content on disk AND in the workspace.
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("precious.txt", new MockFile(enc.encode("precious content"), 1000));
    root.children.set("other.txt", new MockFile(enc.encode("o1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    // The user deletes precious.txt on disk (editor delete / git checkout)...
    root.children.delete("precious.txt");
    // ...and an unrelated VFS change triggers the debounced whole-tree save.
    fs.writeFile("/other.txt", "o2");

    const result = await saveVfsToFolder(fs, root, "/", mtimes);
    expect(result.conflicts).toEqual([]);
    expect(result.written.sort()).toEqual(["/other.txt", "/precious.txt"]);
    // Recreated on disk WITH content (the pre-A1 additive semantics), not 0 bytes.
    expect(dec.decode((root.children.get("precious.txt") as MockFile).data)).toBe("precious content");
    // The fresh disk mtime was recorded, so the background rescan pulls nothing
    // and the workspace copy stays intact in both places.
    const pulled = await rescanFolder(root, fs, mtimes, "/");
    expect(pulled).toEqual([]);
    expect(fs.readFileText("/precious.txt")).toBe("precious content");
    expect(dec.decode((root.children.get("precious.txt") as MockFile).data)).toBe("precious content");
  });

  it("saveVfsToFolder propagates a non-not-found getFileHandle failure instead of misreading it as a deletion", async () => {
    // Fail-fast guard on the create-less probe: only NotFoundError/ENOENT means
    // "deleted on disk" — a permission or I/O failure must surface, not silently
    // rewrite the file (which could clobber an external edit we couldn't read).
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    root.getFileHandle = async () => {
      throw new Error("NotAllowedError: permission revoked");
    };
    fs.writeFile("/a.txt", "v2");
    await expect(saveVfsToFolder(fs, root, "/", mtimes)).rejects.toThrow(/permission revoked/);
  });

  // --- Round 14 A6: explicit Push is a true mirror (deletes disk-only entries) ---

  it("mirrorVfsToFolder deletes disk-only entries but never inside SKIP dirs, and purges their mtimes", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("app.py", new MockFile(enc.encode("keep"), 1000));
    root.children.set("stale.txt", new MockFile(enc.encode("old"), 1000));
    const staleDir = new MockDir("stale-dir");
    staleDir.children.set("old.txt", new MockFile(enc.encode("old"), 1000));
    root.children.set("stale-dir", staleDir);
    const git = new MockDir(".git");
    git.children.set("config", new MockFile(enc.encode("[core]"), 1000));
    root.children.set(".git", git);
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    // The user deletes the stale entries in the workspace...
    fs.rm("/stale.txt");
    fs.rm("/stale-dir", { recursive: true });

    const result = await mirrorVfsToFolder(fs, root, mtimes);
    expect(result.deleted.sort()).toEqual(["/stale-dir", "/stale.txt"]);
    expect(root.children.has("stale.txt")).toBe(false);
    expect(root.children.has("stale-dir")).toBe(false);
    expect(root.children.has("app.py")).toBe(true);
    // SKIP dirs are untouchable — .git and its contents survive the mirror.
    expect((root.children.get(".git") as MockDir).children.has("config")).toBe(true);
    // Recorded mtimes for deleted paths are purged; kept files stay recorded.
    expect(mtimes.has("/stale.txt")).toBe(false);
    expect(mtimes.has("/stale-dir/old.txt")).toBe(false);
    expect(mtimes.has("/app.py")).toBe(true);
  });

  it("mirrorVfsToFolder honors rootSkip at the root only and still skips conflicted files", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("app.py", new MockFile(enc.encode("v1"), 1000));
    const bin = new MockDir("bin");
    bin.children.set("tool", new MockFile(enc.encode("bin"), 1000));
    root.children.set("bin", bin);
    const src = new MockDir("src");
    src.children.set("index.ts", new MockFile(enc.encode("i1"), 1000));
    const nestedBin = new MockDir("bin");
    nestedBin.children.set("gone.txt", new MockFile(enc.encode("x"), 1000));
    src.children.set("bin", nestedBin);
    root.children.set("src", src);
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    fs.rm("/src/bin", { recursive: true }); // deleted in the workspace
    root.children.set("app.py", new MockFile(enc.encode("external"), 2000)); // external edit

    const result = await mirrorVfsToFolder(fs, root, mtimes, new Set(["bin"]));
    // rootSkip: the root-level bin/ is image-owned territory — never deleted...
    expect(root.children.has("bin")).toBe(true);
    // ...but the nested project dir src/bin/ mirrors the workspace deletion.
    expect((root.children.get("src") as MockDir).children.has("bin")).toBe(false);
    expect(result.deleted).toEqual(["/src/bin"]);
    // The conflict-skip applies on the mirror's write pass too — and a
    // conflicted file exists in both trees, so the prune never deletes it.
    expect(result.conflicts).toEqual(["/app.py"]);
    expect(dec.decode((root.children.get("app.py") as MockFile).data)).toBe("external");
  });

  it("mirrorVfsToFolder refuses to mirror an empty workspace instead of emptying the folder", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const root = new MockDir("project");
    root.children.set("precious.txt", new MockFile(enc.encode("data"), 1000));

    await expect(mirrorVfsToFolder(fs, root)).rejects.toThrow(/Refusing to mirror an empty workspace/);
    expect(root.children.has("precious.txt")).toBe(true); // nothing was deleted

    // VM kernel shape: only image-owned dirs in the VFS root (all in rootSkip)
    // still counts as "no user files" — baked /etc config must not qualify.
    fs.mkdir("/etc", { recursive: true });
    fs.writeFile("/etc/pip.conf", "baked");
    await expect(mirrorVfsToFolder(fs, root, undefined, new Set(VM_PRESERVE_DIRS))).rejects.toThrow(
      /Refusing to mirror an empty workspace/,
    );
    expect(root.children.has("precious.txt")).toBe(true);
  });

  it("mirrorVfsToFolder no-ops an empty workspace onto a folder with nothing deletable, instead of refusing", async () => {
    // The refusal is a DATA fail-safe, not a ritual: pushing an empty workspace
    // to a freshly created (empty) folder destroys nothing and must succeed as
    // "0 written, 0 deleted" — the refusal fires only when disk files would die.
    const fs = new Vfs({ clock: () => 0 });
    const root = new MockDir("new");
    expect(await mirrorVfsToFolder(fs, root)).toEqual({ written: [], conflicts: [], deleted: [] });

    // SKIP-dir content on disk is never deletable — still a no-op success.
    const git = new MockDir(".git");
    git.children.set("config", new MockFile(enc.encode("[core]"), 1000));
    root.children.set(".git", git);
    expect(await mirrorVfsToFolder(fs, root)).toEqual({ written: [], conflicts: [], deleted: [] });
    expect((root.children.get(".git") as MockDir).children.has("config")).toBe(true);

    // rootSkip'd disk files aren't deletable either (image-owned territory)...
    const bin = new MockDir("bin");
    bin.children.set("tool", new MockFile(enc.encode("t"), 1000));
    root.children.set("bin", bin);
    expect(await mirrorVfsToFolder(fs, root, undefined, new Set(["bin"]))).toEqual({
      written: [],
      conflicts: [],
      deleted: [],
    });
    expect(root.children.has("bin")).toBe(true);
    // ...but WITHOUT the rootSkip the same disk file is deletable → refusal.
    await expect(mirrorVfsToFolder(fs, root)).rejects.toThrow(/Refusing to mirror an empty workspace/);

    // Non-empty workspace onto the empty-ish folder: the normal mirror runs.
    fs.writeFile("/app.py", "print(1)");
    const result = await mirrorVfsToFolder(fs, root, undefined, new Set(["bin"]));
    expect(result.written).toEqual(["/app.py"]);
    expect(result.deleted).toEqual([]);
  });

  it("mirrorVfsToFolder refuses an empty workspace when the only disk data is SKIP content NESTED in a deletable dir", async () => {
    // Fix-pass regression (reviewer probe): the guard used to count disk files
    // with SKIP excluded at EVERY level, but with an empty workspace the prune
    // never recurses — vendor/ is disk-only, so removeEntry("vendor",
    // {recursive:true}) destroys the nested .git wholesale. A guard that calls
    // that "0 deletable files" wipes exactly the data class SKIP exists to
    // protect. Nested SKIP content must count as deletable; only ROOT-level
    // SKIP names (which the prune itself skips) are shielded.
    const fs = new Vfs({ clock: () => 0 });
    const root = new MockDir("project");
    const vendor = new MockDir("vendor");
    const vendorGit = new MockDir(".git");
    vendorGit.children.set("config", new MockFile(enc.encode("[core]"), 1000));
    vendor.children.set(".git", vendorGit);
    root.children.set("vendor", vendor);

    await expect(mirrorVfsToFolder(fs, root)).rejects.toThrow(/Refusing to mirror an empty workspace/);
    // The vendored repo survives untouched.
    const diskVendor = root.children.get("vendor") as MockDir;
    expect((diskVendor.children.get(".git") as MockDir).children.has("config")).toBe(true);
  });

  it("mirrorVfsToFolder converges a file↔directory type flip in both directions instead of dying mid-mirror", async () => {
    // Known Push gap: the save pass's getFileHandle/getDirectoryHandle reject
    // with TypeMismatchError when the disk entry's kind differs from the
    // workspace's — the prune pass must run FIRST and remove the flipped entry
    // (counted in `deleted`) so the mirror converges.
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("cfg", new MockFile(enc.encode("was-a-file"), 1000));
    const data = new MockDir("data");
    data.children.set("d.txt", new MockFile(enc.encode("dd"), 1000));
    root.children.set("data", data);
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    // The workspace flips both kinds: cfg file→dir, data dir→file.
    fs.rm("/cfg");
    fs.mkdir("/cfg", { recursive: true });
    fs.writeFile("/cfg/nested.txt", "n");
    fs.rm("/data", { recursive: true });
    fs.writeFile("/data", "now-a-file");

    const result = await mirrorVfsToFolder(fs, root, mtimes);
    expect(result.deleted.sort()).toEqual(["/cfg", "/data"]);
    expect(result.conflicts).toEqual([]);
    const diskCfg = root.children.get("cfg") as MockDir;
    expect(diskCfg).toBeInstanceOf(MockDir);
    expect(dec.decode((diskCfg.children.get("nested.txt") as MockFile).data)).toBe("n");
    const diskData = root.children.get("data") as MockFile;
    expect(diskData).toBeInstanceOf(MockFile);
    expect(dec.decode(diskData.data)).toBe("now-a-file");
    // Stale mtimes under the flipped dir were purged; the new writes recorded.
    expect(mtimes.has("/data/d.txt")).toBe(false);
    expect(mtimes.has("/data")).toBe(true);
    expect(mtimes.has("/cfg/nested.txt")).toBe(true);
  });

  // --- manual Pull is a TRUE MIRROR too (disk → workspace), symmetric with Push ---

  it("mirrorFolderToVfs deletes workspace-only entries but never SKIP dirs or rootSkip'd root dirs, and reports loaded/deleted", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("app.py", new MockFile(enc.encode("disk"), 1000));
    const src = new MockDir("src");
    src.children.set("main.ts", new MockFile(enc.encode("m1"), 1000));
    root.children.set("src", src);
    await loadFolderIntoVfs(root, fs, "/", mtimes);

    // Workspace grows entries the disk doesn't have...
    fs.writeFile("/app.py", "local-edit"); // content: disk must win
    fs.writeFile("/workspace-only.txt", "w");
    fs.mkdir("/gen", { recursive: true });
    fs.writeFile("/gen/out.js", "g");
    // ...plus agent-installed deps + image-owned VM dirs that must SURVIVE.
    fs.mkdir("/node_modules/pkg", { recursive: true });
    fs.writeFile("/node_modules/pkg/index.js", "dep");
    fs.mkdir("/etc", { recursive: true });
    fs.writeFile("/etc/pip.conf", "baked");
    // And the disk deleted src/main.ts externally since the load.
    src.children.delete("main.ts");

    const result = await mirrorFolderToVfs(root, fs, mtimes, new Set(VM_PRESERVE_DIRS));
    expect(result.deleted.sort()).toEqual(["/gen", "/src/main.ts", "/workspace-only.txt"]);
    expect(result.loaded).toBe(1);
    expect(fs.readFileText("/app.py")).toBe("disk"); // disk wins on content
    expect(fs.exists("/workspace-only.txt")).toBe(false);
    expect(fs.exists("/gen")).toBe(false);
    expect(fs.readFileText("/node_modules/pkg/index.js")).toBe("dep"); // SKIP survives
    expect(fs.readFileText("/etc/pip.conf")).toBe("baked"); // rootSkip survives
    // Deleted paths' mtimes dropped; the pulled file stays recorded, so the
    // debounced auto-save won't misread the pull as a local edit.
    expect(mtimes.has("/src/main.ts")).toBe(false);
    expect(mtimes.get("/app.py")).toBe(1000);
  });

  it("mirrorFolderToVfs converges a file↔directory type flip in both directions (disk wins)", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const root = new MockDir("project");
    // Disk: "cfg" is a FILE, "data" is a DIRECTORY.
    root.children.set("cfg", new MockFile(enc.encode("file-on-disk"), 1000));
    const data = new MockDir("data");
    data.children.set("d.txt", new MockFile(enc.encode("dd"), 1000));
    root.children.set("data", data);
    // Workspace: "cfg" is a DIRECTORY, "data" is a FILE — the load pass could
    // neither write a file over a VFS dir nor mkdir over a VFS file, so the
    // workspace-side prune must remove both flips first.
    fs.mkdir("/cfg", { recursive: true });
    fs.writeFile("/cfg/nested.txt", "x");
    fs.writeFile("/data", "file-in-workspace");

    const result = await mirrorFolderToVfs(root, fs);
    expect(result.deleted.sort()).toEqual(["/cfg", "/data"]);
    expect(result.loaded).toBe(2);
    expect(fs.readFileText("/cfg")).toBe("file-on-disk");
    expect(fs.readFileText("/data/d.txt")).toBe("dd");
  });

  it("mirrorFolderToVfs refuses an empty disk folder over a non-empty workspace, and no-ops empty-onto-empty", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const root = new MockDir("new");
    // SKIP-only disk content (a bare .git) still counts as an EMPTY folder.
    const git = new MockDir(".git");
    git.children.set("config", new MockFile(enc.encode("[core]"), 1000));
    root.children.set(".git", git);
    fs.writeFile("/precious.txt", "data");

    await expect(mirrorFolderToVfs(root, fs)).rejects.toThrow(/Refusing to mirror an empty folder/);
    expect(fs.readFileText("/precious.txt")).toBe("data"); // nothing was deleted

    // Empty-onto-empty: a no-op success, not a refusal.
    fs.rm("/precious.txt");
    expect(await mirrorFolderToVfs(root, fs)).toEqual({ loaded: 0, deleted: [] });

    // Non-empty disk onto the empty workspace: the normal mirror-load runs.
    root.children.set("app.py", new MockFile(enc.encode("print(1)"), 1000));
    expect(await mirrorFolderToVfs(root, fs)).toEqual({ loaded: 1, deleted: [] });
    expect(fs.readFileText("/app.py")).toBe("print(1)");
  });

  it("mirrorFolderToVfs refuses an empty disk folder when the workspace's only files are SKIP content NESTED in a deletable dir", async () => {
    // Fix-pass regression, pull-side twin of the vendor/.git push probe: with
    // an empty disk folder the workspace prune deletes /sub wholesale via
    // fs.rm("/sub", {recursive:true}), taking /sub/.git with it — so a
    // workspace whose only files live under a nested .git is NOT "empty" for
    // the fail-safe, even though a root-level /.git (prune-skipped) would be.
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/sub/.git", { recursive: true });
    fs.writeFile("/sub/.git/config", "[core]");
    const root = new MockDir("empty");

    await expect(mirrorFolderToVfs(root, fs)).rejects.toThrow(/Refusing to mirror an empty folder/);
    expect(fs.readFileText("/sub/.git/config")).toBe("[core]"); // repo survives untouched

    // Root-level SKIP content stays shielded from the prune AND from the
    // count: with the nested repo gone, a workspace holding only /.git is
    // genuinely undeletable data → empty-onto-empty no-op, not a refusal.
    fs.rm("/sub", { recursive: true });
    fs.mkdir("/.git", { recursive: true });
    fs.writeFile("/.git/config", "[core]");
    expect(await mirrorFolderToVfs(root, fs)).toEqual({ loaded: 0, deleted: [] });
    expect(fs.readFileText("/.git/config")).toBe("[core]");
  });
});
