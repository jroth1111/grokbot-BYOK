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

/** After this many ms since the last sample, a provider's data is considered
 *  stale and its score is decayed toward zero to encourage re-exploration.
 *  Default: 5 minutes. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** Sentinel value for "no prefill data yet" — distinguishes "we haven't
 *  measured TTFB yet" from "TTFB is actually 0 ms". When set, the score()
 *  function uses a neutral default instead of 0 (which would make the
 *  provider look infinitely fast on prefill). */
const NO_PREFILL_DATA = -1;

/** Default prefill rate (ms/prompt token) used when no data is available.
 *  0.1 ms/token is a reasonable mid-range value (~10s TTFB for a 100K
 *  token prompt). Using this instead of 0 prevents new providers from
 *  looking artificially fast before real data accumulates. */
const DEFAULT_PREFILL_MS_PER_TOKEN = 0.1;

/** Exploration rate (epsilon) for epsilon-greedy routing. With this
 *  probability, a random eligible provider is selected instead of the
 *  best-scoring one, ensuring all providers accumulate fresh data.
 *  Default: 0.10 (10% of requests explore). */
const DEFAULT_EPSILON = 0.10;

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
   *
   * @param updateWorkload When false, skips updating the global workload
   *   average. Used by shadow probes which have truncated completionTokens
   *   (~20 tokens) — including them would contaminate the reference
   *   workload and make the generation term in the score meaningless.
   */
  record(
    provider: string,
    success: boolean,
    ttfbMs: number | undefined,
    promptTokens: number,
    completionTokens: number,
    streamDurationMs: number,
    updateWorkload: boolean = true,
  ): void {
    // Update the global workload average (across all providers) so the
    // reference workload reflects the actual request-size distribution.
    // Shadow probes skip this (updateWorkload=false) because their
    // completionTokens is truncated (~20) and would contaminate the avg.
    if (updateWorkload && (promptTokens > 0 || completionTokens > 0)) {
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
        prefillMsPerPromptToken: NO_PREFILL_DATA,
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
      // First sample: initialize directly. If no TTFB data, use the
      // sentinel (not 0) so the provider doesn't look artificially fast.
      p.prefillMsPerPromptToken = reqPrefillMsPerToken ?? NO_PREFILL_DATA;
      // Don't initialize tokensPerSec to 0 for failed requests (no
      // completion tokens) — that would make the provider look infinitely
      // slow. The error rate already penalizes failures; throughput
      // should only be updated from successful generation data.
      p.tokensPerSec = completionTokens > 0 ? reqTokensPerSec : 0;
      p.errorRate = success ? 0 : 1;
    } else {
      if (reqPrefillMsPerToken !== undefined) {
        p.prefillMsPerPromptToken =
          ALPHA * reqPrefillMsPerToken + (1 - ALPHA) * p.prefillMsPerPromptToken;
      }
      // Only update throughput EWMA from requests that actually produced
      // tokens. A failed request (completionTokens=0) yields tokensPerSec=0,
      // which would double-penalize the provider alongside the errorRate
      // penalty. Skip the throughput update for failures — the errorRate
      // already captures the failure signal.
      if (completionTokens > 0) {
        p.tokensPerSec = ALPHA * reqTokensPerSec + (1 - ALPHA) * p.tokensPerSec;
      }
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
    // If no prefill data has been recorded yet (sentinel value), use a
    // neutral default so the provider doesn't look artificially fast.
    const prefillRate = p.prefillMsPerPromptToken === NO_PREFILL_DATA
      ? DEFAULT_PREFILL_MS_PER_TOKEN
      : p.prefillMsPerPromptToken;
    const prefillMs = prefillRate * refPrompt;

    // Generation term: ms per token × reference completion size.
    // Cap msPerToken at 10s to avoid division-by-near-zero.
    const msPerToken = p.tokensPerSec > 0
      ? Math.min(10000, 1000 / p.tokensPerSec)
      : 10000;
    const generationMs = msPerToken * refCompletion;

    // Combined: estimated total time for the reference workload,
    // penalized by error rate.
    const errorPenalty = 1 + p.errorRate * ERROR_PENALTY * 10;
    const baseScore = (prefillMs + generationMs) * errorPenalty;

    // Staleness decay: reduce the score for providers with stale data
    // so they get re-explored. The decay factor goes from 1.0 (fresh)
    // to 0.5 at STALE_THRESHOLD_MS, then asymptotes toward 0.1 beyond
    // that. This ensures stale providers are preferred over fresh ones
    // with similar scores, triggering a re-sample.
    const ageMs = Date.now() - p.lastUpdated;
    const stalenessDecay = ageMs < STALE_THRESHOLD_MS
      ? 1.0 - 0.5 * (ageMs / STALE_THRESHOLD_MS)
      : Math.max(0.1, 0.5 * Math.exp(-(ageMs - STALE_THRESHOLD_MS) / STALE_THRESHOLD_MS));

    return baseScore * stalenessDecay;
  }

  /** Get a snapshot of all provider performance stats. */
  snapshot(): Record<string, {
    samples: number;
    avgPrefillMsPerPromptToken: number;
    avgTokensPerSec: number;
    errorRate: number;
    score: number;
    ageMs: number | null;
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
      ageMs: number | null;
      refPromptTokens: number;
      refCompletionTokens: number;
    }> = {};
    for (const [provider, p] of this.perf) {
      result[provider] = {
        samples: p.samples,
        avgPrefillMsPerPromptToken: p.prefillMsPerPromptToken === NO_PREFILL_DATA
          ? -1
          : Math.round(p.prefillMsPerPromptToken * 1000) / 1000,
        avgTokensPerSec: Math.round(p.tokensPerSec * 10) / 10,
        errorRate: Math.round(p.errorRate * 100) / 100,
        score: Math.round(this.score(provider) / 10) / 100,
        ageMs: this.ageMs(provider),
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

  /**
   * Epsilon-greedy exploration: with probability epsilon, return true to
   * indicate the caller should pick a random eligible provider instead of
   * the best-scoring one. This ensures all providers accumulate fresh
   * performance data, preventing the router from getting locked into one
   * provider and never discovering that another has become faster.
   *
   * The exploration is only triggered when there are multiple eligible
   * providers — a single-provider setup always exploits.
   */
  shouldExplore(eligibleCount: number): boolean {
    if (eligibleCount <= 1) return false;
    return Math.random() < DEFAULT_EPSILON;
  }

  /** Return ms since the last sample for a provider (for logging). */
  ageMs(provider: string): number | null {
    const p = this.perf.get(provider);
    if (!p || p.lastUpdated === 0) return null;
    return Date.now() - p.lastUpdated;
  }
}

/** Singleton performance tracker shared across all requests. */
export const performanceTracker = new PerformanceTracker();
