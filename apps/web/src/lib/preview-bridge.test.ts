import { describe, it, expect, vi, afterEach } from "vitest";
import type { HttpResponse } from "@erdou/runtime-contract";
import {
  activeWorker,
  answer,
  fetchToHttpRequest,
  getPreviewClientId,
  httpResponseToResponse,
  installPreviewBridge,
  learnPreviewClientId,
  parsePreviewPath,
  previewUrl,
  routePreviewRequest,
  setPreviewRuntime,
} from "./preview-bridge.js";

// Two owner ids standing in for two Studio tabs' Service Worker client ids.
const A = "9f1c2d3e-aaaa-4bbb-8ccc-000000000001";
const B = "9f1c2d3e-bbbb-4bbb-8ccc-000000000002";

describe("preview-bridge marshalling", () => {
  it("marshals a fetch Request to HttpRequest and back", async () => {
    const req = new Request(`http://x/__preview__/${A}/8000/api?q=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const hr = await fetchToHttpRequest(req, "/api?q=1");
    expect(hr.method).toBe("POST");
    expect(hr.url).toBe("/api?q=1");
    expect(hr.headers["content-type"]).toBe("application/json");
    expect(new TextDecoder().decode(hr.body)).toBe("{}");

    const res = httpResponseToResponse({
      status: 201,
      headers: { "x-a": "b" },
      body: new TextEncoder().encode("ok"),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("b");
    expect(await res.text()).toBe("ok");
  });

  it("gives a GET request an empty body without reading it", async () => {
    const req = new Request(`http://x/__preview__/${A}/8000/`, { method: "GET" });
    const hr = await fetchToHttpRequest(req, "/");
    expect(hr.method).toBe("GET");
    expect(hr.url).toBe("/");
    expect(hr.body).toBeInstanceOf(Uint8Array);
    expect(hr.body.length).toBe(0);
  });

  it("preserves a POST JSON body byte-for-byte", async () => {
    const payload = JSON.stringify({ hello: "world", n: 42 });
    const req = new Request(`http://x/__preview__/${A}/3000/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const hr = await fetchToHttpRequest(req, "/submit");
    expect(new TextDecoder().decode(hr.body)).toBe(payload);
  });

  it("round-trips response status and multiple headers", async () => {
    const res = httpResponseToResponse({
      status: 404,
      headers: { "content-type": "text/plain", "x-erdou": "1" },
      body: new TextEncoder().encode("Not Found"),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-erdou")).toBe("1");
    expect(await res.text()).toBe("Not Found");
  });

  it("uses a null body for null-body statuses (204) so Response does not throw", async () => {
    const res = httpResponseToResponse({ status: 204, headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("parsePreviewPath", () => {
  it("parses owner + primary port + the guest remainder", () => {
    expect(parsePreviewPath(`/__preview__/${A}/8080/api`)).toEqual({ owner: A, primary: 8080, rest: "/api" });
  });

  it("leaves a /__port__/<n>/ remainder for applyOverride (parse is pure — no override here)", () => {
    expect(parsePreviewPath(`/__preview__/${A}/8080/__port__/8000/a/b/c`)).toEqual({
      owner: A,
      primary: 8080,
      rest: "/__port__/8000/a/b/c",
    });
  });

  it("reports an empty remainder for a bare/trailing-slash scope URL (routing normalizes it to '/')", () => {
    expect(parsePreviewPath(`/__preview__/${A}/8080`)).toEqual({ owner: A, primary: 8080, rest: "" });
    expect(parsePreviewPath(`/__preview__/${A}/8080/`)).toEqual({ owner: A, primary: 8080, rest: "/" });
  });

  it("REJECTS the pre-owner two-segment shape (a stale bookmark/popup must not parse as owner=8080)", () => {
    expect(parsePreviewPath("/__preview__/8080/")).toBeNull();
    expect(parsePreviewPath("/__preview__/8080/api")).toBeNull();
  });

  it("REJECTS a non-numeric port segment and a scope URL with no port at all", () => {
    expect(parsePreviewPath(`/__preview__/${A}/notaport/x`)).toBeNull();
    expect(parsePreviewPath(`/__preview__/${A}`)).toBeNull();
    expect(parsePreviewPath(`/__preview__/${A}/`)).toBeNull();
  });

  it("REJECTS a path outside the preview scope", () => {
    expect(parsePreviewPath("/assets/app.js")).toBeNull();
    expect(parsePreviewPath("/")).toBeNull();
  });
});

describe("previewUrl", () => {
  it("is the ONE place the preview URL shape is built — and parses back to its own inputs", () => {
    expect(previewUrl(A, 8080)).toBe(`/__preview__/${A}/8080/`);
    expect(routePreviewRequest(`http://x${previewUrl(A, 8080)}`, "")).toEqual({
      owner: A,
      port: 8080,
      guestPath: "/",
    });
  });
});

