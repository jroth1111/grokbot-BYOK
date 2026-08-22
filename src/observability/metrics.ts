/**
 * In-memory per-provider latency and request metrics.
 *
 * Maintains rolling counters and latency buckets per provider so the shim
 * can report aggregate stats without an external metrics backend. The data
 * is reset on process restart — for durable analytics, pipe the structured
 * JSON logs to an external sink.
 *
 * Bucket boundaries (ms): 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000.
 * Each request is counted in exactly one bucket (the smallest boundary it
 * exceeds, or the overflow bucket if it exceeds all).
 */
import type { Logger } from "../types.js";

/** Latency bucket boundaries in milliseconds. */
const LATENCY_BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000] as const;

/** Bucket labels for reporting. */
const BUCKET_LABELS = [
  "<50ms",
  "50-100ms",
  "100-200ms",
  "200-500ms",
  "500ms-1s",
  "1-2s",
  "2-5s",
  "5-10s",
  "10-30s",
  ">30s",
] as const;

interface ProviderStats {
  requests: number;
  successes: number;
  errors: number;
  /** Count per latency bucket (index aligns with LATENCY_BUCKETS). */
  latencyBuckets: number[];
  /** Sum of all latencies (ms) for average computation. */
  totalLatencyMs: number;
  /** Sum of TTFB (ms) for average computation. */
  totalTtfbMs: number;
  /** Count of requests with a TTFB measurement. */
  ttfbCount: number;
}

function newProviderStats(): ProviderStats {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    latencyBuckets: new Array<number>(LATENCY_BUCKETS.length + 1).fill(0),
    totalLatencyMs: 0,
    totalTtfbMs: 0,
    ttfbCount: 0,
  };
}

class MetricsCollector {
  private stats = new Map<string, ProviderStats>();

  /** Record a completed request. */
  recordRequest(
    provider: string,
    success: boolean,
    elapsedMs: number,
    ttfbMs?: number,
  ): void {
    let s = this.stats.get(provider);
    if (!s) {
      s = newProviderStats();
      this.stats.set(provider, s);
    }
    s.requests++;
    if (success) s.successes++;
    else s.errors++;
    s.totalLatencyMs += elapsedMs;
    // Find the bucket: first boundary the latency exceeds, else overflow.
    let bucketIdx: number = LATENCY_BUCKETS.length; // overflow
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      if (elapsedMs <= LATENCY_BUCKETS[i]) {
        bucketIdx = i;
        break;
      }
    }
    s.latencyBuckets[bucketIdx]++;
    if (ttfbMs !== undefined) {
      s.totalTtfbMs += ttfbMs;
      s.ttfbCount++;
    }
  }

  /** Get a snapshot of all provider stats. */
  snapshot(): Record<string, {
    requests: number;
    successes: number;
    errors: number;
    errorRate: number;
    avgLatencyMs: number;
    avgTtfbMs: number | null;
    latencyHistogram: Record<string, number>;
  }> {
    const result: Record<string, {
      requests: number;
      successes: number;
      errors: number;
      errorRate: number;
      avgLatencyMs: number;
      avgTtfbMs: number | null;
      latencyHistogram: Record<string, number>;
    }> = {};
    for (const [provider, s] of this.stats) {
      const histogram: Record<string, number> = {};
      for (let i = 0; i < BUCKET_LABELS.length; i++) {
        histogram[BUCKET_LABELS[i]] = s.latencyBuckets[i] ?? 0;
      }
      result[provider] = {
        requests: s.requests,
        successes: s.successes,
        errors: s.errors,
        errorRate: s.requests > 0 ? s.errors / s.requests : 0,
        avgLatencyMs: s.requests > 0 ? Math.round(s.totalLatencyMs / s.requests) : 0,
        avgTtfbMs: s.ttfbCount > 0 ? Math.round(s.totalTtfbMs / s.ttfbCount) : null,
        latencyHistogram: histogram,
      };
    }
    return result;
  }

  /** Log a summary of all provider stats. */
  logSummary(logger: Logger): void {
    const snap = this.snapshot();
    for (const [provider, s] of Object.entries(snap)) {
      logger.info("provider metrics", {
        provider,
        ...s,
      });
    }
  }
}

/** Singleton metrics collector shared across all requests. */
export const metrics = new MetricsCollector();
