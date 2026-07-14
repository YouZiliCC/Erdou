import type { Executor, ExecContext } from "@erdou/runtime-contract";
import { WasiHost, WasiExit } from "./wasi.js";

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function readStdin(ctx: ExecContext): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of ctx.stdin.read()) parts.push(chunk);
  return concat(parts);
}

function absPath(cwd: string, p: string): string {
  if (p.startsWith("/")) return p;
  return cwd === "/" ? `/${p}` : `${cwd}/${p}`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A `wasi` executor: runs a `wasm32-wasi` module from the filesystem. Invoked
 * as `wasi /path/prog.wasm [args...]`, or directly as `/path/prog.wasm [args...]`
 * when the runtime routes `*.wasm` commands here. This is the general mechanism
 * for Rust / C / C++ / Zig / TinyGo (any wasm32-wasi binary).
 */
export function createWasiRunner(opts?: { now?: () => number }): Executor {
  const now = opts?.now ?? (() => Date.now());
  return async (ctx) => {
    let wasmArg: string | undefined;
    let programArgs: string[];
    if (ctx.argv[0]?.endsWith(".wasm")) {
      wasmArg = ctx.argv[0];
      programArgs = ctx.argv;
    } else {
      wasmArg = ctx.argv[1];
      programArgs = ctx.argv.slice(1);
    }
    if (!wasmArg) {
      ctx.stderr.write("wasi: usage: wasi <program.wasm> [args...]\n");
      return 2;
    }

    let bytes: Uint8Array;
    try {
      bytes = ctx.fs.readFile(absPath(ctx.cwd, wasmArg));
    } catch (err) {
      ctx.stderr.write(`wasi: cannot read '${wasmArg}': ${message(err)}\n`);
      return 2;
    }

    const stdin = await readStdin(ctx);
    const host = new WasiHost({
      args: programArgs,
      env: ctx.env,
      fs: ctx.fs,
      cwd: ctx.cwd,
      stdin,
      writeStdout: (b) => ctx.stdout.write(b),
      writeStderr: (b) => ctx.stderr.write(b),
      now,
    });

    let instance: WebAssembly.Instance;
    try {
      const module = await WebAssembly.compile(bytes);
      instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: host.imports,
        wasi_unstable: host.imports,
      });
    } catch (err) {
      ctx.stderr.write(`wasi: failed to load module: ${message(err)}\n`);
      return 1;
    }

    const memory = instance.exports["memory"];
    if (!(memory instanceof WebAssembly.Memory)) {
      ctx.stderr.write("wasi: module does not export memory\n");
      return 1;
    }
    host.bind(memory);

    const start = instance.exports["_start"];
    try {
      if (typeof start === "function") {
        (start as () => void)();
      } else {
        ctx.stderr.write("wasi: module has no _start export\n");
        return 1;
      }
    } catch (err) {
      if (err instanceof WasiExit) return err.code;
      ctx.stderr.write(`wasi: ${message(err)}\n`);
      return 1;
    }
    return host.exitCode;
  };
}