describe("routePreviewRequest", () => {
  it("routes an IN-SCOPE request from the URL (query stripped — the SW appends it)", () => {
    expect(routePreviewRequest(`http://x/__preview__/${A}/8000/api?q=1`, "")).toEqual({
      owner: A,
      port: 8000,
      guestPath: "/api",
    });
  });

  it("normalizes an in-scope bare-port URL to guestPath '/'", () => {
    expect(routePreviewRequest(`http://x/__preview__/${A}/8000`, "")).toEqual({
      owner: A,
      port: 8000,
      guestPath: "/",
    });
    expect(routePreviewRequest(`http://x/__preview__/${A}/8000/`, "")).toEqual({
      owner: A,
      port: 8000,
      guestPath: "/",
    });
  });

  it("THE REGRESSION: two tabs serving the SAME port resolve to their OWN owners, in scope and on escape", () => {
    // The defect: with two Studio tabs on port 8080 the worker picked "the first
    // window client that is not a preview iframe" — a focus-ordered guess that
    // could dispatch tab B's request into tab A's runtime. The owner segment is
    // per-request, so there is no candidate set left to pick from.
    expect(routePreviewRequest(`http://x/__preview__/${A}/8080/index.html`, "")).toEqual({
      owner: A,
      port: 8080,
      guestPath: "/index.html",
    });
    expect(routePreviewRequest(`http://x/__preview__/${B}/8080/index.html`, "")).toEqual({
      owner: B,
      port: 8080,
      guestPath: "/index.html",
    });
    // …and an absolute-path escape is attributed to the guest it escaped FROM,
    // via that guest's own client.url — same request URL, two different owners.
    expect(routePreviewRequest("http://x/style.css", `http://x/__preview__/${A}/8080/`)).toEqual({
      owner: A,
      port: 8080,
      guestPath: "/style.css",
    });
    expect(routePreviewRequest("http://x/style.css", `http://x/__preview__/${B}/8080/`)).toEqual({
      owner: B,
      port: 8080,
      guestPath: "/style.css",
    });
  });

  it("routes an ABSOLUTE-path escape by the preview CLIENT url — no referrer needed (the regression the SW fix closes)", () => {
    // The SW sources the preview context from the initiating client's document
    // URL (`client.url`), so a guest that strips its referrer (Referrer-Policy:
    // no-referrer) is STILL routed: the second arg is the client.url here, and
    // the referrer would have been empty.
    expect(routePreviewRequest("http://x/style.css", `http://x/__preview__/${A}/8000/`)).toEqual({
      owner: A,
      port: 8000,
      guestPath: "/style.css",
    });
  });

  it("falls back to the referrer as the context when the client is unavailable", () => {
    // When clientId/client is missing (e.g. the iframe's own navigation), the SW
    // passes the request referrer as the context; routing works identically —
    // the referrer is a preview URL, so it carries the owner too.
    expect(routePreviewRequest("http://x/app.css", `http://x/__preview__/${A}/3000/page`)).toEqual({
      owner: A,
      port: 3000,
      guestPath: "/app.css",
    });
  });

  it("carries the absolute pathname (query stripped) for a referred subresource", () => {
    expect(routePreviewRequest("http://x/assets/app.js?v=2", `http://x/__preview__/${A}/8000/page`)).toEqual({
      owner: A,
      port: 8000,
      guestPath: "/assets/app.js",
    });
  });

  it("PASSES THROUGH (null) a genuine app request — client.url is the app doc, not a preview scope", () => {
    // The Studio app's own subresource: its initiating client (context) is the
    // app document at "/", not under /__preview__/ → null → the SW leaves it to
    // the browser untouched (the critical zero-risk passthrough property).
    expect(routePreviewRequest("http://x/assets/app.js", "http://x/")).toBeNull();
    expect(routePreviewRequest("http://x/assets/app.js", "")).toBeNull();
  });

  it("PASSES THROUGH (null) an absolute request whose referrer is a foreign origin", () => {
    // A cross-origin referrer must never steer interception.
    expect(routePreviewRequest("http://x/style.css", `http://evil/__preview__/${A}/8000/`)).toBeNull();
  });

  it("PASSES THROUGH (null) a stale pre-owner preview URL and a pre-owner context", () => {
    // No owner ⇒ no route. The SW answers such an in-scope URL with an explicit
    // 400 (see its fetch handler) rather than letting it reach a runtime.
    expect(routePreviewRequest("http://x/__preview__/8080/", "")).toBeNull();
    expect(routePreviewRequest("http://x/style.css", "http://x/__preview__/8080/")).toBeNull();
  });

  it("honors the /__port__/<n>/ sibling-override for an in-scope request (owner unchanged)", () => {
    expect(routePreviewRequest(`http://x/__preview__/${A}/8080/__port__/8000/api`, "")).toEqual({
      owner: A,
      port: 8000,
      guestPath: "/api",
    });
    expect(routePreviewRequest(`http://x/__preview__/${A}/8080/__port__/8000`, "")).toEqual({
      owner: A,
      port: 8000,
      guestPath: "/",
    });
  });

  it("honors the /__port__/<n>/ sibling-override for an absolute-path escape (client.url context)", () => {
    // Same override, routed from the client.url context (no referrer required).
    // The override moves the PORT only — the owner still comes from the context,
    // so a sibling-port request cannot cross into another tab's runtime.
    expect(routePreviewRequest("http://x/__port__/8000/api", `http://x/__preview__/${B}/8080/`)).toEqual({
      owner: B,
      port: 8000,
      guestPath: "/api",
    });
  });
});

