/**
 * Circuit breaker for provider failover.
 *
 * Each provider has its own independent circuit state. After a configurable
 * number of consecutive failures the circuit opens and the provider is
 * skipped. The cooldown duration used to decide when to allow a half-open
 * probe depends on the error type that caused the circuit to open:
 *
 *  - 429 (rate limit):   network.rateLimitCooldownMs  (default 10000ms)
 *  - 5xx (server error): network.serverErrorCooldownMs (default 30000ms)
 *  - network error:      network.serverErrorCooldownMs (default 30000ms)
 *
 * Request-level errors (400/404/405/413/422) are not recorded at all — they
 * will fail on every provider so opening a circuit is pointless. Auth errors
 * (401/402/403) are a key-level concern and are likewise not recorded against
 * the provider circuit (the caller rotates the dead key instead). A 408
 * (request timeout) is treated as a transient transport failure.
 */

import type { NetworkConfig } from "../types.js";

/** Classification of an HTTP error by how the failover layer should react. */
export type ErrorType =
  | "rate-limit"
  | "server-error"
  | "network-error"
  | "auth-error"
  | "request-error";

/** Default cooldowns when a provider has no explicit NetworkConfig. */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10000;
const DEFAULT_SERVER_ERROR_COOLDOWN_MS = 30000;
const DEFAULT_FAILURE_THRESHOLD = 3;

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  open: boolean;
  openedAt: number;
  /** The error type that caused the circuit to open, if any. */
  openedByErrorType: ErrorType | null;
  /** Cooldown in ms computed from the opening error type + provider config. */
  cooldownMs: number;
}

export class CircuitBreaker {
  private states: Map<string, CircuitState> = new Map();
  /** Per-provider network configuration (set once at startup). */
  private configs: Map<string, NetworkConfig> = new Map();
  /** Fallback defaults used when a provider has no explicit config. */
  private defaultFailureThreshold: number;
  private defaultRateLimitCooldownMs: number;
  private defaultServerErrorCooldownMs: number;

  constructor(opts?: {
    failureThreshold?: number;
    rateLimitCooldownMs?: number;
    serverErrorCooldownMs?: number;
  }) {
    this.defaultFailureThreshold = opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.defaultRateLimitCooldownMs = opts?.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.defaultServerErrorCooldownMs = opts?.serverErrorCooldownMs ?? DEFAULT_SERVER_ERROR_COOLDOWN_MS;
  }

  /**
   * Set the per-provider network configuration. Called once at startup for
   * each provider so cooldown durations and the failure threshold can be
   * tuned independently.
   */
  setProviderConfig(providerName: string, network: NetworkConfig): void {
    this.configs.set(providerName, network);
  }

  /** Resolve the failure threshold for a provider. */
  private getFailureThreshold(providerName: string): number {
    return this.configs.get(providerName)?.failureThreshold ?? this.defaultFailureThreshold;
  }

  /** Resolve the cooldown for a given error type for a provider. */
  private getCooldownMs(providerName: string, errorType: ErrorType): number {
    const cfg = this.configs.get(providerName);
    if (errorType === "rate-limit") {
      return cfg?.rateLimitCooldownMs ?? this.defaultRateLimitCooldownMs;
    }
    // server-error, network-error both use the server-error cooldown.
    return cfg?.serverErrorCooldownMs ?? this.defaultServerErrorCooldownMs;
  }

  /**
   * Classify an HTTP status code into an error type.
   *
   * - 400/404/405/413/422: request-error (don't retry, don't failover — the
   *   request itself is bad/malformed and will fail on every provider)
   * - 401/402/403: auth-error (rotate key, no circuit — key/billing level)
   * - 408:     network-error (request timeout — transient, retry/backoff)
   * - 429:     rate-limit   (retry/backoff then failover)
   * - 5xx:     server-error (retry/backoff then failover)
   * - other:   network-error (treat like a transport failure)
   */
  classifyError(status: number): ErrorType {
    // Request-level errors: the request is malformed/unsupported and will
    // fail on every provider, so neither retry nor open the circuit.
    if (
      status === 400 ||
      status === 404 ||
      status === 405 ||
      status === 413 ||
      status === 422
    ) {
      return "request-error";
    }
    // Auth/billing errors: a key-level concern — rotate the dead key rather
    // than opening the provider circuit.
    if (status === 401 || status === 402 || status === 403) return "auth-error";
    // Request timeout: transient, treat like a transport failure so it can be
    // retried / failed over rather than stopping the whole request.
    if (status === 408) return "network-error";
    if (status === 429) return "rate-limit";
    if (status >= 500 && status < 600) return "server-error";
    return "network-error";
  }

