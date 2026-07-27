import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parsePreviewPath, previewUrl, routePreviewRequest, PREVIEW_SCOPE } from "./preview-bridge.js";

/**
 * SW ↔ bridge PARITY.
 *
 * `public/preview-sw.js` is served as STATIC JS: it cannot import this app's TS,
 * so its routing core (`parsePreviewPath` + `routePreviewRequest` + the
 * `/__port__/<n>/` override) is duplicated by hand in `preview-bridge.ts`. Until
 * now the only thing holding the two copies together was a "keep the two in
 * sync" comment — and the copies decide who a request is dispatched to, i.e.
 * exactly the code whose drift produced the cross-tab misroute this scheme fixes.
 *
 * So: load the REAL worker source, evaluate it in Node against a stub `self`,
 * pull its routing functions out, and run ONE shared case table against both
 * copies. A change to either file that is not mirrored in the other fails here
 * with the case that diverged.
 *
 * Only the pure routing core is exercised. The worker's `fetch`/`message`
 * handlers, `ownerClient()` and `exchange()` need a real Service Worker global
 * and are covered by the gated browser e2e instead — which is why the stub below
 * only has to survive top-level evaluation (the listener registrations).
 */

const SW_SOURCE = readFileSync(fileURLToPath(new URL("../../public/preview-sw.js", import.meta.url)), "utf8");

interface RoutingCore {
  parsePreviewPath(pathname: string): { owner: string; primary: number; rest: string } | null;
  routePreviewRequest(
    requestUrl: string,
    previewContextUrl: string,
  ): { owner: string; port: number; guestPath: string } | null;
}

/** Evaluate the worker source with a stub `self` and hand back its routing core.
 *  Function declarations in the worker's top level are hoisted into this
 *  function body, so the trailing `return` sees them. */
function loadWorkerRouting(): RoutingCore {
  const self = {
    addEventListener: () => {},
    location: { origin: "http://x" },
    clients: { matchAll: async () => [], get: async () => undefined },
  };
  const load = new Function(
    "self",
    `${SW_SOURCE}\n;return { parsePreviewPath, routePreviewRequest };`,
  ) as (s: unknown) => RoutingCore;
  return load(self);
}

const sw = loadWorkerRouting();
const bridge: RoutingCore = { parsePreviewPath, routePreviewRequest };
const COPIES: [string, RoutingCore][] = [
  ["preview-bridge.ts", bridge],
  ["public/preview-sw.js", sw],
];

const A = "1f0a5c22-1111-4d0e-9aaa-000000000001";
const B = "1f0a5c22-2222-4d0e-9aaa-000000000002";

/** ONE table, both copies. Add a routing case HERE, not in one copy's own test. */
const PARSE_CASES: { pathname: string; want: { owner: string; primary: number; rest: string } | null }[] = [
  { pathname: `${PREVIEW_SCOPE}${A}/8080/api`, want: { owner: A, primary: 8080, rest: "/api" } },
  { pathname: `${PREVIEW_SCOPE}${A}/8080/`, want: { owner: A, primary: 8080, rest: "/" } },
  { pathname: `${PREVIEW_SCOPE}${A}/8080`, want: { owner: A, primary: 8080, rest: "" } },
  {
    pathname: `${PREVIEW_SCOPE}${A}/8080/__port__/8000/a/b`,
    want: { owner: A, primary: 8080, rest: "/__port__/8000/a/b" },
  },
  // The pre-owner shape must NOT parse as owner="8080" with a missing port.
  { pathname: `${PREVIEW_SCOPE}8080/`, want: null },
  { pathname: `${PREVIEW_SCOPE}8080/api`, want: null },
  // …including when the stale guest path's FIRST segment is itself numeric, the
  // case the `\d+` port group does NOT catch: without the all-digit-owner rule
  // this parses as owner="8080", primary=2024 and the stale URL gets a 503
  // ("that tab is gone") instead of the 400 that names the real problem.
  { pathname: `${PREVIEW_SCOPE}8080/2024/report`, want: null },
  { pathname: `${PREVIEW_SCOPE}${A}/notaport/x`, want: null },
  { pathname: `${PREVIEW_SCOPE}${A}`, want: null },
  { pathname: "/assets/app.js", want: null },
  { pathname: "/", want: null },
];