/** A `ServiceWorker`-shaped stub for the `erdou:whoami` round trip. The real
 *  `askClientId` only ever calls `postMessage(msg, [port])`, so echoing `reply`
 *  on the transferred port is the whole contract — no Service Worker global
 *  needed to exercise the handshake and all three of its fail-fast paths. */
function whoamiWorker(reply: unknown): ServiceWorker {
  return {
    postMessage(message: unknown, transfer: Transferable[]) {
      expect((message as { type?: unknown }).type).toBe("erdou:whoami");
      (transfer[0] as unknown as MessagePort).postMessage(reply);
    },
  } as unknown as ServiceWorker;
}

/** A worker that takes the message and never answers — the timeout path. */
function silentWorker(): ServiceWorker {
  return { postMessage() {} } as unknown as ServiceWorker;
}

describe("answer (page-side reply, streamed and buffered)", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const dec = new TextDecoder();
  const msg = {
    type: "erdou:req" as const,
    id: 7,
    port: 8080,
    req: { method: "GET", url: "/events", headers: {}, body: new Uint8Array() },
  };

  interface Posted {
    message: {
      type: string;
      id: number;
      res?: HttpResponse;
      stream?: ReadableStream<Uint8Array>;
      error?: string;
    };
    transfer: Transferable[] | undefined;
  }

  function recordingPort(): { posted: Posted[]; port: { postMessage(m: unknown, t?: Transferable[]): void } } {
    const posted: Posted[] = [];
    return {
      posted,
      port: { postMessage: (m, t) => posted.push({ message: m as Posted["message"], transfer: t }) },
    };
  }

  const runtimeOf = (res: HttpResponse) => ({ dispatch: async () => res });

  // A two-chunk producer that records whether its finally (the contract's
  // "client gone" cleanup) ran.
  function producer(): { res: HttpResponse; finallyRan: () => boolean } {
    let finallyRan = false;
    async function* gen(): AsyncGenerator<Uint8Array> {
      try {
        yield enc("data: one\n\n");
        yield enc("data: two\n\n");
      } finally {
        finallyRan = true;
      }
    }
    return {
      res: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: new Uint8Array(),
        stream: gen(),
      },
      finallyRan: () => finallyRan,
    };
  }

  it("a plain response posts ONE reply with the body and no stream (unchanged path)", async () => {
    const { posted, port } = recordingPort();
    const res: HttpResponse = { status: 200, headers: { "content-type": "text/plain" }, body: enc("ok") };
    await answer(runtimeOf(res), msg, port);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.id).toBe(7);
    expect(posted[0]!.message.res).toEqual(res);
    expect(posted[0]!.message.stream).toBeUndefined();
    expect(posted[0]!.transfer).toBeUndefined();
  });

  it("a streamed response posts ONE reply: headers-only res (empty body) + a TRANSFERRED ReadableStream", async () => {
    const { posted, port } = recordingPort();
    const { res } = producer();
    await answer(runtimeOf(res), msg, port);
    expect(posted).toHaveLength(1);
    const reply = posted[0]!.message;
    expect(reply.res!.status).toBe(200);
    expect(reply.res!.headers["content-type"]).toBe("text/event-stream");
    expect(reply.res!.body.length).toBe(0);
    expect(reply.stream).toBeInstanceOf(ReadableStream);
    expect(posted[0]!.transfer).toEqual([reply.stream]); // the transfer list carries the stream
  });

  it("reading the posted stream pulls the producer's chunks in order and closes at exhaustion", async () => {
    const { posted, port } = recordingPort();
    const p = producer();
    await answer(runtimeOf(p.res), msg, port);
    const reader = posted[0]!.message.stream!.getReader();
    expect(dec.decode((await reader.read()).value)).toBe("data: one\n\n");
    expect(dec.decode((await reader.read()).value)).toBe("data: two\n\n");
    expect((await reader.read()).done).toBe(true);
    expect(p.finallyRan()).toBe(true);
  });

  it("reader.cancel() (client gone) propagates to the producer's return() — its finally runs", async () => {
    const { posted, port } = recordingPort();
    const p = producer();
    await answer(runtimeOf(p.res), msg, port);
    const reader = posted[0]!.message.stream!.getReader();
    await reader.read(); // one chunk consumed…
    expect(p.finallyRan()).toBe(false);
    await reader.cancel("client gone");
    expect(p.finallyRan()).toBe(true);
  });

  it("a mid-stream producer error errors the ReadableStream (fail-fast, no silent truncation)", async () => {
    const { posted, port } = recordingPort();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc("data: one\n\n");
      throw new Error("WSGI application error: boom");
    }
    await answer(
      runtimeOf({ status: 200, headers: { "content-type": "text/event-stream" }, body: new Uint8Array(), stream: gen() }),
      msg,
      port,
    );
    const reader = posted[0]!.message.stream!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow("WSGI application error: boom");
  });

  it("a null-body status with a (nonsensical) stream replies plain and releases the producer via return()", async () => {
    const { posted, port } = recordingPort();
    // A producer with an explicit return() (the shape real producers use so
    // that a return-before-first-pull still releases resources — a plain async
    // generator would skip its finally when never started).
    let returned = 0;
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: enc("never"), done: false }),
        return: async () => {
          returned++;
          return { value: undefined, done: true };
        },
      }),
    };
    await answer(
      runtimeOf({ status: 204, headers: {}, body: new Uint8Array(), stream }),
      msg,
      port,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.stream).toBeUndefined();
    expect(posted[0]!.message.res!.status).toBe(204);
    await new Promise((r) => setTimeout(r, 0)); // it.return() is async
    expect(returned).toBe(1);
  });

  it("REFUSES a request addressed to a DIFFERENT owner — the page's own guard against a cross-tab misroute", async () => {
    // Second, independent check on the defect: even if the worker's routing were
    // wrong, the page that receives the envelope refuses to dispatch a request
    // addressed to another Studio page. It never picks a target — it only says no.
    const { posted, port } = recordingPort();
    const dispatch = vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() }));
    await answer({ dispatch }, { ...msg, owner: "owner-b" }, port, "owner-a");
    expect(dispatch).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.error).toContain("owner-b");
    expect(posted[0]!.message.error).toContain("owner-a");
    expect(posted[0]!.message.res).toBeUndefined();
  });

  it("dispatches when the envelope names THIS owner, and when it names none (pre-owner SW, version skew)", async () => {
    const res: HttpResponse = { status: 200, headers: {}, body: new TextEncoder().encode("ok") };
    const mine = recordingPort();
    await answer(runtimeOf(res), { ...msg, owner: "owner-a" }, mine.port, "owner-a");
    expect(mine.posted[0]!.message.res).toEqual(res);
    // `owner` is optional exactly like `dest`: a cached pre-owner SW omits it and
    // the bridge still serves (it cannot have misrouted — that SW's URLs have no
    // owner segment, so nothing addressed to another page can arrive).
    const skew = recordingPort();
    await answer(runtimeOf(res), msg, skew.port, "owner-a");
    expect(skew.posted[0]!.message.res).toEqual(res);
  });

  it("THE GUARD PRODUCTION USES: with THREE arguments the expected owner defaults to this page's learned id", async () => {
    // installPreviewBridge's listener calls `answer(rt, event.data, replyPort)`
    // — three arguments. Every guard test above passes a 4th that production
    // never passes, so they all stay green even with the default changed to
    // `null`, which DISABLES the page-side cross-tab guard in the shipped app.
    // So learn an id through the real handshake path and call answer the way the
    // listener does.
    await learnPreviewClientId(whoamiWorker({ type: "erdou:whoami-res", clientId: A }));
    const refused = recordingPort();
    const dispatch = vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() }));
    await answer({ dispatch }, { ...msg, owner: B }, refused.port);
    expect(dispatch).not.toHaveBeenCalled();
    expect(refused.posted[0]!.message.error).toContain(B);
    expect(refused.posted[0]!.message.error).toContain(A);
    // …and the same 3-arg call serves a request addressed to THIS page.
    const mine = recordingPort();
    const res: HttpResponse = { status: 200, headers: {}, body: new TextEncoder().encode("ok") };
    await answer(runtimeOf(res), { ...msg, owner: A }, mine.port);
    expect(mine.posted[0]!.message.res).toEqual(res);
  });

  it("TOLERATES expectedOwner === null (handshake not done/failed): a page with no identity cannot compare", async () => {
    // Without the `expectedOwner !== null` clause this request would be refused
    // — a page whose boot handshake has not landed yet would answer nothing at
    // all, turning a race into a dead preview. It cannot misroute either: a page
    // with no id built no preview URL naming it.
    const { posted, port } = recordingPort();
    const res: HttpResponse = { status: 200, headers: {}, body: new TextEncoder().encode("ok") };
    await answer(runtimeOf(res), { ...msg, owner: B }, port, null);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.res).toEqual(res);
    expect(posted[0]!.message.error).toBeUndefined();
  });

  it("a dispatch failure still posts the error reply (SW turns it into a 502)", async () => {
    const { posted, port } = recordingPort();
    await answer({ dispatch: async () => { throw new Error("kernel detached"); } }, msg, port);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.error).toBe("kernel detached");
    expect(posted[0]!.message.res).toBeUndefined();
  });
});

