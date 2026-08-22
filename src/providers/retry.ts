/**
 * Retry-with-backoff helpers.
 *
 * These are used by the request layer to decide whether to retry a failed
 * request against the same provider (with exponential backoff + jitter) or
 * to give up on the current provider and fail over to the next one. Error
 * classification is shared with the circuit breaker in `failover.ts`.
 */

import type { ErrorType } from "./failover.js";
import {
  classifyRateLimitReason,
  backoffForRateLimitReason,
} from "../observability/rate-limit.js";

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
 * - "empty-completion":        "failover" — provider is healthy, model returned nothing.
 * - "invalid-tool-arguments":  "failover" — provider is healthy, model misbehaved.
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
    case "empty-completion":
    case "invalid-tool-arguments":
      return "failover";
    case "rate-limit":
    case "server-error":
    case "network-error":
      return safeAttempt < maxRetries ? "retry" : "failover";
    default:
      return "failover";
  }
}

/**
 * Compute a backoff for a rate-limit error using the rate-limit reason
 * classifier. Instead of a flat exponential backoff, this classifies the
 * 429 message into one of: quota exhausted (30 min), rate limit exceeded
 * (30s), concurrent limit (5s), model capacity exhausted (45s ± jitter),
 * server error (20s), or unknown (fall through to exponential).
 *
 * Returns `null` when the error is not a rate limit or when the caller
 * should use the default exponential backoff instead.
 */
export function computeRateLimitBackoff(
  errorType: ErrorType,
  errorMessage: string,
): number | null {
  if (errorType !== "rate-limit") return null;
  const reason = classifyRateLimitReason(errorMessage);
  if (reason === "UNKNOWN") return null;
  return backoffForRateLimitReason(reason);
}
