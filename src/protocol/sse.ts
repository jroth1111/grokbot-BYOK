/**
 * Server-Sent Events parser for OpenAI streaming responses.
 *
 * OpenAI streams chat completions as SSE: a series of `data:` lines terminated
 * by a blank line, with a final `data: [DONE]` sentinel. This class incrementally
 * buffers raw text, splits it into events, and queues the non-empty `data:`
 * payloads so the translation layer can pull them off as JSON chunks.
 */

/**
 * Incremental SSE parser.
 *
 * Feed it raw text as it arrives and drain completed `data:` payloads.
 */
export class SseParser {
  /** Unconsumed text that has not yet ended in a line break. */
  private buffer = "";

  /** Completed `data:` payloads awaiting {@link drain}. */
  private queue: string[] = [];

  /** Accumulator for the current event's `data:` lines. */
  private currentData: string[] = [];

  /**
   * Feed a chunk of raw SSE text to the parser.
   *
   * Lines are split on `\r\n` or `\n`. Non-`data:` field lines (`event:`,
   * `id:`, comments) are ignored. A blank line dispatches the accumulated
   * `data:` lines (joined with `\n`) into the queue, skipping empty payloads.
   *
   * @param chunk  Raw text received from the upstream stream.
   */
  feed(chunk: string): void {
    this.buffer += chunk;

    // Normalize CRLF to LF so we can split on a single delimiter. Any stray
    // lone \r is left in place and treated as ordinary content.
    const normalized = this.buffer.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    // The final element is whatever follows the last newline — it may be a
    // partial line with more to come, so keep it buffered.
    this.buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      this.processLine(rawLine);
    }
  }

  /**
   * Return all completed `data:` payloads and clear the queue.
   *
   * @returns The queued payloads in arrival order.
   */
  drain(): string[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /**
   * Process a single complete line (no trailing newline).
   */
  private processLine(line: string): void {
    // Strip a single trailing \r left from a CRLF that was split on \n only
    // after normalization missed it (e.g. lone \r\n inside content already
    // handled, but be defensive).
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    // A blank line dispatches the current event.
    if (line === "") {
      if (this.currentData.length > 0) {
        const payload = this.currentData.join("\n").trim();
        if (payload !== "") {
          this.queue.push(payload);
        }
        this.currentData = [];
      }
      return;
    }

    // Comment line (starts with ':').
    if (line.startsWith(":")) {
      return;
    }

    // `data:` field. Support both "data:value" and "data: value".
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      this.currentData.push(value.startsWith(" ") ? value.slice(1) : value);
      return;
    }

    // Other field types are ignored per the SSE spec.
    if (line.startsWith("event:") || line.startsWith("id:")) {
      return;
    }

    // Unknown field — ignore.
  }
}