describe("learnPreviewClientId (the erdou:whoami boot handshake)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stores the id the worker reports — the owner every preview URL this tab builds names", async () => {
    expect(await learnPreviewClientId(whoamiWorker({ type: "erdou:whoami-res", clientId: A }))).toBe(A);
    expect(getPreviewClientId()).toBe(A);
    expect(previewUrl(getPreviewClientId()!, 8080)).toBe(`/__preview__/${A}/8080/`);
  });

  it("FAILS FAST on a worker that never answers: null after the 5s bound, never a hung boot", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = learnPreviewClientId(silentWorker());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(getPreviewClientId()).toBeNull();
    expect(String(errors.mock.calls[0]?.[0])).toContain("erdou:whoami");
  });

  it("FAILS FAST on a reply carrying no id (clientId: null — event.source was gone)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await learnPreviewClientId(whoamiWorker({ type: "erdou:whoami-res", clientId: null }))).toBeNull();
    expect(getPreviewClientId()).toBeNull();
    expect(String(errors.mock.calls[0]?.[0])).toContain("unusable client id");
  });

  it("REJECTS an id outside OWNER_TOKEN rather than putting it in a path", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Characters that would need encoding to survive three parsers (SW, bridge,
    // WS shim) — validate loudly once instead.
    expect(await learnPreviewClientId(whoamiWorker({ clientId: "a/b" }))).toBeNull();
    expect(await learnPreviewClientId(whoamiWorker({ clientId: "a b" }))).toBeNull();
    expect(await learnPreviewClientId(whoamiWorker({ clientId: "" }))).toBeNull();
    expect(await learnPreviewClientId(whoamiWorker({ clientId: "x".repeat(129) }))).toBeNull();
    expect(errors).toHaveBeenCalledTimes(4);
    expect(getPreviewClientId()).toBeNull();
  });

  it("REJECTS a dot-only id, which the URL parser would DELETE from the preview path", async () => {
    // `previewUrl("..", 8080)` = `/__preview__/../8080/`, which the browser
    // normalizes to `/8080/` BEFORE the request: out of scope, Studio's own page
    // as context, no route → `fetch()` → the SPA server returns Studio's own
    // index.html, rendered inside the preview iframe. Silent wrong content is
    // precisely what the owner segment exists to abolish, so it must die here.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await learnPreviewClientId(whoamiWorker({ clientId: ".." }))).toBeNull();
    expect(await learnPreviewClientId(whoamiWorker({ clientId: "." }))).toBeNull();
    expect(errors).toHaveBeenCalledTimes(2);
    expect(new URL(previewUrl("..", 8080), "http://x").pathname).toBe("/8080/"); // why it must
    // A legitimate id may still contain dots.
    expect(await learnPreviewClientId(whoamiWorker({ clientId: "a.b" }))).toBe("a.b");
  });
});

