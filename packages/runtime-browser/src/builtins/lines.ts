import type { ByteStream } from "@erdou/runtime-contract";

/**
 * Line iteration shared by the streaming text tools (sed, awk). Both helpers
 * yield lines WITHOUT their trailing "\n" and treat a final unterminated line
 * as a line of its own. Consumers re-append "\n" per line they emit, so a
 * final line lacking a newline is normalized to end with one on output (the
 * same normalization head/tail here already apply).
 */

/** Stream lines from a byte stream, decoding UTF-8 incrementally — the whole
 *  input is never buffered, so piping a large file through sed/awk is O(line). */
export async function* streamLines(stream: ByteStream): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream.read()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf !== "") yield buf;
}

/** Lazily yield lines from an in-memory string (a VFS file's contents)
 *  without materializing a split array. */
export function* textLines(text: string): Generator<string, void, undefined> {
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      yield text.slice(start);
      return;
    }
    yield text.slice(start, nl);
    start = nl + 1;
  }
}
