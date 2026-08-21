/**
 * Base provider implementation.
 *
 * Provides the shared logic that concrete provider factories build on:
 * model alias resolution, multi-key support with round-robin rotation,
 * and a normalized model-id helper. All concrete providers are thin
 * wrappers around this class (see ./opencode-go.ts, ./opencode-zen.ts,
 * and ./local.ts).
 */
import type { KeyInfo, NetworkConfig, Provider, ProviderConfig } from "../types.js";

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

  /** Round-robin cursor for key selection. */
  private keyCursor: number = 0;
  /** Keys that have been marked as failed and are temporarily out of rotation. */
  private failedKeys: Set<KeyInfo> = new Set();

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.defaultModel = config.defaultModel;
    this.network = config.network ?? {};

    // Build the keys array. If `config.keys` is provided and non-empty,
    // use those (filtering out explicitly disabled keys). Otherwise,
    // create a single KeyInfo from the legacy `config.apiKey` field.
    if (config.keys && config.keys.length > 0) {
      this.keys = config.keys.filter((k) => k.enabled !== false);
    } else {
      this.keys = [{ value: config.apiKey, weight: 1, enabled: true }];
    }

    // Keep `apiKey` as the first key's value for backward compatibility.
    this.apiKey = this.keys[0]?.value ?? config.apiKey;

    // Build the merged models map: start from provider-level aliases,
    // then merge each key's per-key aliases (per-key overrides
    // provider-level for the same alias).
    const mergedModels = new Map<string, string>(Object.entries(config.models));
    for (const key of this.keys) {
      if (key.models) {
        for (const [alias, model] of Object.entries(key.models)) {
          mergedModels.set(alias, model);
        }
      }
    }
    this.models = mergedModels;
  }

  canHandle(normalizedModelId: string): boolean {
    return this.models.has(normalizedModelId);
  }

  resolveModel(normalizedModelId: string, rawModelId: string): string {
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
      (k) => k.enabled !== false && !this.failedKeys.has(k),
    );
    if (enabled.length === 0) {
      // All keys failed — reset and try again.
      this.failedKeys.clear();
      return this.keys[0];
    }
    const key = enabled[this.keyCursor % enabled.length];
    this.keyCursor++;
    return key;
  }

  /**
   * Mark a key as failed, removing it from rotation until all keys have
   * failed (at which point `selectKey` resets the failure set).
   */
  markKeyFailed(key: KeyInfo): void {
    this.failedKeys.add(key);
  }
}
