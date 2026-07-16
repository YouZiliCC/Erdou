import type { RuntimeCapabilities } from "@erdou/runtime-contract";

/** Capabilities for the v86 + Alpine guest. `interpreters` is what the baked
 *  image actually ships (MVP: python3). networkEgress is "none" until Round 12
 *  wires the package-registry gateway. */
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
