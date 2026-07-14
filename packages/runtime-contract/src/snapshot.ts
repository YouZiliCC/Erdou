/** A serialized filesystem node. File bytes are base64-encoded so the whole
 *  snapshot is JSON- and structured-clone-safe. */
export type SnapshotFsNode =
  | { type: "directory"; mode: number; children: Record<string, SnapshotFsNode> }
  | { type: "file"; mode: number; data: string }
  | { type: "symlink"; mode: number; target: string };

export interface Snapshot {
  version: 1;
  createdAtMs: number;
  fs: SnapshotFsNode;
}

/** Where snapshots are persisted (memory for tests, IndexedDB in the browser). */
export interface SnapshotStore {
  save(id: string, snapshot: Snapshot): Promise<void>;
  load(id: string): Promise<Snapshot | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}
