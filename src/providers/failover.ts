/**
 * Circuit breaker for provider failover.
 *
 * Each provider has its own independent circuit state. After
 * `failureThreshold` consecutive failures the circuit opens and the
 * provider is skipped. After `resetTimeoutMs` since the circuit opened, a
 * single half-open probe is allowed; a successful probe closes the circuit
 * while a failed probe re-opens it for another reset window.
 */

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  open: boolean;
  openedAt: number;
}

export class CircuitBreaker {
  private states: Map<string, CircuitState> = new Map();
  private failureThreshold: number;
  private resetTimeoutMs: number;

  constructor(opts?: { failureThreshold?: number; resetTimeoutMs?: number }) {
    this.failureThreshold = opts?.failureThreshold ?? 3;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? 30000;
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
      };
      this.states.set(providerName, state);
    }
    return state;
  }

  /**
   * Returns true if the provider should be tried.
   *
   * A closed circuit is always tryable. An open circuit becomes tryable
   * once `resetTimeoutMs` has elapsed since it opened (half-open probe).
   * Note: this method does not itself flip the circuit to half-open — the
   * outcome of the probe is recorded via `recordSuccess`/`recordFailure`.
   */
  shouldTry(providerName: string): boolean {
    const state = this.getOrCreate(providerName);
    if (!state.open) {
      return true;
    }
    const now = Date.now();
    return now - state.openedAt >= this.resetTimeoutMs;
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
  }

  /**
   * Record a failure: increment the consecutive-failure count and open the
   * circuit once the threshold is reached. A failure during a half-open
   * probe re-opens the circuit, restarting the reset timeout window.
   */
  recordFailure(providerName: string): void {
    const state = this.getOrCreate(providerName);
    const now = Date.now();
    state.failures += 1;
    state.lastFailureTime = now;

    if (state.failures >= this.failureThreshold) {
      state.open = true;
      state.openedAt = now;
    }
  }

  /** Current state snapshot for logging/diagnostics. */
  getState(providerName: string): { failures: number; open: boolean } {
    const state = this.states.get(providerName);
    if (!state) {
      return { failures: 0, open: false };
    }
    return { failures: state.failures, open: state.open };
  }
}
