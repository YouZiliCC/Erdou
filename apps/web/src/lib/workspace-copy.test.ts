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

  it("browser→VM: preserves the VM-baked /etc,/root egress configs while still mirroring user files", () => {
    // Round 13 CRITICAL: the baked package-egress configs live IN the 9p
    // workspace root at /etc/pip.conf, /etc/resolv.conf, /root/.npmrc. The
    // default flow switches browser→VM, then copies the browser Vfs (which has
    // NO /etc,/root) over the live VM. The mirror-delete pass must NOT wipe the
    // baked configs — or pip AND npm egress break on the primary R13 UI path.
    const from = new Vfs(); // browser Vfs — user project only, no /etc,/root
    const to = new Vfs(); // live VM — carries the baked configs
    from.writeFile("/keep.txt", "user file");
    to.mkdir("/etc", { recursive: true });
    to.writeFile("/etc/pip.conf", "[global]\nindex-url=http://pypi.org/simple/");
    to.writeFile("/etc/resolv.conf", "nameserver 192.168.86.1");
    to.mkdir("/root", { recursive: true });
    to.writeFile("/root/.npmrc", "registry=http://registry.npmjs.org/");
    to.writeFile("/stale.txt", "deleted-in-source"); // user file gone in source

    copyWorkspace(from, to);

    // Baked image-owned configs survive the mirror-delete pass.
    expect(to.exists("/etc/pip.conf")).toBe(true);
    expect(to.exists("/etc/resolv.conf")).toBe(true);
    expect(to.exists("/root/.npmrc")).toBe(true);
    // User files still mirror: kept file copied, stale file removed.
    expect(new TextDecoder().decode(to.readFile("/keep.txt"))).toBe("user file");
    expect(to.exists("/stale.txt")).toBe(false);
  });

  it("VM→browser: does NOT copy the VM's baked /etc,/root into the browser Vfs", () => {
    // The reverse switch must not pollute the browser workspace (which is
    // persisted + can be mirrored to a real mounted folder) with the image's
    // system config — /etc,/root are image-owned, not user project content.
    const from = new Vfs(); // VM — baked configs + a user file
    const to = new Vfs(); // browser Vfs
    from.mkdir("/etc", { recursive: true });
    from.writeFile("/etc/pip.conf", "baked");
    from.mkdir("/root", { recursive: true });
    from.writeFile("/root/.npmrc", "baked");
    from.writeFile("/app.py", "print(1)");

    copyWorkspace(from, to);

    expect(to.exists("/app.py")).toBe(true); // user file follows the switch
    expect(to.exists("/etc/pip.conf")).toBe(false); // baked config NOT copied over
    expect(to.exists("/root/.npmrc")).toBe(false);
  });
});