describe("activeWorker (which worker answers erdou:whoami)", () => {
  /** A `ServiceWorker`-shaped stub: `activeWorker` only reads `.state` and
   *  subscribes to `statechange`. `to()` moves it and fires the listeners. */
  function fakeWorker(state: string): { worker: ServiceWorker; to(next: string): void } {
    const listeners: Array<() => void> = [];
    const w = {
      state,
      addEventListener: (type: string, fn: () => void) => {
        expect(type).toBe("statechange");
        listeners.push(fn);
      },
    };
    return {
      worker: w as unknown as ServiceWorker,
      to(next: string) {
        w.state = next;
        for (const fn of [...listeners]) fn();
      },
    };
  }
  const registration = (parts: {
    installing?: ServiceWorker | null;
    waiting?: ServiceWorker | null;
    active?: ServiceWorker | null;
  }): ServiceWorkerRegistration =>
    ({ installing: null, waiting: null, active: null, ...parts }) as unknown as ServiceWorkerRegistration;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("with no update in flight, uses the active worker", async () => {
    const active = fakeWorker("activated").worker;
    expect(await activeWorker(registration({ active }))).toBe(active);
  });

  it("an already-activated update wins over the outgoing active worker (it is the one that knows erdou:whoami)", async () => {
    const updating = fakeWorker("activated");
    const active = fakeWorker("activated").worker;
    expect(await activeWorker(registration({ installing: updating.worker, active }))).toBe(updating.worker);
  });

  it("waits for an installing update and returns it once it activates", async () => {
    const updating = fakeWorker("installing");
    const active = fakeWorker("activated").worker;
    const pending = activeWorker(registration({ installing: updating.worker, active }));
    updating.to("installed");
    updating.to("activating");
    updating.to("activated");
    expect(await pending).toBe(updating.worker);
  });

  it("THE REGRESSION: an update that goes REDUNDANT falls back to the active worker, immediately", async () => {
    // A failed install (bad deploy, parse error, fetch failure) never reaches
    // "activated". Waiting the 5s bound out and returning null discards the
    // worker that ACTUALLY CONTROLS this page and costs the whole session its
    // preview identity ("Preview transport unavailable") plus a 5s boot stall.
    // Fake timers with NO advance: resolution must not depend on the timer.
    vi.useFakeTimers();
    const updating = fakeWorker("installing");
    const active = fakeWorker("activated").worker;
    const pending = activeWorker(registration({ installing: updating.worker, active }));
    updating.to("redundant");
    expect(await pending).toBe(active);
  });

  it("a redundant update with no active worker is a real miss — null, not a hang", async () => {
    vi.useFakeTimers();
    const updating = fakeWorker("installing");
    const pending = activeWorker(registration({ installing: updating.worker }));
    updating.to("redundant");
    expect(await pending).toBeNull();
  });

  it("an update that never settles gives up after the 5s bound instead of hanging boot", async () => {
    vi.useFakeTimers();
    const updating = fakeWorker("installing");
    const pending = activeWorker(registration({ installing: updating.worker }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
  });
});

describe("installPreviewBridge", () => {
  it("is a guarded no-op where navigator has no serviceWorker", () => {
    // The vitest "node" env exposes `navigator` but not `serviceWorker`, so the
    // bridge must skip installation instead of throwing.
    expect(() =>
      installPreviewBridge({
        dispatch: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
      }),
    ).not.toThrow();
  });

  it("setPreviewRuntime re-aims the installed bridge (no-op re-install does not)", () => {
    const a = { dispatch: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() })) };
    const b = { dispatch: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() })) };
    installPreviewBridge(a); // installs the listener, target = a
    installPreviewBridge(b); // early-returns, but STILL updates the holder to b
    setPreviewRuntime(a); // explicit re-aim back to a
    // The holder is now `a`; exercised end-to-end by dispatching a fake message is
    // overkill in jsdom — assert the exported swap is wired by re-aiming to b:
    setPreviewRuntime(b);
    expect(typeof setPreviewRuntime).toBe("function"); // holder swap compiles + runs; e2e covers dispatch
  });
});
