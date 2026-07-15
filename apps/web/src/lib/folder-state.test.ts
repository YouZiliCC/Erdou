import { describe, it, expect } from "vitest";
import type { Run } from "./studio.js";
import { MockDir, MockFile } from "./test-support/mock-dir.js";
import { writeFolderState, readFolderState, type FolderState } from "./folder-state.js";

const dec = new TextDecoder();

async function readFileText(dir: MockDir, path: string): Promise<string> {
  const parts = path.split("/");
  const fileName = parts.pop()!;
  let cur: MockDir = dir;
  for (const p of parts) {
    cur = (await cur.getDirectoryHandle(p)) as MockDir;
  }
  const fh = (await cur.getFileHandle(fileName)) as MockFile;
  const file = await fh.getFile();
  return dec.decode(await file.arrayBuffer());
}

const sampleState = (): FolderState => ({
  runs: [{ id: "1" } as unknown as Run],
  config: {
    apiKey: "sk-x",
    model: "m",
    approvalMode: "auto",
    theme: "dark",
  } as unknown as FolderState["config"],
});

describe("folder-state", () => {
  it("writes and reads back .erdou state incl. the api key and a gitignore", async () => {
    const dir = new MockDir("project");
    await writeFolderState(dir, sampleState());

    const st = await readFolderState(dir);
    expect(st?.runs[0]?.id).toBe("1");
    expect((st?.config as unknown as { apiKey: string })?.apiKey).toBe("sk-x");

    const gi = await readFileText(dir, ".erdou/.gitignore");
    expect(gi).toContain("config.json");
  });

  it("returns null when the folder has no .erdou", async () => {
    const dir = new MockDir("project");
    const st = await readFolderState(dir);
    expect(st).toBeNull();
  });

  it("throws (fail-fast) on a corrupt config.json rather than swallowing it", async () => {
    const dir = new MockDir("project");
    await writeFolderState(dir, sampleState());
    const erdou = await dir.getDirectoryHandle(".erdou");
    const fh = await erdou.getFileHandle("config.json");
    (fh as MockFile).data = new TextEncoder().encode("{ not json");

    await expect(readFolderState(dir)).rejects.toThrow();
  });

  it("defaults runs to [] when runs.json is missing but .erdou exists", async () => {
    const dir = new MockDir("project");
    await writeFolderState(dir, sampleState());
    const erdou = (await dir.getDirectoryHandle(".erdou")) as MockDir;
    erdou.children.delete("runs.json");

    const st = await readFolderState(dir);
    expect(st?.runs).toEqual([]);
  });
});
