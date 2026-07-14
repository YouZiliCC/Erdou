/**
 * What a given Runtime implementation can do. Agents negotiate behavior
 * against these flags instead of type-checking the concrete Runtime.
 */
export interface RuntimeCapabilities {
  nativeProcesses: boolean;
  virtualPorts: boolean;
  persistentStorage: boolean;
  network: boolean;
  threads: boolean;
  nativeAddons: boolean;
}
