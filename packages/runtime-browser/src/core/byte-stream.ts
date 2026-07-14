import { ErrnoError } from "@erdou/runtime-contract";
import type { ByteStream, WritableByteStream } from "@erdou/runtime-contract";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Waiter = (result: IteratorResult<Uint8Array>) => void;

/**
 * A single-producer / single-consumer in-memory byte pipe. It is both a
 * readable and a writable stream, so a process's stdout can be handed to a
 * reader or wired into another process's stdin. Backpressure is out of scope
 * (everything is in memory). Writing after `end()` throws EBADF.
 */
export class PipeStream implements ByteStream, WritableByteStream {
  private readonly chunks: Uint8Array[] = [];
  private closed = false;
  private readonly waiters: Waiter[] = [];

  get isClosed(): boolean {
    return this.closed;
  }

  write(chunk: Uint8Array | string): void {
    if (this.closed) throw new ErrnoError("EBADF", { syscall: "write" });
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: bytes, done: false });
    } else {
      this.chunks.push(bytes);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter: Waiter | undefined;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined, done: true });
    }
  }

  read(): AsyncIterableIterator<Uint8Array> {
    const self = this;
    return {
      next(): Promise<IteratorResult<Uint8Array>> {
        const queued = self.chunks.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (self.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<Uint8Array>>((resolve) => {
          self.waiters.push(resolve);
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  async text(): Promise<string> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.read()) parts.push(chunk);
    const total = parts.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of parts) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return decoder.decode(out);
  }
}
