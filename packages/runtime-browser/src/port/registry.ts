import { ErrnoError } from "@erdou/runtime-contract";
import type { VirtualPort } from "@erdou/runtime-contract";
import type { EventBus } from "../core/event-bus.js";

/** Tracks which virtual ports are bound and maps them to preview URLs. */
export class PortRegistry {
  private readonly bound = new Set<number>();

  constructor(private readonly bus: EventBus) {}

  listen(port: number): VirtualPort {
    if (this.bound.has(port)) {
      throw new ErrnoError("EADDRINUSE", { syscall: "listen", path: String(port) });
    }
    this.bound.add(port);
    const bound = this.bound;
    return {
      port,
      async close(): Promise<void> {
        bound.delete(port);
      },
    };
  }

  exposePort(port: number): string {
    const url = `https://${port}.preview.erdou.local/`;
    this.bus.emit({ type: "port.opened", port, url });
    return url;
  }

  isBound(port: number): boolean {
    return this.bound.has(port);
  }
}
