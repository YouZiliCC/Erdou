/** What outbound network reach a runtime's processes have. */
export type NetworkEgress = "none" | "cors-only" | "full";

/** Whether createSnapshot is cheap enough to call per-change or only per-session. */
export type SnapshotCost = "cheap" | "expensive";

/**
 * What a given Runtime implementation can do. Agents negotiate behavior
 * against these flags instead of type-checking the concrete Runtime.
 */
export interface RuntimeCapabilities {
  nativeProcesses: boolean;
  virtualPorts: boolean;
  persistentStorage: boolean;
  threads: boolean;
  nativeAddons: boolean;
  /** True when this runtime is a real OS (kernel + userland); false for simulated environments. */
  realOs: boolean;
  /** Command names of registered language/tool runtimes (e.g. "python", "wasi", "git"). */
  interpreters: string[];
  /** Package managers usable inside the runtime (e.g. "apk", "npm", "pip"); empty when none. */
  packageManagers: string[];
  networkEgress: NetworkEgress;
  /** Approximate memory ceiling in MB; null when not meaningfully bounded. */
  memoryLimitMB: number | null;
  snapshotCost: SnapshotCost;
}
