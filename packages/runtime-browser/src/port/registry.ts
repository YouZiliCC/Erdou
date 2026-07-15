import { ErrnoError } from "@erdou/runtime-contract";
import type { HttpHandler, HttpRequest, HttpResponse, VirtualPort } from "@erdou/runtime-contract";
import type { EventBus } from "../core/event-bus.js";

/**
 * Tracks virtual ports: the legacy `listen`/`exposePort` bind table plus the
 * real in-browser HTTP server — programs `serve` a handler on a port, and
 * `dispatch` routes an `HttpRequest` to it (the preview Service Worker's
 * reverse-proxy target). Browser-first: no real OS sockets involved.
 */
export class PortRegistry {
  private readonly bound = new Set<number>();
  private readonly handlers = new Map<number, HttpHandler>();

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

  /** Register an HTTP handler on `port`. Throws EADDRINUSE if already served. */
  serve(port: number, handler: HttpHandler): void {
    if (this.handlers.has(port)) {
      throw new ErrnoError("EADDRINUSE", { syscall: "serve", path: String(port) });
    }
    this.handlers.set(port, handler);
    this.bus.emit({ type: "port.opened", port, url: this.urlFor(port) });
  }

  /** Route a request to whatever handler is serving `port`; 502 if none. */
  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> {
    const handler = this.handlers.get(port);
    if (!handler) {
      return {
        status: 502,
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode(`No server listening on port ${port}`),
      };
    }
    return handler(req);
  }

  /** Stop serving `port`, freeing it for a future `serve`. */
  close(port: number): void {
    if (this.handlers.delete(port)) this.bus.emit({ type: "port.closed", port });
  }

  isBound(port: number): boolean {
    return this.bound.has(port) || this.handlers.has(port);
  }

  /** Currently-served ports. */
  ports(): number[] {
    return [...this.handlers.keys()];
  }

  private urlFor(port: number): string {
    return `/__port__/${port}/`;
  }
}
