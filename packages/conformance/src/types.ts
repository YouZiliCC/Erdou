import type { Runtime } from "@erdou/runtime-contract";

/** A factory that produces a fresh Runtime for each conformance test. */
export type MakeRuntime = () => Runtime | Promise<Runtime>;

export async function booted(make: MakeRuntime): Promise<Runtime> {
  const rt = await make();
  await rt.boot();
  return rt;
}
