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
    for (const listener of this.listeners) listener(event);
  }
}
