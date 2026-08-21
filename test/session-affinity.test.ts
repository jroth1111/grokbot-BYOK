/**
 * Tests for session affinity / sticky routing.
 */
import { describe, it, expect } from "vitest";
import { SessionAffinity } from "../src/providers/session-affinity.js";
import type { InferenceStreamRequest } from "../src/types.js";

/** Promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// extractSessionId
// ---------------------------------------------------------------------------

describe("SessionAffinity.extractSessionId", () => {
  it("returns the invocationId when present", () => {
    const sa = new SessionAffinity({ enabled: true });
    const req: InferenceStreamRequest = { invocationId: "sess-123" };
    expect(sa.extractSessionId(req)).toBe("sess-123");
  });

  it("returns null when invocationId is absent", () => {
    const sa = new SessionAffinity({ enabled: true });
    const req: InferenceStreamRequest = { messages: [] };
    expect(sa.extractSessionId(req)).toBeNull();
  });

  it("returns null when invocationId is an empty string", () => {
    const sa = new SessionAffinity({ enabled: true });
    const req: InferenceStreamRequest = { invocationId: "" };
    expect(sa.extractSessionId(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getBinding / bind
// ---------------------------------------------------------------------------

describe("SessionAffinity.getBinding", () => {
  it("returns null for an unbound session", () => {
    const sa = new SessionAffinity({ enabled: true });
    expect(sa.getBinding("unknown-session")).toBeNull();
  });

  it("returns the provider name for a bound session", () => {
    const sa = new SessionAffinity({ enabled: true });
    sa.bind("sess-1", "opencode-go");
    expect(sa.getBinding("sess-1")).toBe("opencode-go");
  });

  it("returns null and deletes an expired binding", async () => {
    const sa = new SessionAffinity({ enabled: true, ttlMs: 50 });
    sa.bind("sess-1", "opencode-go");
    await delay(80);
    expect(sa.getBinding("sess-1")).toBeNull();
    // Verify the binding was actually deleted from the map, not merely
    // reported as expired (getBinding returns null in both cases).
    const bindings = (sa as unknown as { bindings: Map<string, unknown> })
      .bindings;
    expect(bindings.has("sess-1")).toBe(false);
  });
});

describe("SessionAffinity.bind", () => {
  it("creates a binding that getBinding can find", () => {
    const sa = new SessionAffinity({ enabled: true });
    sa.bind("sess-1", "local");
    expect(sa.getBinding("sess-1")).toBe("local");
  });

  it("refreshes an existing binding", async () => {
    const sa = new SessionAffinity({ enabled: true, ttlMs: 200 });
    sa.bind("sess-1", "opencode-go");
    // Re-bind halfway through the TTL to refresh boundAt.
    await delay(100);
    sa.bind("sess-1", "opencode-zen");
    // Wait beyond the original TTL — the refreshed binding should survive.
    await delay(150);
    expect(sa.getBinding("sess-1")).toBe("opencode-zen");
  });
});

// ---------------------------------------------------------------------------
// hasValidBinding
// ---------------------------------------------------------------------------

describe("SessionAffinity.hasValidBinding", () => {
  it("returns true for a valid binding", () => {
    const sa = new SessionAffinity({ enabled: true });
    sa.bind("sess-1", "opencode-go");
    expect(sa.hasValidBinding("sess-1")).toBe(true);
  });

  it("returns false for a non-existent binding", () => {
    const sa = new SessionAffinity({ enabled: true });
    expect(sa.hasValidBinding("nope")).toBe(false);
  });

  it("returns false for an expired binding", async () => {
    const sa = new SessionAffinity({ enabled: true, ttlMs: 50 });
    sa.bind("sess-1", "opencode-go");
    await delay(80);
    expect(sa.hasValidBinding("sess-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("SessionAffinity.cleanup", () => {
  it("removes expired bindings", async () => {
    const sa = new SessionAffinity({ enabled: true, ttlMs: 50 });
    sa.bind("expired", "opencode-go");
    await delay(80);
    // Bind "fresh" now so it is still within its TTL after cleanup.
    sa.bind("fresh", "opencode-zen");
    sa.cleanup();
    expect(sa.hasValidBinding("expired")).toBe(false);
    expect(sa.hasValidBinding("fresh")).toBe(true);
  });

  it("is a no-op when there are no bindings", () => {
    const sa = new SessionAffinity({ enabled: true });
    expect(() => sa.cleanup()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isEnabled
// ---------------------------------------------------------------------------

describe("SessionAffinity.isEnabled", () => {
  it("returns true when enabled", () => {
    const sa = new SessionAffinity({ enabled: true });
    expect(sa.isEnabled()).toBe(true);
  });

  it("returns false when disabled", () => {
    const sa = new SessionAffinity({ enabled: false });
    expect(sa.isEnabled()).toBe(false);
  });
});
