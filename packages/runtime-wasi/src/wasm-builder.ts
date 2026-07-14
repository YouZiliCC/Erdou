// A tiny hand-rolled WASM encoder — just enough to build real wasm32-wasi test
// modules without a toolchain. Not part of the public API (test support).
const enc = new TextEncoder();

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function sleb(n: number): number[] {
  const out: number[] = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

function name(s: string): number[] {
  const b = [...enc.encode(s)];
  return [...uleb(b.length), ...b];
}
function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}
function vec(items: number[][]): number[] {
  return [uleb(items.length), items].flat(2) as number[];
}

const TYPE_VOID_VOID = [0x60, ...uleb(0), ...uleb(0)];
const i32 = 0x7f;

function assemble(sections: number[][]): Uint8Array {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

const memExport = [...name("memory"), 0x02, ...uleb(0)];
const startExport = [...name("_start"), 0x00, ...uleb(1)];
const mem1 = section(5, vec([[0x00, ...uleb(1)]]));

/** A module whose _start calls proc_exit(code). */
export function moduleProcExit(code: number): Uint8Array {
  const types = section(1, vec([[0x60, ...uleb(1), i32, ...uleb(0)], TYPE_VOID_VOID]));
  const imports = section(2, vec([[...name("wasi_snapshot_preview1"), ...name("proc_exit"), 0x00, ...uleb(0)]]));
  const funcs = section(3, vec([[...uleb(1)]]));
  const exports = section(7, vec([memExport, startExport]));
  const body = [...uleb(0), 0x41, ...sleb(code), 0x10, ...uleb(0), 0x0b];
  const code10 = section(10, vec([[...uleb(body.length), ...body]]));
  return assemble([types, imports, funcs, mem1, exports, code10]);
}

/** A module whose _start writes `text` to fd 1 (stdout), then returns. */
export function moduleFdWrite(text: string): Uint8Array {
  const data = [...enc.encode(text)];
  const iovAddr = 0;
  const dataAddr = 16;
  const types = section(
    1,
    vec([[0x60, ...uleb(4), i32, i32, i32, i32, ...uleb(1), i32], TYPE_VOID_VOID]),
  );
  const imports = section(2, vec([[...name("wasi_snapshot_preview1"), ...name("fd_write"), 0x00, ...uleb(0)]]));
  const funcs = section(3, vec([[...uleb(1)]]));
  const exports = section(7, vec([memExport, startExport]));
  const body = [
    ...uleb(0),
    0x41, ...sleb(1), // fd = 1
    0x41, ...sleb(iovAddr), // iovs ptr
    0x41, ...sleb(1), // iovs len
    0x41, ...sleb(200), // nwritten ptr
    0x10, ...uleb(0), // call fd_write
    0x1a, // drop
    0x0b, // end
  ];
  const code10 = section(10, vec([[...uleb(body.length), ...body]]));
  // active data segments: iovec [ptr=dataAddr, len] at iovAddr, then the text at dataAddr
  const iov = [dataAddr & 0xff, (dataAddr >> 8) & 0xff, 0, 0, data.length & 0xff, (data.length >> 8) & 0xff, 0, 0];
  const seg = (offset: number, bytes: number[]): number[] => [
    0x00,
    0x41, ...sleb(offset), 0x0b,
    ...uleb(bytes.length),
    ...bytes,
  ];
  const dataSec = section(11, vec([seg(iovAddr, iov), seg(dataAddr, data)]));
  return assemble([types, imports, funcs, mem1, exports, code10, dataSec]);
}
