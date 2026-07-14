import { ErrnoError } from "@erdou/runtime-contract";
import type { ByteStream } from "@erdou/runtime-contract";
import { join, normalize } from "../vfs/path.js";

const decoder = new TextDecoder();

export async function readAll(stream: ByteStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream.read()) parts.push(chunk);
  const total = parts.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of parts) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function readAllText(stream: ByteStream): Promise<string> {
  return decoder.decode(await readAll(stream));
}

export const decode = (bytes: Uint8Array): string => decoder.decode(bytes);

export function describeError(err: unknown): string {
  if (err instanceof ErrnoError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Resolve a command argument (possibly relative) to an absolute path. */
export function abs(cwd: string, p: string): string {
  return p.startsWith("/") ? normalize(p) : join(cwd, p);
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

/** Split short flags: "-al" -> ['a','l']. Numeric-looking args ("-2") are not
 *  flags. Returns the flag set and the remaining positional args. */
export function shortFlags(
  args: string[],
  valueFlags: Set<string> = new Set(),
): { flags: Set<string>; positional: string[]; values: Map<string, string> } {
  const flags = new Set<string>();
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.length > 1 && a.startsWith("-") && !/^-\d/.test(a)) {
      const name = a.slice(1);
      if (valueFlags.has(name)) {
        values.set(name, args[++i] ?? "");
      } else {
        for (const ch of name) flags.add(ch);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, values };
}
