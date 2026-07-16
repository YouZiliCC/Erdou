import { ErrnoError } from "@erdou/runtime-contract";
import type { HttpHandler, HttpRequest, HttpResponse, RuntimeEvent } from "@erdou/runtime-contract";

/** The in-VM HTTP surface: a program serves a handler on a virtual port and
 *  `dispatch` routes a request to it. For Round 11a this is page-side only
 *  (no proxy into a real guest server yet — that is Round 12). */
export class PortRegistry {
  private readonly handlers = new Map<number, HttpHandler>();
  constructor(private readonly emit: (e: RuntimeEvent) => void) {}

  exposePort(port: number): string {
    const url = `/__port__/${port}/`;
    this.emit({ type: "port.opened", port, url });
    return url;
  }

  serve(port: number, handler: HttpHandler): void {
    if (this.handlers.has(port)) throw new ErrnoError("EADDRINUSE", { syscall: "serve", path: String(port) });
    this.handlers.set(port, handler);
    this.emit({ type: "port.opened", port, url: `/__port__/${port}/` });
  }

  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> {
    const handler = this.handlers.get(port);
    if (!handler) {
      return { status: 502, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(`No server listening on port ${port}`) };
    }
    return handler(req);
  }

  close(port: number): void {
    if (this.handlers.delete(port)) this.emit({ type: "port.closed", port });
  }

  ports(): number[] {
    return [...this.handlers.keys()];
  }
}
