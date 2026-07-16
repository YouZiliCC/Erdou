import { readFile } from "node:fs/promises";
import { V86 } from "v86";
import type { GuestChannel } from "./guestd-client.js";
import type { Fs9p } from "./fs-bridge.js";

export interface V86Assets {
  biosPath: string;
  vgaBiosPath: string;
  kernelPath: string;
  statePath?: string;
  memoryMB: number;
}

const REQUIRED_FS9P = [
  "GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile",
  "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file",
] as const;

/** Fail-fast if a v86 upgrade renamed a method the fs-bridge depends on. */
export function assertFs9pSymbols(fs9p: unknown): void {
  const o = fs9p as Record<string, unknown> | null;
  if (!o || !Array.isArray((o as { inodes?: unknown }).inodes)) {
    throw new Error("v86 fs9p missing or has no `inodes` array — construct V86 with `filesystem: {}`");
  }
  const missing = REQUIRED_FS9P.filter((m) => typeof o[m] !== "function");
  if (missing.length) throw new Error(`v86 fs9p missing required method(s): ${missing.join(", ")} — v86 upgrade may have renamed them`);
}

export class V86Host {
  private emulator: any;
  readonly fs9p!: Fs9p; // set after boot (declared for the type; assigned in boot)

  constructor(private readonly assets: V86Assets) {}

  async boot(): Promise<void> {
    const [bios, vga, kernel, state] = await Promise.all([
      readFile(this.assets.biosPath),
      readFile(this.assets.vgaBiosPath),
      readFile(this.assets.kernelPath),
      this.assets.statePath ? readFile(this.assets.statePath) : Promise.resolve(undefined),
    ]);
    // EXACT ArrayBuffer — a Node Buffer may be a view into a pooled ArrayBuffer
    // at a non-zero byteOffset; `.buffer` would hand v86 wrong bytes. Copy into
    // a fresh 0-offset buffer.
    const ab = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;
    const opts: Record<string, unknown> = {
      bios: { buffer: ab(bios) },
      vga_bios: { buffer: ab(vga) },
      bzimage: { buffer: ab(kernel) },
      memory_size: this.assets.memoryMB * 1024 * 1024,
      filesystem: {},
      virtio_console: true,
      autostart: false,
      disable_keyboard: true,
      cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
    };
    if (state) opts.initial_state = { buffer: ab(state) };
    this.emulator = new V86(opts);
    await new Promise<void>((resolve) => this.emulator.add_listener("emulator-ready", () => resolve()));
    assertFs9pSymbols(this.emulator.fs9p);
    (this as { fs9p: Fs9p }).fs9p = this.emulator.fs9p as Fs9p;
  }

  run(): void { this.emulator.run(); }

  channel(): GuestChannel {
    return {
      send: (bytes: Uint8Array) => this.emulator.bus.send("virtio-console0-input-bytes", bytes),
      subscribe: (cb: (bytes: Uint8Array) => void) => this.emulator.add_listener("virtio-console0-output-bytes", cb),
    };
  }

  serial(): { send(s: string): void; onByte(cb: (b: number) => void): void } {
    return {
      send: (s: string) => this.emulator.serial0_send(s),
      onByte: (cb: (b: number) => void) => this.emulator.add_listener("serial0-output-byte", cb),
    };
  }

  async saveState(): Promise<Uint8Array> {
    return new Uint8Array(await this.emulator.save_state());
  }

  async restoreState(buf: Uint8Array): Promise<void> {
    // Pass the view, not buf.buffer — v86 does `new Uint8Array(state)` and a
    // subarray/oversized backing buffer would append trailing garbage.
    await this.emulator.restore_state(buf);
  }

  async destroy(): Promise<void> {
    await this.emulator.destroy();
  }
}
