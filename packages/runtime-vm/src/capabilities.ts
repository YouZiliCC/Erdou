import type { RuntimeCapabilities } from "@erdou/runtime-contract";

/** Capabilities for the v86 + Alpine guest. `interpreters` and `packageManagers`
 *  are per-profile — what the baked image actually ships (base: python3 + apk/pip;
 *  node: +node/npm; sci: +numpy/pandas). Callers pass the profile's lists from
 *  PROFILE_META (`@erdou/runtime-vm/profiles`); `packageManagers` defaults to the
 *  base set for single-image callers.
 *
 *  networkEgress is "cors-only" as of Round 13: the v86 fetch-NAT relays guest
 *  plain-HTTP egress on port 80 to the real npm/PyPI registries (pip via a baked
 *  /etc/pip.conf, npm via /root/.npmrc), so `pip install`/`npm install` work
 *  through that gateway — but only the CORS-open package registries are reachable,
 *  arbitrary hosts are not, and apk system packages are baked at image build time
 *  (dl-cdn is not CORS-open at runtime). The NAT also reverse-proxies preview
 *  requests from the host page INTO guest servers (VmRuntime.dispatch). */
export function vmCapabilities(
  interpreters: string[],
  packageManagers: string[] = ["apk", "pip"],
): RuntimeCapabilities {
  return {
    nativeProcesses: true,
    virtualPorts: true,
    persistentStorage: true,
    threads: false,
    nativeAddons: true,
    realOs: true,
    interpreters,
    packageManagers,
    networkEgress: "cors-only",
    memoryLimitMB: 512,
    snapshotCost: "cheap",
  };
}
