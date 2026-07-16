import type { Runtime } from "@erdou/runtime-contract";

/** A factory that produces a fresh Runtime for each conformance test. */
export type MakeRuntime = () => Runtime | Promise<Runtime>;

const active: Runtime[] = [];

export async function booted(make: MakeRuntime): Promise<Runtime> {
  const rt = await make();
  await rt.boot();
  active.push(rt);
  return rt;
}

/** Shut down every runtime created via booted() since the last call. A VM
 *  runtime holds a live emulator (CPU timers, ~512 MB) — without this, a
 *  per-test factory leaks one VM per test and hangs/OOMs the run. */
export async function teardownRuntimes(): Promise<void> {
  const rts = active.splice(0, active.length);
  await Promise.all(rts.map((rt) => rt.shutdown().catch(() => {})));
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
