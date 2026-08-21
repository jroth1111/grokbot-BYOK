/**
 * Stream idle-timeout guard for SSE streaming.
 *
 * During a streaming response we want to detect a stalled connection — one
 * where the server is technically still connected but stops sending data
 * (e.g. an upstream proxy holding the socket open without producing bytes).
 * `createStreamTimeout` returns a guard whose `reset()` should be called on
 * every received chunk to keep the stream alive, and whose `clear()` should
 * be called when the stream ends or errors.
 */

/** A handle returned by {@link createStreamTimeout}. */
export interface StreamTimeoutGuard {
  /** Restart the idle timer. Call on each received chunk. */
  reset: () => void;
  /** Cancel the idle timer. Call when the stream ends or errors. */
  clear: () => void;
}

/**
 * Create a stream idle timeout guard.
 *
 * @param timeoutMs  How long to wait without any data before firing.
 * @param onTimeout  Callback invoked once when the idle timeout elapses.
 * @returns A guard with `reset()` and `clear()` methods.
 */
export function createStreamTimeout(
  timeoutMs: number,
  onTimeout: () => void,
): StreamTimeoutGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleared = false;
  let fired = false;

  // Clamp non-positive timeouts to 0. Node coerces negative delays to 0
  // implicitly, but making it explicit guarantees a next-tick fire rather
  // than relying on platform-specific behavior.
  const delay = timeoutMs > 0 ? timeoutMs : 0;

  const arm = (): void => {
    // Don't (re)arm once the guard has been cleared or has already fired —
    // onTimeout is documented to be invoked at most once.
    if (cleared || fired) return;
    timer = setTimeout(() => {
      timer = null;
      // Guard against a re-entrant reset() inside onTimeout re-arming and
      // double-firing.
      if (fired) return;
      fired = true;
      onTimeout();
    }, delay);
    // Unref the timer so an idle stream-timeout doesn't keep the Node event
    // loop (and therefore the process) alive on its own. Guarded for
    // non-Node environments where the handle is a number with no unref().
    if (
      timer !== null &&
      typeof (timer as { unref?: () => void }).unref === "function"
    ) {
      (timer as { unref: () => void }).unref();
    }
  };

  return {
    reset(): void {
      // Once fired the guard is done; reset() must not re-arm it.
      if (fired) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      arm();
    },
    clear(): void {
      cleared = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
