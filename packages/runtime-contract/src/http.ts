/**
 * Generic HTTP request/response shapes for the in-browser virtual HTTP
 * server. These are plain data — no agent semantics — so any executor
 * (a built-in, a language runtime, a WASI host…) can register a handler
 * against a virtual port without depending on anything above this contract.
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A program's handler for requests dispatched to the port it serves. */
export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
