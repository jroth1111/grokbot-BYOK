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
   * Lines are split on `\r\n`, `\r`, or `\n` (all three are valid SSE line
   * terminators). Non-`data:` field lines (`event:`, `id:`, comments) are
   * ignored. A blank line dispatches the accumulated `data:` lines (joined
   * with `\n`) into the queue, skipping empty payloads.
   *
   * @param chunk  Raw text received from the upstream stream.
   */
  feed(chunk: string): void {
    this.buffer += chunk;

    // A trailing '\r' is ambiguous: it may be a lone CR (a line break on its
    // own, per the SSE spec) or the opening byte of a CRLF whose '\n' has not
    // arrived yet. Peel it off before normalizing so it is neither consumed as
    // a lone-CR break nor collapsed into the wrong line; it is re-attached to
    // the retained partial so the next feed can complete a CRLF.
    let work = this.buffer;
    let pendingCr = "";
    if (work.endsWith("\r")) {
      pendingCr = "\r";
      work = work.slice(0, -1);
    }

    // Normalize every line terminator to '\n'. CRLF first (so the '\r' is not
    // doubled into two breaks), then any remaining lone CR — the SSE spec
    // recognizes a lone CR as a line terminator just like LF. After this,
    // 'work' contains no '\r' characters.
    work = work.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const lines = work.split("\n");

    // The final element is whatever follows the last line break — it may be a
    // partial line with more to come, so keep it buffered along with the
    // peeled trailing CR (if any).
    this.buffer = (lines.pop() ?? "") + pendingCr;

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
    // 'line' is a complete line with its terminator already stripped by feed()'s
    // normalization, so it contains no '\r' characters.

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
