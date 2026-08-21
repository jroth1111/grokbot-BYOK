/**
 * Session affinity / sticky routing.
 *
 * Binds a session ID (derived from an InferenceStreamRequest's invocationId)
 * to a provider so that subsequent requests from the same session are routed
 * to the same provider. This preserves server-side prompt caching and
 * conversation continuity.
 *
 * The class itself does not set any timers; the caller is responsible for
 * invoking {@link SessionAffinity.cleanup} periodically (e.g. every 5 minutes).
 */
import type { InferenceStreamRequest, SessionAffinityConfig } from "../types.js";

/** A single session-to-provider binding. */
interface SessionBinding {
  /** The name of the provider the session is bound to. */
  providerName: string;
  /** Timestamp (ms) when the binding was first created. */
  boundAt: number;
  /** Timestamp (ms) of the most recent lookup via getBinding. */
  lastUsed: number;
}

/** Default TTL for bindings: 1 hour. */
const DEFAULT_TTL_MS = 3600000;

export class SessionAffinity {
  private bindings: Map<string, SessionBinding> = new Map();
  private readonly enabled: boolean;
  private readonly ttlMs: number;

  constructor(config: SessionAffinityConfig) {
    this.enabled = config.enabled;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Extract a session ID from an InferenceStreamRequest.
   *
   * Uses invocationId as the session key. Returns null if no session ID can be
   * determined (i.e. invocationId is absent or empty).
   */
  extractSessionId(reqJson: InferenceStreamRequest): string | null {
    const id = reqJson.invocationId;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
    return null;
  }

  /**
   * Look up the bound provider for a session ID.
   *
   * Returns the provider name if a binding exists and has not expired, null
   * otherwise. Updates lastUsed on a successful lookup. Expired bindings are
   * deleted on access.
   */
  getBinding(sessionId: string): string | null {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined) {
      return null;
    }
    if (this.isExpired(binding)) {
      this.bindings.delete(sessionId);
      return null;
    }
    binding.lastUsed = Date.now();
    return binding.providerName;
  }

  /**
   * Bind a session to a provider. Called after a provider successfully handles
   * a request. Creates a new binding or refreshes an existing one with the
   * current timestamp.
   */
  bind(sessionId: string, providerName: string): void {
    const now = Date.now();
    this.bindings.set(sessionId, {
      providerName,
      boundAt: now,
      lastUsed: now,
    });
  }

  /**
   * Check if a binding exists and is still valid (not expired).
   */
  hasValidBinding(sessionId: string): boolean {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined) {
      return false;
    }
    if (this.isExpired(binding)) {
      this.bindings.delete(sessionId);
      return false;
    }
    return true;
  }

  /**
   * Remove expired bindings. Should be called periodically by the caller
   * (e.g. every 5 minutes). The class does not set its own timer.
   */
  cleanup(): void {
    for (const [sessionId, binding] of this.bindings) {
      if (this.isExpired(binding)) {
        this.bindings.delete(sessionId);
      }
    }
  }

  /** Whether session affinity is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Determine whether a binding has exceeded its TTL.
   * A binding is expired if Date.now() - boundAt > ttlMs.
   */
  private isExpired(binding: SessionBinding): boolean {
    return Date.now() - binding.boundAt > this.ttlMs;
  }
}
