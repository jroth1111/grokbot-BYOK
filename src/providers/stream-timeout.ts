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

  const arm = (): void => {
    if (cleared) return;
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
    }, timeoutMs);
  };

  return {
    reset(): void {
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
