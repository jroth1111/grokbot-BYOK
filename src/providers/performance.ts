/**
 * Rolling per-provider performance tracker for latency-based routing.
 *
 * Maintains exponentially-weighted moving averages (EWMA) of:
 *   - prefillMsPerPromptToken: TTFB / promptTokens (normalized prefill speed)
 *   - tokensPerSec: completion tokens / generation duration (decode speed)
 *   - error rate
 *
 * Both axes are normalized for work done, so providers are compared
 * apples-to-apples regardless of the request sizes they happened to
 * serve:
 *
 *   - TTFB is divided by prompt tokens → ms per prompt token. A provider
 *     that served a 100K-token prompt with 10s TTFB (0.1 ms/token) is
 *     scored better than one that served a 5K-token prompt with 2s TTFB
 *     (0.4 ms/token), even though the raw TTFB is 5x higher.
 *
 *   - tokens/sec is inherently normalized for output size.
 *
 * The combined score projects each provider's EWMA onto a reference
 * workload (rolling average of actual prompt + completion token counts)
 * to answer: "If I sent my average-sized request to each provider,
 * which would finish first?"
 *
 *   score = (prefillMsPerPromptToken × refPromptTokens)
 *         + (1000 / tokensPerSec × refCompletionTokens)
 *         × errorPenalty
 *
 * EWMA is used instead of a fixed window because it's O(1) memory per
 * provider and adapts quickly to changing conditions. The alpha (0.3)
 * gives a ~5-request adaptation window: new data has 30% weight, so a
 * sustained change converges to ~95% in ~10 requests.
 */

/** EWMA smoothing factor (higher = faster adaptation). */
const ALPHA = 0.3;

/** Minimum samples before trusting the score (use priority order below this). */
const MIN_SAMPLES = 3;

/** Penalty multiplier per error: each error reduces effective score by 20%. */
const ERROR_PENALTY = 0.2;

interface ProviderPerf {
  /** EWMA of TTFB / promptTokens (ms per prompt token). */
  prefillMsPerPromptToken: number;
  /** EWMA of tokens/sec (completion tokens / generation duration). */
  tokensPerSec: number;
  /** EWMA of error rate (0..1). */
  errorRate: number;
  /** Total samples recorded. */
  samples: number;
  /** Last update timestamp (ms since epoch). */
  lastUpdated: number;
}

/** Rolling average of the workload across ALL providers (request-size
 *  distribution), used as the reference workload for scoring. */
interface WorkloadAvg {
  /** EWMA of prompt tokens across all requests. */
  avgPromptTokens: number;
  /** EWMA of completion tokens across all requests. */
  avgCompletionTokens: number;
  /** Samples recorded. */
  samples: number;
}

class PerformanceTracker {
  private perf = new Map<string, ProviderPerf>();
  private workload: WorkloadAvg = {
    avgPromptTokens: 0,
    avgCompletionTokens: 0,
    samples: 0,
  };

