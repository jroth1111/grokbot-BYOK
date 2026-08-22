/**
 * Rolling per-provider performance tracker for latency-based routing.
 *
 * Maintains exponentially-weighted moving averages (EWMA) of:
 *   - TTFB (time to first token)
 *   - tokens/sec (completion tokens / stream duration)
 *   - error rate
 *
 * The combined score blends TTFB and throughput so the router prefers
 * providers that are both fast to start AND fast to generate. Error rate
 * acts as a penalty multiplier so an error-prone provider is deprioritized
 * even if its latency is good.
 *
 * EWMA is used instead of a fixed window because it's O(1) memory per
 * provider and adapts quickly to changing conditions without storing
 * individual request timestamps. The alpha (0.3) gives a ~5-request
 * adaptation window: new data has 30% weight, so a sustained change
 * converges to ~95% in ~10 requests.
 */

/** EWMA smoothing factor (higher = faster adaptation). */
const ALPHA = 0.3;

/** Minimum samples before trusting the score (use priority order below this). */
const MIN_SAMPLES = 3;

/** Penalty multiplier per error: each error reduces effective score by 20%. */
const ERROR_PENALTY = 0.2;

interface ProviderPerf {
  /** EWMA of TTFB in ms. */
  ttfbMs: number;
  /** EWMA of tokens/sec. */
  tokensPerSec: number;
  /** EWMA of error rate (0..1). */
  errorRate: number;
  /** Total samples recorded. */
  samples: number;
  /** Last update timestamp (ms since epoch). */
  lastUpdated: number;
}

class PerformanceTracker {
  private perf = new Map<string, ProviderPerf>();

  /** Record a completed request's performance metrics. */
  record(
    provider: string,
    success: boolean,
    ttfbMs: number | undefined,
    completionTokens: number,
    streamDurationMs: number,
  ): void {
    let p = this.perf.get(provider);
    if (!p) {
      p = {
        ttfbMs: 0,
        tokensPerSec: 0,
        errorRate: 0,
        samples: 0,
        lastUpdated: 0,
      };
      this.perf.set(provider, p);
    }

    // Compute tokens/sec for this request. Use stream duration (from first
    // token to stream end), falling back to total elapsed if TTFB wasn't
    // recorded (e.g. empty completion).
    const generationMs = ttfbMs !== undefined
      ? Math.max(1, streamDurationMs - ttfbMs)
      : Math.max(1, streamDurationMs);
    const reqTokensPerSec = completionTokens / (generationMs / 1000);

    // EWMA update: blend the new sample with the running average.
    if (p.samples === 0) {
      // First sample: initialize directly.
      p.ttfbMs = ttfbMs ?? 0;
      p.tokensPerSec = reqTokensPerSec;
      p.errorRate = success ? 0 : 1;
    } else {
      p.ttfbMs = ttfbMs !== undefined
        ? ALPHA * ttfbMs + (1 - ALPHA) * p.ttfbMs
        : p.ttfbMs;
      p.tokensPerSec = ALPHA * reqTokensPerSec + (1 - ALPHA) * p.tokensPerSec;
      const errVal = success ? 0 : 1;
      p.errorRate = ALPHA * errVal + (1 - ALPHA) * p.errorRate;
    }
    p.samples++;
    p.lastUpdated = Date.now();
  }

  /**
   * Compute a combined performance score for a provider. Lower is better.
   *
   * The score blends TTFB (ms) and throughput (tokens/sec) into a single
   * "effective time per token" metric:
   *
   *   score = (ttfbMs + 1000 / tokensPerSec) * errorPenalty
   *
   * This represents the wall-clock time to get the first token plus the
   * time to generate one token, penalized by error rate. A provider with
   * low TTFB but slow generation will score worse than one with slightly
   * higher TTFB but fast generation.
   *
   * Returns Infinity for providers with no data (so they're tried last
   * and the priority order is used as a tiebreaker).
   */
  score(provider: string): number {
    const p = this.perf.get(provider);
    if (!p || p.samples < MIN_SAMPLES) return Infinity;

    // Throughput term: time to generate 1 token (ms). Cap at 10s/token
    // to avoid division-by-near-zero issues with very low token counts.
    const msPerToken = p.tokensPerSec > 0
      ? Math.min(10000, 1000 / p.tokensPerSec)
      : 10000;

    // Combined: TTFB + time per token, penalized by error rate.
    // Each error adds ERROR_PENALTY (20%) to the effective score.
    const errorPenalty = 1 + p.errorRate * ERROR_PENALTY * 10;
    return (p.ttfbMs + msPerToken) * errorPenalty;
  }

  /** Get a snapshot of all provider performance stats. */
  snapshot(): Record<string, {
    samples: number;
    avgTtfbMs: number;
    avgTokensPerSec: number;
    errorRate: number;
    score: number;
  }> {
    const result: Record<string, {
      samples: number;
      avgTtfbMs: number;
      avgTokensPerSec: number;
      errorRate: number;
      score: number;
    }> = {};
    for (const [provider, p] of this.perf) {
      result[provider] = {
        samples: p.samples,
        avgTtfbMs: Math.round(p.ttfbMs),
        avgTokensPerSec: Math.round(p.tokensPerSec * 10) / 10,
        errorRate: Math.round(p.errorRate * 100) / 100,
        score: Math.round(this.score(provider) * 10) / 10,
      };
    }
    return result;
  }

  /** Has this provider accumulated enough samples for a reliable score? */
  hasEnoughData(provider: string): boolean {
    const p = this.perf.get(provider);
    return p !== undefined && p.samples >= MIN_SAMPLES;
  }
}

/** Singleton performance tracker shared across all requests. */
export const performanceTracker = new PerformanceTracker();