const ROUTE_CASES: {
  name: string;
  requestUrl: string;
  context: string;
  want: { owner: string; port: number; guestPath: string } | null;
}[] = [
  {
    name: "in-scope, query stripped",
    requestUrl: `http://x${PREVIEW_SCOPE}${A}/8000/api?q=1`,
    context: "",
    want: { owner: A, port: 8000, guestPath: "/api" },
  },
  {
    name: "in-scope bare port normalizes to /",
    requestUrl: `http://x${PREVIEW_SCOPE}${A}/8000`,
    context: "",
    want: { owner: A, port: 8000, guestPath: "/" },
  },
  {
    name: "in-scope /__port__/<n>/ override keeps the owner",
    requestUrl: `http://x${PREVIEW_SCOPE}${A}/8080/__port__/8000/api`,
    context: "",
    want: { owner: A, port: 8000, guestPath: "/api" },
  },
  {
    // A BARE override has no remainder: the guest path must normalize to "/",
    // not to "" — an empty url in the envelope is not a request any server
    // routes. (`override[2] || "/"`, the line a one-sided edit gets wrong.)
    name: "in-scope BARE /__port__/<n> override normalizes the guest path to /",
    requestUrl: `http://x${PREVIEW_SCOPE}${A}/8080/__port__/8000`,
    context: "",
    want: { owner: A, port: 8000, guestPath: "/" },
  },
  {
    name: "in-scope /__port__/<n>/ override with a trailing slash keeps guest path /",
    requestUrl: `http://x${PREVIEW_SCOPE}${A}/8080/__port__/8000/`,
    context: "",
    want: { owner: A, port: 8000, guestPath: "/" },
  },
  {
    // The override port group is `\d+`: a non-numeric one is NOT an override,
    // so the port stays primary and the literal segments stay in the guest path
    // (relaxing it to `[^/]+` would dispatch to port NaN).
    name: "in-scope non-numeric /__port__/ is no override — port stays primary, segment stays in the path",
    requestUrl: `http://x${PREVIEW_SCOPE}${A}/8080/__port__/notaport/x`,
    context: "",
    want: { owner: A, port: 8080, guestPath: "/__port__/notaport/x" },
  },
  {
    name: "two tabs, same port, tab A",
    requestUrl: `http://x${PREVIEW_SCOPE}${A}/8080/index.html`,
    context: "",
    want: { owner: A, port: 8080, guestPath: "/index.html" },
  },
  {
    name: "two tabs, same port, tab B",
    requestUrl: `http://x${PREVIEW_SCOPE}${B}/8080/index.html`,
    context: "",
    want: { owner: B, port: 8080, guestPath: "/index.html" },
  },
  {
    name: "absolute-path escape attributed to owner A's guest (client.url context)",
    requestUrl: "http://x/style.css",
    context: `http://x${PREVIEW_SCOPE}${A}/8080/`,
    want: { owner: A, port: 8080, guestPath: "/style.css" },
  },
  {
    name: "absolute-path escape attributed to owner B's guest (same URL, other tab)",
    requestUrl: "http://x/style.css",
    context: `http://x${PREVIEW_SCOPE}${B}/8080/`,
    want: { owner: B, port: 8080, guestPath: "/style.css" },
  },
  {
    name: "escape honors /__port__/<n>/ and keeps the context's owner",
    requestUrl: "http://x/__port__/8000/api",
    context: `http://x${PREVIEW_SCOPE}${B}/8080/`,
    want: { owner: B, port: 8000, guestPath: "/api" },
  },
  {
    name: "escape with a BARE /__port__/<n> normalizes the guest path to /",
    requestUrl: "http://x/__port__/8000",
    context: `http://x${PREVIEW_SCOPE}${A}/8080/`,
    want: { owner: A, port: 8000, guestPath: "/" },
  },
  {
    name: "escape with a non-numeric /__port__/ keeps the context's port and the literal path",
    requestUrl: "http://x/__port__/notaport/x",
    context: `http://x${PREVIEW_SCOPE}${A}/8080/`,
    want: { owner: A, port: 8080, guestPath: "/__port__/notaport/x" },
  },
  {
    name: "escape uses the context's PRIMARY port, not its overridden one",
    requestUrl: "http://x/style.css",
    context: `http://x${PREVIEW_SCOPE}${A}/8080/__port__/8000/page`,
    want: { owner: A, port: 8080, guestPath: "/style.css" },
  },
  { name: "PASSTHROUGH: Studio's own subresource, app document context", requestUrl: "http://x/assets/app.js", context: "http://x/", want: null },
  { name: "PASSTHROUGH: Studio's own subresource, no context", requestUrl: "http://x/assets/app.js", context: "", want: null },
  {
    name: "PASSTHROUGH: foreign-origin context can never steer interception",
    requestUrl: "http://x/style.css",
    context: `http://evil${PREVIEW_SCOPE}${A}/8000/`,
    want: null,
  },
  { name: "PASSTHROUGH: unparseable context", requestUrl: "http://x/style.css", context: "not a url", want: null },
  // NOT a passthrough: null under `/__preview__/` means the worker ANSWERS 400
  // (see its fetch handler, and the source assertion below). Passing a stale
  // preview URL through would serve Studio's own index.html into the frame.
  { name: "400: stale pre-owner in-scope URL", requestUrl: `http://x${PREVIEW_SCOPE}8080/`, context: "", want: null },
  {
    name: "400: stale pre-owner in-scope URL whose guest path starts with a numeric segment",
    requestUrl: `http://x${PREVIEW_SCOPE}8080/2024/report`,
    context: "",
    want: null,
  },
  {
    name: "PASSTHROUGH: stale pre-owner context",
    requestUrl: "http://x/style.css",
    context: `http://x${PREVIEW_SCOPE}8080/`,
    want: null,
  },
];