  /**
   * Record a completed request's performance metrics.
   *
   * Both TTFB and throughput are normalized before the EWMA update so
   * the tracker stores per-unit-work rates, not raw latencies.
   */
  record(
    provider: string,
    success: boolean,
    ttfbMs: number | undefined,
    promptTokens: number,
    completionTokens: number,
    streamDurationMs: number,
  ): void {
    // Update the global workload average (across all providers) so the
    // reference workload reflects the actual request-size distribution.
    if (promptTokens > 0 || completionTokens > 0) {
      if (this.workload.samples === 0) {
        this.workload.avgPromptTokens = promptTokens;
        this.workload.avgCompletionTokens = completionTokens;
      } else {
        this.workload.avgPromptTokens =
          ALPHA * promptTokens + (1 - ALPHA) * this.workload.avgPromptTokens;
        this.workload.avgCompletionTokens =
          ALPHA * completionTokens + (1 - ALPHA) * this.workload.avgCompletionTokens;
      }
      this.workload.samples++;
    }

    let p = this.perf.get(provider);
    if (!p) {
      p = {
        prefillMsPerPromptToken: 0,
        tokensPerSec: 0,
        errorRate: 0,
        samples: 0,
        lastUpdated: 0,
      };
      this.perf.set(provider, p);
    }

    // Normalize TTFB by prompt tokens: ms per prompt token. This makes
    // prefill speed comparable across providers regardless of the prompt
    // sizes they happened to serve. Guard against zero prompt tokens
    // (e.g. empty completion with no usage data).
    const reqPrefillMsPerToken =
      ttfbMs !== undefined && promptTokens > 0
        ? ttfbMs / promptTokens
        : undefined;

    // Compute tokens/sec for this request. Use generation duration (from
    // first token to stream end), falling back to total elapsed if TTFB
    // wasn't recorded (e.g. empty completion).
    const generationMs = ttfbMs !== undefined
      ? Math.max(1, streamDurationMs - ttfbMs)
      : Math.max(1, streamDurationMs);
    const reqTokensPerSec = completionTokens / (generationMs / 1000);

    // EWMA update: blend the new sample with the running average.
    if (p.samples === 0) {
      p.prefillMsPerPromptToken = reqPrefillMsPerToken ?? 0;
      p.tokensPerSec = reqTokensPerSec;
      p.errorRate = success ? 0 : 1;
    } else {
      if (reqPrefillMsPerToken !== undefined) {
        p.prefillMsPerPromptToken =
          ALPHA * reqPrefillMsPerToken + (1 - ALPHA) * p.prefillMsPerPromptToken;
      }
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
   * The score projects the provider's normalized rates onto the reference
   * workload (rolling average of actual request sizes):
   *
   *   score = (prefillMsPerPromptToken × refPromptTokens
   *          + 1000 / tokensPerSec × refCompletionTokens)
   *         × errorPenalty
   *
   * This is the estimated wall-clock time (ms) to serve the average-sized
   * request, combining prefill (input-proportional) and generation
   * (output-proportional) latency, penalized by error rate.
   *
   * Returns Infinity for providers with no data (so they're tried last
   * and the priority order is used as a tiebreaker).
   */
  score(provider: string): number {
    const p = this.perf.get(provider);
    if (!p || p.samples < MIN_SAMPLES) return Infinity;

    // Reference workload: use rolling average, or fall back to a
    // reasonable default (10K prompt, 500 completion) if no data yet.
    const refPrompt = this.workload.samples > 0
      ? this.workload.avgPromptTokens
      : 10000;
    const refCompletion = this.workload.samples > 0
      ? this.workload.avgCompletionTokens
      : 500;

    // Prefill term: ms per prompt token × reference prompt size.
    const prefillMs = p.prefillMsPerPromptToken * refPrompt;

    // Generation term: ms per token × reference completion size.
    // Cap msPerToken at 10s to avoid division-by-near-zero.
    const msPerToken = p.tokensPerSec > 0
      ? Math.min(10000, 1000 / p.tokensPerSec)
      : 10000;
    const generationMs = msPerToken * refCompletion;

    // Combined: estimated total time for the reference workload,
    // penalized by error rate.
    const errorPenalty = 1 + p.errorRate * ERROR_PENALTY * 10;
    return (prefillMs + generationMs) * errorPenalty;
  }

  /** Get a snapshot of all provider performance stats. */
  snapshot(): Record<string, {
    samples: number;
    avgPrefillMsPerPromptToken: number;
    avgTokensPerSec: number;
    errorRate: number;
    score: number;
    refPromptTokens: number;
    refCompletionTokens: number;
  }> {
    const refPrompt = this.workload.samples > 0
      ? Math.round(this.workload.avgPromptTokens)
      : 0;
    const refCompletion = this.workload.samples > 0
      ? Math.round(this.workload.avgCompletionTokens)
      : 0;
    const result: Record<string, {
      samples: number;
      avgPrefillMsPerPromptToken: number;
      avgTokensPerSec: number;
      errorRate: number;
      score: number;
      refPromptTokens: number;
      refCompletionTokens: number;
    }> = {};
    for (const [provider, p] of this.perf) {
      result[provider] = {
        samples: p.samples,
        avgPrefillMsPerPromptToken: Math.round(p.prefillMsPerPromptToken * 1000) / 1000,
        avgTokensPerSec: Math.round(p.tokensPerSec * 10) / 10,
        errorRate: Math.round(p.errorRate * 100) / 100,
        score: Math.round(this.score(provider) / 10) / 100,
        refPromptTokens: refPrompt,
        refCompletionTokens: refCompletion,
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
