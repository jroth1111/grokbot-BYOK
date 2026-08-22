/**
 * Request ID generation and scoped logging.
 *
 * Each inbound request gets a short, unique ID (e.g. `req-3kf7a2`) that is
 * attached to every log line emitted while handling that request. This lets
 * you `grep req-3kf7a2` to see the full lifecycle: routing → upstream
 * connected → stream error → request complete, even when many requests are
 * interleaved in the log stream.
 *
 * The scoped logger wraps the base {@link Logger} so every call site
 * automatically includes the request ID without threading it through every
 * function parameter.
 */
import type { Logger } from "../types.js";

/**
 * Generate a short, unique request ID.
 *
 * Format: `req-` + 6 chars of base36 from Date.now() + random. Short enough
 * for log lines, unique enough that collisions are negligible under normal
 * load (36^6 ≈ 2.2 billion, ~4k requests/ms before collision risk).
 */
export function generateRequestId(): string {
  const time = Date.now().toString(36).slice(-4);
  const rand = Math.random().toString(36).slice(2, 6);
  return `req-${time}${rand}`;
}

/**
 * Create a scoped logger that injects `requestId` into every log call.
 *
 * The scoped logger wraps the base logger so all existing call sites
 * (`logger.info("routing request", {...})`) automatically include the
 * request ID without any changes to their code.
 */
export function createRequestScopedLogger(
  base: Logger,
  requestId: string,
): Logger {
  const inject = (fields?: Record<string, unknown>): Record<string, unknown> => {
    if (!fields) return { requestId };
    return { requestId, ...fields };
  };
  return {
    info: (msg, fields) => base.info(msg, inject(fields)),
    warn: (msg, fields) => base.warn(msg, inject(fields)),
    error: (msg, fields) => base.error(msg, inject(fields)),
  };
}
