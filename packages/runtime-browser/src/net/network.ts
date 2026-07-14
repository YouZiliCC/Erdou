import { ErrnoError } from "@erdou/runtime-contract";
import type { Permission } from "@erdou/runtime-contract";

export interface NetworkOptions {
  permission: Permission;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A permission-gated fetch. Denied network access fails loudly with EACCES. */
export class NetworkManager {
  constructor(private readonly opts: NetworkOptions) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!this.opts.permission.granted) {
      throw new ErrnoError("EACCES", { syscall: "fetch", path: "network permission not granted" });
    }
    const doFetch = this.opts.fetch ?? fetch;
    return doFetch(input, init);
  }
}