describe("preview-sw.js ↔ preview-bridge.ts routing parity", () => {
  it("the worker source really is loadable and exports the routing core (else the table below tests nothing)", () => {
    expect(typeof sw.parsePreviewPath).toBe("function");
    expect(typeof sw.routePreviewRequest).toBe("function");
    // The dispatch-target lookup is not pure and cannot be in the table above,
    // so assert at the source level that it is the owner-addressed one: bringing
    // back a `appClient()`-style "pick a page" helper is the defect returning.
    expect(SW_SOURCE).toContain("function ownerClient(owner)");
    expect(SW_SOURCE).not.toContain("function appClient(");
    // …and that the worker can answer the boot handshake the owner ids come from.
    expect(SW_SOURCE).toContain("erdou:whoami");
  });

  it("ANSWERS 400 for an unroutable /__preview__/ URL instead of passing it through", () => {
    // The table above can only prove `routePreviewRequest` returns null; what
    // the worker DOES with that null is the part that matters and needs a real
    // SW to run. If the reserved-namespace branch regressed to a passthrough,
    // the SPA server would answer with Studio's own index.html RENDERED INSIDE
    // the preview iframe — a broken-looking guest app, silently, and every
    // routing test above would still pass. So pin it at the source level:
    // inside the `startsWith(SCOPE)` branch, a null route must respondWith a
    // 400 and return, never fall through to the out-of-scope fetch path.
    const start = SW_SOURCE.indexOf("if (url.pathname.startsWith(SCOPE))");
    const end = SW_SOURCE.indexOf("event.respondWith(proxy(event, route))");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(SW_SOURCE.slice(start, end)).toMatch(
      /if \(!route\) \{[\s\S]*event\.respondWith\(\s*textResponse\(\s*400,[\s\S]*\);\s*return;\s*\}/,
    );
  });

  for (const [name, impl] of COPIES) {
    describe(name, () => {
      for (const c of PARSE_CASES) {
        it(`parsePreviewPath(${c.pathname})`, () => {
          expect(impl.parsePreviewPath(c.pathname)).toEqual(c.want);
        });
      }
      for (const c of ROUTE_CASES) {
        it(`routePreviewRequest — ${c.name}`, () => {
          expect(impl.routePreviewRequest(c.requestUrl, c.context)).toEqual(c.want);
        });
      }
      it("routes a URL built by previewUrl() back to its own owner and port", () => {
        expect(impl.routePreviewRequest(`http://x${previewUrl(A, 8080)}`, "")).toEqual({
          owner: A,
          port: 8080,
          guestPath: "/",
        });
      });
    });
  }
});
