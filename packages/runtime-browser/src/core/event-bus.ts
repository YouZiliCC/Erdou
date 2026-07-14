import type { RuntimeEvent, RuntimeEventListener, Unsubscribe } from "@erdou/runtime-contract";

/** Synchronous fan-out of runtime events to subscribers. */
export class EventBus {
  private readonly listeners = new Set<RuntimeEventListener>();

  subscribe(listener: RuntimeEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A faulty subscriber must not break delivery to others or the kernel.
        // Surface it loudly rather than swallowing it.
        console.error("EventBus listener threw:", err);
      }
    }
  }
}
