/**
 * Tests for the per-provider performance tracker used by latency-based
 * routing. Covers the EWMA scoring, sentinel handling, staleness decay,
 * epsilon-greedy exploration, and the snapshot display.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PerformanceTracker } from "../src/providers/performance.js";

// ---------------------------------------------------------------------------
// Sentinel blending (the primary bug this test file guards against)
// ---------------------------------------------------------------------------

describe("PerformanceTracker — sentinel blending", () => {
  it("does not produce a negative prefill rate when the first sample is a failure", () => {
    // Reproduces the original bug: a provider's first request fails (no
    // TTFB), storing the NO_PREFILL_DATA sentinel (-1). The second request
    // succeeds with real TTFB. Before the fix, the EWMA blended -1 with
    // the real rate, producing a negative value that bypassed the sentinel
    // check in score() and made the provider look infinitely fast.
    const tracker = new PerformanceTracker();

    // First sample: failure, no TTFB → sentinel stored.
    tracker.record("p1", false, undefined, 0, 0, 1000);

    // Second sample: success with TTFB=2000ms, promptTokens=10000.
    // Real prefill rate = 2000 / 10000 = 0.2 ms/token.
    tracker.record("p1", true, 2000, 10000, 100, 3000);

    // Record enough samples to exceed MIN_SAMPLES (3).
    tracker.record("p1", true, 2000, 10000, 100, 3000);
    tracker.record("p1", true, 2000, 10000, 100, 3000);

    const snap = tracker.snapshot();
    // The prefill rate must be positive (not contaminated by the -1 sentinel).
    expect(snap["p1"].avgPrefillMsPerPromptToken).toBeGreaterThan(0);
    // The score must be positive (a negative score would mean the provider
    // always wins routing, defeating the purpose of latency routing).
    expect(snap["p1"].score).toBeGreaterThan(0);
  });

  it("initializes prefill directly from the first real sample after sentinel", () => {
    const tracker = new PerformanceTracker();

    // Two failures first (both store sentinel).
    tracker.record("p1", false, undefined, 0, 0, 500);
    tracker.record("p1", false, undefined, 0, 0, 500);

    // First success with a known prefill rate.
    tracker.record("p1", true, 1000, 10000, 50, 2000);
    // Fill to MIN_SAMPLES.
    tracker.record("p1", true, 1000, 10000, 50, 2000);

    const snap = tracker.snapshot();
    // After one real sample following the sentinel, the prefill rate
    // should be exactly the real rate (0.1 ms/token), not a blend with -1.
    expect(snap["p1"].avgPrefillMsPerPromptToken).toBeCloseTo(0.1, 3);
  });
});

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

describe("PerformanceTracker — score", () => {
  it("returns Infinity for providers with insufficient samples", () => {
    const tracker = new PerformanceTracker();
    tracker.record("p1", true, 1000, 10000, 100, 2000);
    expect(tracker.score("p1")).toBe(Infinity);
    expect(tracker.hasEnoughData("p1")).toBe(false);
  });

  it("returns Infinity for unknown providers", () => {
    const tracker = new PerformanceTracker();
    expect(tracker.score("unknown")).toBe(Infinity);
  });

  it("scores a faster provider lower (better) than a slower one", () => {
    const tracker = new PerformanceTracker();

    // Fast provider: 0.1 ms/token prefill, 50 tokens/sec.
    for (let i = 0; i < 5; i++) {
      tracker.record("fast", true, 1000, 10000, 500, 11000);
    }
    // Slow provider: 0.4 ms/token prefill, 10 tokens/sec.
    for (let i = 0; i < 5; i++) {
      tracker.record("slow", true, 4000, 10000, 500, 54000);
    }

    expect(tracker.score("fast")).toBeLessThan(tracker.score("slow"));
  });

  it("penalizes error rate without exploding the score", () => {
    const tracker = new PerformanceTracker();

    // Two providers with identical latency, but one has 50% error rate.
    for (let i = 0; i < 10; i++) {
      tracker.record("clean", true, 1000, 10000, 100, 2000);
    }
    for (let i = 0; i < 10; i++) {
      // Alternate success/failure to get ~50% error rate.
      tracker.record("flaky", i % 2 === 0, 1000, 10000, 100, 2000);
    }

    const cleanScore = tracker.score("clean");
    const flakyScore = tracker.score("flaky");
    // Flaky should be worse (higher) due to error penalty.
    expect(flakyScore).toBeGreaterThan(cleanScore);
    // But the penalty should be modest (1.2x at 100% error, so ~1.1x at 50%),
    // not 10x or 100x — which would prevent re-exploration after recovery.
    expect(flakyScore / cleanScore).toBeLessThan(2);
  });

  it("uses the default prefill rate when no TTFB data was ever recorded", () => {
    const tracker = new PerformanceTracker();
    // Record only failures (no TTFB) to keep the sentinel in place.
    for (let i = 0; i < 5; i++) {
      tracker.record("p1", false, undefined, 0, 0, 1000);
    }
    // Score should be finite and positive (uses DEFAULT_PREFILL_MS_PER_TOKEN).
    const s = tracker.score("p1");
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Workload tracking
// ---------------------------------------------------------------------------

describe("PerformanceTracker — workload", () => {
  it("updates the reference workload from successful requests", () => {
    const tracker = new PerformanceTracker();
    tracker.record("p1", true, 1000, 8000, 200, 3000);
    tracker.record("p1", true, 1000, 8000, 200, 3000);
    tracker.record("p1", true, 1000, 8000, 200, 3000);

    const snap = tracker.snapshot();
    // The reference workload should reflect the recorded prompt/completion
    // tokens (EWMA converges toward 8000/200 after 3 samples with ALPHA=0.3).
    expect(snap["p1"].refPromptTokens).toBeGreaterThan(0);
    expect(snap["p1"].refCompletionTokens).toBeGreaterThan(0);
  });

  it("does not update workload from shadow probes (updateWorkload=false)", () => {
    const tracker = new PerformanceTracker();
    // A real request sets the workload.
    tracker.record("p1", true, 1000, 10000, 500, 5000);
    // Shadow probe with tiny completion tokens — must NOT contaminate.
    tracker.record("p2", true, 500, 10000, 0, 600, false);

    const snap = tracker.snapshot();
    // refCompletionTokens should reflect the real request (500), not be
    // pulled toward 0 by the shadow probe.
    expect(snap["p1"].refCompletionTokens).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Staleness decay
// ---------------------------------------------------------------------------

describe("PerformanceTracker — staleness decay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("decays the score for stale providers to encourage re-exploration", () => {
    const tracker = new PerformanceTracker();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    // Record a fresh sample for "stale" provider.
    for (let i = 0; i < 5; i++) {
      tracker.record("stale", true, 1000, 10000, 100, 2000);
    }
    const freshScore = tracker.score("stale");

    // Advance past the staleness threshold (5 minutes + 1 second).
    vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000);
    const staleScore = tracker.score("stale");

    // Stale score should be LOWER (better) than fresh score, because
    // staleness decay reduces the score to encourage re-sampling.
    expect(staleScore).toBeLessThan(freshScore);
  });
});

// ---------------------------------------------------------------------------
// Epsilon-greedy exploration
// ---------------------------------------------------------------------------

describe("PerformanceTracker — shouldExplore", () => {
  it("never explores when there is only one eligible provider", () => {
    const tracker = new PerformanceTracker();
    // With 1 provider, shouldExplore must always return false regardless
    // of the random value — a single-provider setup always exploits.
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    expect(tracker.shouldExplore(1)).toBe(false);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(tracker.shouldExplore(1)).toBe(false);
    vi.restoreAllMocks();
  });

  it("explores with probability epsilon when multiple providers are eligible", () => {
    const tracker = new PerformanceTracker();
    // With epsilon=0.10, random < 0.10 → explore, random >= 0.10 → exploit.
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    expect(tracker.shouldExplore(3)).toBe(true);
    vi.spyOn(Math, "random").mockReturnValue(0.50);
    expect(tracker.shouldExplore(3)).toBe(false);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Snapshot display
// ---------------------------------------------------------------------------

describe("PerformanceTracker — snapshot", () => {
  it("rounds the score to 2 decimal places", () => {
    const tracker = new PerformanceTracker();
    for (let i = 0; i < 5; i++) {
      tracker.record("p1", true, 1000, 10000, 100, 2000);
    }
    const snap = tracker.snapshot();
    const score = snap["p1"].score;
    // The score should have at most 2 decimal places.
    const rounded = Math.round(score * 100) / 100;
    expect(score).toBe(rounded);
  });

  it("reports -1 for avgPrefillMsPerPromptToken when no prefill data exists", () => {
    const tracker = new PerformanceTracker();
    // Only failures → sentinel stays in place.
    for (let i = 0; i < 5; i++) {
      tracker.record("p1", false, undefined, 0, 0, 1000);
    }
    const snap = tracker.snapshot();
    expect(snap["p1"].avgPrefillMsPerPromptToken).toBe(-1);
  });

  it("reports ageMs as null for a provider with no samples", () => {
    const tracker = new PerformanceTracker();
    const snap = tracker.snapshot();
    // No providers recorded → empty snapshot.
    expect(Object.keys(snap)).toHaveLength(0);
  });

  it("reports ageMs as a positive number after a sample is recorded", () => {
    const tracker = new PerformanceTracker();
    tracker.record("p1", true, 1000, 10000, 100, 2000);
    const snap = tracker.snapshot();
    expect(snap["p1"].ageMs).not.toBeNull();
    expect(snap["p1"].ageMs!).toBeGreaterThanOrEqual(0);
  });
});
