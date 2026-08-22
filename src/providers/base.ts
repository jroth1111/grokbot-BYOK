/**
 * Base provider implementation.
 *
 * Provides the shared logic that concrete provider factories build on:
 * model alias resolution, multi-key support with round-robin rotation,
 * and a normalized model-id helper.
 */
import type { KeyInfo, NetworkConfig, Provider, ProviderConfig } from "../types.js";
import { resolveCompat } from "./compat.js";
import type { ProviderCompat } from "./compat.js";

/**
 * Normalize a raw model id for alias lookup.
 *
 * Trims surrounding whitespace and lowercases the result so that alias
 * matching is case- and whitespace-insensitive. Returns "" for nullish
 * input so callers can safely use the result as a Map key.
 */
export function normalizeModelId(
  id: string | undefined | null,
): string {
  if (id === undefined || id === null) {
    return "";
  }
  return id.trim().toLowerCase();
}

/**
 * A configured LLM provider adapter with alias-based model routing.
 *
 * The provider owns a map from normalized model aliases to the canonical
 * model id that should be sent to its upstream API. `canHandle` reports
 * whether this provider recognizes a given normalized id, and
 * `resolveModel` maps it to the canonical id (falling back to the
 * provider's default model when no alias matches).
 *
 * A provider may hold multiple API keys (see `keys`). `selectKey` rotates
 * round-robin among enabled, non-failed keys; `markKeyFailed` removes a
 * key from rotation. When every key has failed, the failure set is reset
 * so keys get another chance.
 */
export class BaseProvider implements Provider {
  readonly name: string;
  readonly baseUrl: string;
  readonly keys: KeyInfo[];
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly network: NetworkConfig;
  readonly models: Map<string, string>;
  /** Resolved provider compat flags (auto-detected from name/baseUrl/model). */
  readonly compat: ProviderCompat;

  /** Round-robin cursor for key selection. Bounded to prevent overflow. */
  private keyCursor: number = 0;
  /**
   * Values of keys that have been marked as failed and are temporarily out
   * of rotation. Tracked by key *value* (string) rather than by object
   * reference so that a caller who reconstructs or clones a KeyInfo can
   * still mark it failed and have it skipped by selectKey.
   */
  private failedKeys: Set<string> = new Set();

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    // Guard against undefined/null baseUrl and trim surrounding whitespace
    // before stripping trailing slashes so edge cases like
    // "https://example.com/v1/ " are handled correctly.
    this.baseUrl = (config.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.defaultModel = config.defaultModel;
    this.network = config.network ?? {};

    // Build the keys array. If `config.keys` is provided and non-empty,
    // use those (filtering out explicitly disabled keys). Otherwise,
    // create a single KeyInfo from the legacy `config.apiKey` field.
    // If all provided keys are disabled (leaving an empty array after
    // filtering), fall back to the legacy `config.apiKey` so selectKey
    // never returns undefined.
    if (config.keys && config.keys.length > 0) {
      this.keys = config.keys.filter((k) => k.enabled !== false);
    } else {
      this.keys = [];
    }
    if (this.keys.length === 0) {
      this.keys = [{ value: config.apiKey, weight: 1, enabled: true }];
    }

    // Convenience: the first key's value for single-key providers.
    this.apiKey = this.keys[0]?.value ?? config.apiKey;

    // Build the alias map from the provider-level models config.
    this.models = new Map<string, string>(
      Object.entries(config.models ?? {}),
    );

    this.compat = resolveCompat(
      name,
      this.baseUrl,
      this.defaultModel,
      config.compat,
    );
  }

  canHandle(normalizedModelId: string): boolean {
    return this.models.has(normalizedModelId);
  }

  resolveModel(normalizedModelId: string): string {
    return this.models.get(normalizedModelId) ?? this.defaultModel;
  }

  /**
   * Select the next enabled API key using round-robin rotation.
   *
   * Skips keys that have been marked as failed. If every key has failed,
   * the failure set is cleared and the first key is returned so that
   * requests get another chance rather than failing hard.
   */
  selectKey(): KeyInfo {
    const enabled = this.keys.filter(
      (k) => k.enabled !== false && !this.failedKeys.has(k.value),
    );
    if (enabled.length === 0) {
      // All keys failed — reset and try again.
      this.failedKeys.clear();
      return this.keys[0];
    }
    const key = enabled[this.keyCursor % enabled.length];
    // Wrap the cursor within enabled.length to prevent unbounded growth
    // on long-running servers. This is safe because enabled.length only
    // changes when markKeyFailed or resetKeyFailures is called, both of
    // which reset keyCursor to 0.
    this.keyCursor = (this.keyCursor + 1) % enabled.length;
    return key;
  }

  /**
   * Mark a key as failed, removing it from rotation until all keys have
   * failed (at which point `selectKey` resets the failure set) or until
   * `resetKeyFailures` is called (at the start of a new request).
   *
   * The cursor is reset so the next `selectKey` picks the first remaining
   * enabled key in stable order rather than a cursor-dependent offset into
   * a now-shorter enabled array.
   */
  markKeyFailed(key: KeyInfo): void {
    this.failedKeys.add(key.value);
    this.keyCursor = 0;
  }

  /**
   * Clear the failed-key set and reset the cursor. Called at the start of
   * each request so a transient 401 on one key in a previous request
   * doesn't permanently remove it from rotation.
   */
  resetKeyFailures(): void {
    this.failedKeys.clear();
    this.keyCursor = 0;
  }
}
