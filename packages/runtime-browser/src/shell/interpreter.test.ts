import { describe, it, expect } from "vitest";
import { makeShell } from "./harness.js";

describe("Shell interpreter", () => {
  it("runs a pipeline", async () => {
    const { shell } = makeShell();
    const r = shell.execute("echo hi | grep h");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("hi\n");
  });

  it("redirects stdout to a file with > and >>", async () => {
    const { shell } = makeShell();
    await shell.run("echo x > /f.txt");
    let r = shell.execute("cat /f.txt");
    await r.wait();
    expect(await r.stdout.text()).toBe("x\n");

    await shell.run("echo y >> /f.txt");
    r = shell.execute("cat /f.txt");
    await r.wait();
    expect(await r.stdout.text()).toBe("x\ny\n");
  });

  it("feeds a file into stdin with <", async () => {
    const { shell, vfs } = makeShell();
    vfs.writeFile("/in.txt", "alpha\nbeta\n");
    const r = shell.execute("grep beta < /in.txt");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("beta\n");
  });

  it("honors && and || short-circuiting", async () => {
    const { shell } = makeShell();
    let r = shell.execute("false && echo no");
    expect(await r.wait()).toBe(1);
    expect(await r.stdout.text()).toBe("");

    r = shell.execute("false || echo yes");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("yes\n");
  });

  it("cd mutates the working directory across the pipeline", async () => {
    const { shell, vfs } = makeShell();
    vfs.mkdir("/tmp");
    const r = shell.execute("cd /tmp && pwd");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("/tmp\n");
  });

  it("export sets an environment variable used by later expansion", async () => {
    const { shell } = makeShell();
    const r = shell.execute("export A=1 && echo $A");
    expect(await r.wait()).toBe(0);
    expect(await r.stdout.text()).toBe("1\n");
  });
});
