import type { Snapshot, SnapshotStore } from "@erdou/runtime-contract";

/** In-memory snapshot store (default; used in tests). Clones on save so later
 *  mutation of the passed snapshot cannot corrupt stored state. */
export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot>();

  async save(id: string, snapshot: Snapshot): Promise<void> {
    this.snapshots.set(id, structuredClone(snapshot));
  }

  async load(id: string): Promise<Snapshot | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async list(): Promise<string[]> {
    return [...this.snapshots.keys()];
  }

  async delete(id: string): Promise<void> {
    this.snapshots.delete(id);
  }
}