  /** Lazily create (or fetch) the state record for a provider. */
  private getOrCreate(providerName: string): CircuitState {
    let state = this.states.get(providerName);
    if (!state) {
      state = {
        failures: 0,
        lastFailureTime: 0,
        open: false,
        openedAt: 0,
        openedByErrorType: null,
        cooldownMs: 0,
      };
      this.states.set(providerName, state);
    }
    return state;
  }

  /**
   * Returns true if the provider should be tried.
   *
   * A closed circuit is always tryable. An open circuit becomes tryable
   * once its cooldown (determined by the error type that opened it) has
   * elapsed since it opened (half-open probe). Note: this method does not
   * itself flip the circuit to half-open — the outcome of the probe is
   * recorded via `recordSuccess`/`recordFailure`.
   */
  shouldTry(providerName: string): boolean {
    const state = this.getOrCreate(providerName);
    if (!state.open) {
      return true;
    }
    const now = Date.now();
    return now - state.openedAt >= state.cooldownMs;
  }

  /**
   * Record a successful response: close the circuit and reset the failure
   * counter. This also covers the half-open probe success case.
   */
  recordSuccess(providerName: string): void {
    const state = this.getOrCreate(providerName);
    state.failures = 0;
    state.open = false;
    state.openedAt = 0;
    state.openedByErrorType = null;
    state.cooldownMs = 0;
  }

  /**
   * Record a failure with error type classification.
   *
   * - "request-error" (400/404/405/413/422): ignored — will fail on every
   *   provider.
   * - "auth-error" (401/402/403):    ignored — key-level issue, not
   *   provider-level.
   * - "rate-limit" (429):        increment failures; open with
   *   rateLimitCooldownMs.
   * - "server-error" (5xx):      increment failures; open with
   *   serverErrorCooldownMs.
   * - "network-error":           increment failures; open with
   *   serverErrorCooldownMs.
   *
   * A failure during a half-open probe (i.e. the cooldown has already
   * elapsed) re-opens the circuit, restarting the cooldown window using the
   * new error type. Failures that arrive while the circuit is still in its
   * cooldown (e.g. retries within the same request) are recorded but do NOT
   * push the cooldown window forward.
   *
   * A failure threshold of 0 disables the circuit breaker entirely — the
   * circuit never opens — giving 0 a distinct meaning from 1.
   */
  recordFailure(providerName: string, errorType: ErrorType): void {
    // Request-level and auth errors don't affect the provider circuit.
    if (errorType === "request-error" || errorType === "auth-error") {
      return;
    }

    const state = this.getOrCreate(providerName);
    const now = Date.now();
    state.failures += 1;
    state.lastFailureTime = now;

    const threshold = this.getFailureThreshold(providerName);

    // Already-open circuit: only re-open (restart the cooldown window) when
    // we are in a half-open probe — i.e. the cooldown has already elapsed.
    // Failures that arrive while the circuit is still cooling down (e.g.
    // retries within the same request) must NOT push the cooldown forward.
    if (state.open) {
      const halfOpen = now - state.openedAt >= state.cooldownMs;
      if (halfOpen) {
        state.openedAt = now;
        state.openedByErrorType = errorType;
        state.cooldownMs = this.getCooldownMs(providerName, errorType);
      }
      return;
    }

    // Closed circuit: open it once the failure threshold is reached. A
    // threshold of 0 disables the circuit breaker entirely.
    if (threshold > 0 && state.failures >= threshold) {
      state.open = true;
      state.openedAt = now;
      state.openedByErrorType = errorType;
      state.cooldownMs = this.getCooldownMs(providerName, errorType);
    }
  }

  /** Current state snapshot for logging/diagnostics. */
  getState(providerName: string): CircuitState {
    const state = this.states.get(providerName);
    if (!state) {
      return {
        failures: 0,
        lastFailureTime: 0,
        open: false,
        openedAt: 0,
        openedByErrorType: null,
        cooldownMs: 0,
      };
    }
    return {
      failures: state.failures,
      lastFailureTime: state.lastFailureTime,
      open: state.open,
      openedAt: state.openedAt,
      openedByErrorType: state.openedByErrorType,
      cooldownMs: state.cooldownMs,
    };
  }
}
