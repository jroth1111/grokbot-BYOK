/**
 * Retry-with-backoff helpers.
 *
 * These are used by the request layer to decide whether to retry a failed
 * request against the same provider (with exponential backoff + jitter) or
 * to give up on the current provider and fail over to the next one. Error
 * classification is shared with the circuit breaker in `failover.ts`.
 */

import type { ErrorType } from "./failover.js";

/** What the request layer should do after a failed attempt. */
export type RetryDecision = "retry" | "failover" | "stop";

/**
 * Compute the backoff delay (in ms) for a given attempt number.
 *
 * Formula: `min(initial * 2^attempt, max) * jitter` where jitter is a random
 * multiplier in the range [0.8, 1.2]. `attempt` is zero-based: the first
 * retry uses attempt 0, the second attempt 1, etc.
 */
export function computeBackoff(attempt: number, initialMs: number, maxMs: number): number {
  // Clamp negative attempts to 0. A negative retry count is nonsensical and
  // would otherwise shrink the backoff below `initialMs` via `2^negative`.
  const safeAttempt = Math.max(0, attempt);
  const exponential = initialMs * Math.pow(2, safeAttempt);
  // Guard against `Math.pow` overflow: for very large attempts `2^attempt`
  // becomes `Infinity`, and `0 * Infinity` becomes `NaN`. In either case fall
  // back to the cap instead of letting `NaN` propagate through the jitter.
  const capped = Number.isFinite(exponential) ? Math.min(exponential, maxMs) : maxMs;
  const jitter = 0.8 + Math.random() * 0.4; // 0.8 .. 1.2
  return Math.floor(capped * jitter);
}

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide what to do after a failed attempt given the classified error type.
 *
 * - "request-error" (400/404): "stop" — will fail on every provider.
 * - "auth-error" (401/403):    "failover" — rotate key/provider, no backoff.
 * - "rate-limit" (429):        "retry" while attempts remain, else "failover".
 * - "server-error" (5xx):      "retry" while attempts remain, else "failover".
 * - "network-error":           "retry" while attempts remain, else "failover".
 *
 * `attempt` is the number of retries already performed (zero-based), so a
 * value of 0 means "no retries have happened yet".
 */
export function shouldRetry(
  errorType: ErrorType,
  attempt: number,
  maxRetries: number,
): RetryDecision {
  // Clamp negative attempts to 0. A negative value would otherwise satisfy
  // `attempt < maxRetries` even when `maxRetries` is 0, granting a retry that
  // the caller never authorised.
  const safeAttempt = Math.max(0, attempt);
  switch (errorType) {
    case "request-error":
      return "stop";
    case "auth-error":
      return "failover";
    case "rate-limit":
    case "server-error":
    case "network-error":
      return safeAttempt < maxRetries ? "retry" : "failover";
    default:
      return "failover";
  }
}
