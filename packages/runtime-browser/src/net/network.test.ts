import { describe, it, expect } from "vitest";
import { NetworkManager } from "./network.js";

describe("NetworkManager", () => {
  it("throws EACCES when the network permission is not granted", async () => {
    const net = new NetworkManager({ permission: { kind: "network", granted: false } });
    await expect(net.fetch("https://example.com")).rejects.toThrow(/EACCES/);
  });

  it("delegates to the injected fetch when granted", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("ok");
    }) as typeof fetch;
    const net = new NetworkManager({ permission: { kind: "network", granted: true }, fetch: fakeFetch });
    const res = await net.fetch("https://example.com");
    expect(await res.text()).toBe("ok");
    expect(calls).toEqual(["https://example.com"]);
  });
});
