import type { Snapshot, SnapshotStore } from "@erdou/runtime-contract";

const STORE = "snapshots";

/** Persists snapshots in the browser's IndexedDB (refresh-recovery). In tests
 *  it runs against `fake-indexeddb`. There is no in-memory fallback: if
 *  IndexedDB is unavailable it fails loudly. */
export class IndexedDbSnapshotStore implements SnapshotStore {
  constructor(private readonly dbName = "erdou-snapshots") {}

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDbSnapshotStore requires a browser/IndexedDB environment");
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async save(id: string, snapshot: Snapshot): Promise<void> {
    await this.withStore("readwrite", (s) => s.put(snapshot, id));
  }

  async load(id: string): Promise<Snapshot | null> {
    const result = await this.withStore<Snapshot | undefined>("readonly", (s) => s.get(id));
    return result ?? null;
  }

  async list(): Promise<string[]> {
    const keys = await this.withStore<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    return keys.map(String);
  }

  async delete(id: string): Promise<void> {
    await this.withStore("readwrite", (s) => s.delete(id));
  }
}
