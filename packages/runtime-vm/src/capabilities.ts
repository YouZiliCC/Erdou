import type { RuntimeCapabilities } from "@erdou/runtime-contract";

/** Capabilities for the v86 + Alpine guest. `interpreters` is what the baked
 *  image actually ships (MVP: python3). networkEgress stays "none": Round 12's
 *  fetch-NAT is inbound-only — it reverse-proxies preview requests from the
 *  host page INTO guest servers (VmRuntime.dispatch), and boot brings `lo` up —
 *  but guest processes have no outbound reach, so apk/pip installs still fail
 *  until a future round adds the package-registry egress gateway. */
export function vmCapabilities(interpreters: string[]): RuntimeCapabilities {
  return {
    nativeProcesses: true,
    virtualPorts: true,
    persistentStorage: true,
    threads: false,
    nativeAddons: true,
    realOs: true,
    interpreters,
    packageManagers: ["apk", "pip"],
    networkEgress: "none",
    memoryLimitMB: 512,
    snapshotCost: "cheap",
  };
}
