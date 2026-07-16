/** Frame types (single ASCII byte). Requests are lowercase, responses uppercase/symbol. */
export const FrameType = {
  READY: "R", STARTED: "S", STDOUT: "O", STDERR: "E", EXIT: "X", PROCS: "P", ERROR: "!",
  EXEC: "x", SPAWN: "s", KILL: "k", PS: "p", PING: "i",
} as const;

export interface Frame {
  type: string;
  id: number;
  body: Uint8Array;
}

const HEADER = 9; // u32be payloadLen + 1 byte type + u32be id; payloadLen counts type+id+body

// Resync bounds. A frame carries at most a 4096-byte stdout/stderr chunk, so a
// valid payloadLen is small; 16 MiB is a generous ceiling. The minimum is 5
// (1-byte type + 4-byte id + empty body). The set of legal type bytes is tiny.
const MIN_PAYLOAD = 5;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const VALID_TYPES = new Set<string>(Object.values(FrameType));

/** Encode one frame. `payloadLen` = 1 (type) + 4 (id) + body.length. */
export function encodeFrame(type: string, id: number, body: Uint8Array): Uint8Array {
  const payloadLen = 1 + 4 + body.length;
  const out = new Uint8Array(4 + payloadLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payloadLen, false);
  out[4] = type.charCodeAt(0);
  dv.setUint32(5, id, false);
  out.set(body, HEADER);
  return out;
}

export function encodeJsonFrame(type: string, id: number, obj: unknown): Uint8Array {
  return encodeFrame(type, id, new TextEncoder().encode(JSON.stringify(obj)));
}

export function decodeJson(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body));
}

/** Accumulates bytes from a byte stream and yields complete frames. */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: Frame[] = [];
    let off = 0;
    // Need at least the length (4) + type (1) to validate a frame boundary.
    while (this.buf.length - off >= 5) {
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + off);
      const payloadLen = dv.getUint32(0, false);
      const type = String.fromCharCode(this.buf[off + 4]!);
      // Resync: the guest's virtio-console tty can echo our input back to us as
      // caret-notation bytes — notably during the state-restore transient, before
      // guestd's raw termios re-dominates — prepending garbage to the stream. A
      // bogus length (~1.5 GB from `^@^@…`) would otherwise desync the reader
      // forever. Treat an implausible length or unknown type as line-noise: drop
      // one byte and re-scan until a real frame header appears. Clean frames
      // (valid type, small length) are unaffected.
      if (payloadLen < MIN_PAYLOAD || payloadLen > MAX_PAYLOAD || !VALID_TYPES.has(type)) {
        off += 1;
        continue;
      }
      if (this.buf.length - off - 4 < payloadLen) break; // incomplete (payloadLen>=5 ⇒ header is present once complete)
      const id = dv.getUint32(5, false);
      const body = this.buf.slice(off + HEADER, off + 4 + payloadLen);
      frames.push({ type, id, body });
      off += 4 + payloadLen;
    }
    if (off > 0) this.buf = this.buf.slice(off);
    return frames;
  }
}
