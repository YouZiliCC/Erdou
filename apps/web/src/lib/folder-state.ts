import type { ModelConfig } from "@erdou/model-gateway";
import type { DirHandleLike } from "./local-mount.js";
import type { Run } from "./studio.js";
import type { ApprovalMode } from "./model-config.js";
import type { Theme } from "./theme.js";

const DIR = ".erdou";
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Session state mirrored into `<mounted folder>/.erdou/` so a project is
 *  self-contained on disk: the chat history (runs) and the app's config
 *  (theme, approval mode, model — INCLUDING the api key). The api key is
 *  written in the clear; `.erdou/.gitignore` keeps `config.json` out of any
 *  `git commit` run inside the folder. That gitignore is the only guard —
 *  by design, no extra encryption/redaction on top of it. */
export interface FolderState {
  runs: Run[];
  config: {
    theme: Theme;
    approvalMode: ApprovalMode;
    model: ModelConfig;
  };
}

async function writeJson(dir: DirHandleLike, name: string, data: unknown): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(enc.encode(JSON.stringify(data, null, 2)));
  await writable.close();
}

async function writeText(dir: DirHandleLike, name: string, text: string): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(enc.encode(text));
  await writable.close();
}

/** Write `state` directly to the mounted folder's `.erdou/` subdirectory
 *  (never into the VFS — this is session metadata, not a project file). */
export async function writeFolderState(dir: DirHandleLike, state: FolderState): Promise<void> {
  const erdou = await dir.getDirectoryHandle(DIR, { create: true });
  await writeJson(erdou, "runs.json", state.runs);
  await writeJson(erdou, "config.json", state.config);
  await writeText(erdou, ".gitignore", "config.json\n");
}

/** Read one `.erdou/<name>` JSON file. `undefined` if the file itself is
 *  missing (a legitimate half-written state); a corrupt-but-present file
 *  throws instead of being silently swallowed (fail-fast). */
async function readJsonFile<T>(erdou: DirHandleLike, name: string): Promise<T | undefined> {
  let fh;
  try {
    fh = await erdou.getFileHandle(name);
  } catch {
    return undefined;
  }
  const file = await fh.getFile();
  const text = dec.decode(await file.arrayBuffer());
  return JSON.parse(text) as T; // corrupt JSON throws here, deliberately uncaught
}

/** Read session state back from the mounted folder. `null` if `.erdou`
 *  doesn't exist yet (nothing to hydrate from — the caller should seed it).
 *  A missing `runs.json` defaults to `[]`; a missing `config.json` leaves
 *  `config` undefined (the caller decides whether/what to apply). A
 *  present-but-corrupt file throws rather than returning a silent default. */
export async function readFolderState(dir: DirHandleLike): Promise<FolderState | null> {
  let erdou: DirHandleLike;
  try {
    erdou = await dir.getDirectoryHandle(DIR);
  } catch {
    return null;
  }
  const runs = (await readJsonFile<Run[]>(erdou, "runs.json")) ?? [];
  const config = await readJsonFile<FolderState["config"]>(erdou, "config.json");
  return { runs, config: config as FolderState["config"] };
}
