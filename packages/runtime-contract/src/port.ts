/** A bound virtual port a process listens on. */
export interface VirtualPort {
  readonly port: number;
  close(): Promise<void>;
}
