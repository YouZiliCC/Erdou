import { describe, it, expect } from "vitest";
import { copyWorkspace } from "./workspace-copy.js";
import { Vfs } from "@erdou/runtime-browser";

describe("copyWorkspace", () => {
  it("copies files + nested dirs across two FileSystemApi, skipping VM skeleton dirs", () => {
    const from = new Vfs();
    const to = new Vfs();
    from.mkdir("/sub", { recursive: true });
    from.writeFile("/a.txt", "one");
    from.writeFile("/sub/b.txt", "two");
    from.mkdir("/bin", { recursive: true });
    from.writeFile("/bin/x", "system"); // skeleton — must be skipped
    copyWorkspace(from, to);
    expect(new TextDecoder().decode(to.readFile("/a.txt"))).toBe("one");
    expect(new TextDecoder().decode(to.readFile("/sub/b.txt"))).toBe("two");
    expect(to.exists("/bin/x")).toBe(false); // skeleton skipped
  });

  it("MIRRORS: clears stale destination entries but preserves skeleton mount points", () => {
    const from = new Vfs();
    const to = new Vfs();
    from.writeFile("/keep.txt", "new");
    to.writeFile("/stale.txt", "should-be-gone"); // present in dest, absent in source
    to.mkdir("/bin", { recursive: true });
    to.writeFile("/bin/sh", "system"); // skeleton in dest — must survive
    copyWorkspace(from, to);
    expect(new TextDecoder().decode(to.readFile("/keep.txt"))).toBe("new");
    expect(to.exists("/stale.txt")).toBe(false); // deletion did NOT resurrect (plan-review I1)
    expect(to.exists("/bin/sh")).toBe(true); // skeleton mount point preserved
  });
});
