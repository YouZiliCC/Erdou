/**
 * Parse a Server-Sent-Events response body, yielding each event's data.
 * Handles CRLF and LF boundaries, concatenates multiple `data:` lines within
 * an event (per the SSE spec), and never yields an empty payload.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match: RegExpExecArray | null;
    // Event boundary = a blank line: \n\n, \r\n\r\n, or \r\r.
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data: string[] = [];
      for (const line of rawEvent.split(/\r\n|\r|\n/)) {
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      const payload = data.join("\n");
      if (payload.length > 0) yield payload;
    }
  }
}
