// Studio.exportProject: the session-only export registry, the kind:"artifact"
// trace line the download card renders from, object-URL hygiene on replace,
// and the persistence round-trip (the trace line survives runs-store as plain
// JSON while the blob deliberately does not — the reload story).
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Studio, parseArtifactDetail, type Run } from "./studio.js";
import { saveRuns, loadRuns, clearRuns } from "./runs-store.js";

const mkRun = (id: string): Run => ({
  id,
  title: id,
  task: id,
  status: "done",
  trace: [],
  changes: [],
  messages: [],
  createdAt: 1,
});

let urlSeq = 0;
const revoked: string[] = [];

describe("Studio.exportProject", () => {
  beforeEach(() => {
    urlSeq = 0;
    revoked.length = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:erdou/${++urlSeq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => void revoked.push(u));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearRuns();
  });

  async function bootedStudio(): Promise<Studio> {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/app.py", "print('hi')");
    return studio;
  }

  it("registers the export and logs an artifact line on the systemLog when no run is active", async () => {
    const studio = await bootedStudio();
    expect(studio.activeRun).toBeUndefined();

    const e = studio.exportProject();
    expect(e.name).toBe("erdou-project.zip"); // no mounted folder -> the default name
    expect(e.fileCount).toBe(1);
    expect(e.byteSize).toBeGreaterThan(0);
    expect(e.url).toBe("blob:erdou/1");
    expect(studio.exports.get(e.exportId)).toEqual({
      url: e.url,
      name: e.name,
      byteSize: e.byteSize,
      fileCount: e.fileCount,
    });

    const line = studio.systemLog.find((l) => l.kind === "artifact");
    expect(line).toBeDefined();
    expect(parseArtifactDetail(line!.detail)).toEqual({
      exportId: e.exportId,
      name: e.name,
      byteSize: e.byteSize,
      fileCount: e.fileCount,
    });
  });

  it("appends the artifact line to the ACTIVE run and its detail round-trips runs-store untouched", async () => {
    const studio = await bootedStudio();
    const run = mkRun("r1");
    studio.runs = [run, ...studio.runs];
    studio.selectRun("r1");

    const e = studio.exportProject("demo");
    expect(e.name).toBe("demo.zip");
    const line = run.trace.find((l) => l.kind === "artifact");
    expect(line).toBeDefined();
    expect(studio.systemLog.some((l) => l.kind === "artifact")).toBe(false);

    // run.trace persists as plain JSON — the artifact detail must survive
    // save/load byte-identical, so a reloaded browser can still parse the card.
    await saveRuns(studio.runs);
    const loaded = await loadRuns();
    const stored = loaded.find((r) => r.id === "r1")!.trace.find((l) => l.kind === "artifact");
    expect(stored?.detail).toBe(line!.detail);
    expect(parseArtifactDetail(stored?.detail)?.exportId).toBe(e.exportId);
    // ...while the blob registry is session-only: a fresh Studio has no entry
    // for the persisted id — the UI renders that as the expired card.
    expect(new Studio().exports.has(e.exportId)).toBe(false);
  });

  it("a targetRun overrides the selected thread — the card lands on the INVOKING run (package_project mid-run switch)", async () => {
    // The real flow: agent running thread A, user clicks older done thread B
    // (or New Draft) in the sidebar, agent calls package_project. The tool
    // passes its captured run, so the card must land on A — never on B, never
    // on the systemLog.
    const studio = await bootedStudio();
    const invoking = mkRun("a-running");
    const selected = mkRun("b-done");
    studio.runs = [invoking, selected, ...studio.runs];
    studio.selectRun("b-done");

    const e = studio.exportProject("mid-switch", invoking);
    expect(parseArtifactDetail(invoking.trace.find((l) => l.kind === "artifact")?.detail)?.exportId).toBe(e.exportId);
    expect(selected.trace.some((l) => l.kind === "artifact")).toBe(false);
    expect(studio.systemLog.some((l) => l.kind === "artifact")).toBe(false);

    // New Draft variant: nothing selected at all — targetRun still wins over
    // the systemLog fallback.
    studio.newDraft();
    const e2 = studio.exportProject("draft-switch", invoking);
    expect(parseArtifactDetail(invoking.trace.at(-1)?.detail)?.exportId).toBe(e2.exportId);
    expect(studio.systemLog.some((l) => l.kind === "artifact")).toBe(false);
  });

  it("a new export revokes and drops the previous one (no blob leak; the old card goes expired)", async () => {
    const studio = await bootedStudio();
    const first = studio.exportProject();
    expect(revoked).toEqual([]);

    const second = studio.exportProject();
    expect(revoked).toEqual([first.url]); // previous object URL released
    expect(studio.exports.has(first.exportId)).toBe(false); // registry honest: first card is now expired
    expect(studio.exports.has(second.exportId)).toBe(true);
    expect(studio.exports.size).toBe(1);
  });

  it("a supplied name gets .zip appended exactly once; the mounted folder name is the default base", async () => {
    const studio = await bootedStudio();
    expect(studio.exportProject("My App.zip").name).toBe("My App.zip");
    expect(studio.exportProject("notes").name).toBe("notes.zip");
    studio.mountName = "my-repo";
    expect(studio.exportProject().name).toBe("my-repo.zip");
  });

  it("an empty workspace throws (no registry entry, no trace line)", async () => {
    const studio = new Studio();
    await studio.boot();
    expect(() => studio.exportProject()).toThrow(/Nothing to export/);
    expect(studio.exports.size).toBe(0);
    expect(studio.systemLog.some((l) => l.kind === "artifact")).toBe(false);
  });
});

describe("parseArtifactDetail", () => {
  it("rejects missing, malformed, and wrong-shaped payloads", () => {
    expect(parseArtifactDetail(undefined)).toBeNull();
    expect(parseArtifactDetail("not json")).toBeNull();
    expect(parseArtifactDetail('{"exportId":"x"}')).toBeNull();
    expect(parseArtifactDetail('{"exportId":"x","name":"a.zip","byteSize":"big","fileCount":1}')).toBeNull();
  });
});
