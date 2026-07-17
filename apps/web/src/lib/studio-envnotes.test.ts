import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { Studio } from "./studio.js";
import { ERDOU_MD_TEMPLATE } from "@erdou/agent-core";

const dec = new TextDecoder();

describe("Studio.seedEnvNotes (ERDOU.md)", () => {
  it("drops the standard ERDOU.md into a workspace that has none, and never overwrites an existing one", async () => {
    const studio = new Studio();
    await studio.boot();
    const seed = (studio as unknown as { seedEnvNotes(): void }).seedEnvNotes.bind(studio);

    expect(studio.fs.exists("/ERDOU.md")).toBe(false);
    seed();
    expect(studio.fs.exists("/ERDOU.md")).toBe(true);
    expect(dec.decode(studio.fs.readFile("/ERDOU.md"))).toBe(ERDOU_MD_TEMPLATE);

    // The agent extends the file; a later run must not clobber its additions.
    studio.fs.writeFile("/ERDOU.md", ERDOU_MD_TEMPLATE + "\n- Bound the server to 0.0.0.0 so the preview can reach it.\n");
    seed();
    expect(dec.decode(studio.fs.readFile("/ERDOU.md"))).toContain("Bound the server to 0.0.0.0");
  });
});
