/**
 * Tests for the retry-with-backoff helpers.
 */
import { describe, it, expect } from "vitest";
import { computeBackoff, sleep, shouldRetry } from "../src/providers/retry.js";

// ---------------------------------------------------------------------------
// computeBackoff
// ---------------------------------------------------------------------------

describe("computeBackoff", () => {
  it("grows exponentially with the attempt number", () => {
    // initial=100, max=100000 so the cap never kicks in for small attempts.
    const initial = 100;
    const max = 100000;
    const values: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      values.push(computeBackoff(attempt, initial, max));
    }
    // Each value should be within [0.8, 1.2] of the exponential base.
    // base = 100 * 2^attempt: 100, 200, 400, 800, 1600, 3200
    const bases = [100, 200, 400, 800, 1600, 3200];
    for (let i = 0; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(Math.floor(bases[i] * 0.8));
      expect(values[i]).toBeLessThanOrEqual(Math.floor(bases[i] * 1.2));
    }
    // Monotonic growth (jitter could in theory break this for adjacent
    // pairs, but with a 2x base growth the jitter range never overlaps).
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it("caps the backoff at maxMs", () => {
    const initial = 100;
    const max = 500;
    // attempt 10 would be 100 * 2^10 = 102400, well above the 500 cap.
    const value = computeBackoff(10, initial, max);
    // Capped at 500, then jittered into [0.8, 1.2] * 500 = [400, 600].
    expect(value).toBeGreaterThanOrEqual(Math.floor(500 * 0.8));
    expect(value).toBeLessThanOrEqual(Math.floor(500 * 1.2));
  });

  it("applies jitter in the range 0.8x to 1.2x", () => {
    const initial = 1000;
    const max = 100000;
    // attempt 0: base = 1000.
    const value = computeBackoff(0, initial, max);
    expect(value).toBeGreaterThanOrEqual(Math.floor(1000 * 0.8));
    expect(value).toBeLessThanOrEqual(Math.floor(1000 * 1.2));
  });

  it("returns an integer", () => {
    const value = computeBackoff(3, 123, 100000);
    expect(Number.isInteger(value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe("sleep", () => {
  it("resolves after the given delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// shouldRetry
// ---------------------------------------------------------------------------

describe("shouldRetry", () => {
  it("returns stop for request-error regardless of attempts", () => {
    expect(shouldRetry("request-error", 0, 3)).toBe("stop");
    expect(shouldRetry("request-error", 5, 3)).toBe("stop");
  });

  it("returns failover for auth-error regardless of attempts", () => {
    expect(shouldRetry("auth-error", 0, 3)).toBe("failover");
    expect(shouldRetry("auth-error", 5, 3)).toBe("failover");
  });

  it("returns retry for rate-limit when attempts remain", () => {
    expect(shouldRetry("rate-limit", 0, 3)).toBe("retry");
    expect(shouldRetry("rate-limit", 2, 3)).toBe("retry");
  });

  it("returns failover for rate-limit when attempts are exhausted", () => {
    expect(shouldRetry("rate-limit", 3, 3)).toBe("failover");
    expect(shouldRetry("rate-limit", 10, 3)).toBe("failover");
  });

  it("returns retry for server-error when attempts remain", () => {
    expect(shouldRetry("server-error", 0, 2)).toBe("retry");
    expect(shouldRetry("server-error", 1, 2)).toBe("retry");
  });

  it("returns failover for server-error when attempts are exhausted", () => {
    expect(shouldRetry("server-error", 2, 2)).toBe("failover");
    expect(shouldRetry("server-error", 5, 2)).toBe("failover");
  });

  it("returns retry for network-error when attempts remain", () => {
    expect(shouldRetry("network-error", 0, 1)).toBe("retry");
  });

  it("returns failover for network-error when attempts are exhausted", () => {
    expect(shouldRetry("network-error", 1, 1)).toBe("failover");
    expect(shouldRetry("network-error", 5, 1)).toBe("failover");
  });
});
