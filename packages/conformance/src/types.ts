import type { Runtime } from "@erdou/runtime-contract";

/** A factory that produces a fresh Runtime for each conformance test. */
export type MakeRuntime = () => Runtime | Promise<Runtime>;

export async function booted(make: MakeRuntime): Promise<Runtime> {
  const rt = await make();
  await rt.boot();
  return rt;
}

/** Poll until `cond` holds. The contract allows asynchronous event delivery,
 *  so suites wait for events instead of asserting same-tick arrival. */
export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
