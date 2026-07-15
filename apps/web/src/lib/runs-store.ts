import type { Run } from "./studio.js";

const DB = "erdou-runs";
const STORE = "runs";
const KEY = "all";
const MAX_RUNS = 20;

/** Keep only the most-recent runs (runs are stored most-recent-first). Pure. */
export function capRuns(runs: Run[]): Run[] {
  return runs.slice(0, MAX_RUNS);
}

/** Persists the run history in the browser's IndexedDB. Mirrors
 *  `IndexedDbSnapshotStore`: no in-memory fallback — if IndexedDB is
 *  unavailable it fails loudly. Runs are plain JSON (TraceLine + FileChange
 *  are JSON-safe), stored as one array under a single key. */
function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("runs-store requires a browser/IndexedDB environment");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
      // Resolve on transaction completion so a write is only reported as
      // success after it has actually committed.
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/** Persist the run history (capped to the most recent 20) under a single key. */
export async function saveRuns(runs: Run[]): Promise<void> {
  await withStore("readwrite", (s) => s.put(capRuns(runs), KEY));
}

/** Load the run history (most-recent first), or [] if none stored yet.
 *  Defaults `messages` for runs persisted before that field existed. */
export async function loadRuns(): Promise<Run[]> {
  const result = await withStore<Run[] | undefined>("readonly", (s) => s.get(KEY));
  return (result ?? []).map((r) => ({ ...r, messages: r.messages ?? [] }));
}

/** Delete the run history entirely (used by Studio.resetProject). */
export async function clearRuns(): Promise<void> {
  await withStore("readwrite", (s) => s.delete(KEY));
}
