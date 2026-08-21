/**
 * Base provider implementation.
 *
 * Provides the shared logic that concrete provider factories build on:
 * model alias resolution and a normalized model-id helper. All concrete
 * providers are thin wrappers around this class (see ./opencode-go.ts,
 * ./opencode-zen.ts, and ./local.ts).
 */
import type { Provider, ProviderConfig } from "../types.js";

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
 */
export class BaseProvider implements Provider {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly models: Map<string, string>;

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
    this.models = new Map(Object.entries(config.models));
  }

  canHandle(normalizedModelId: string): boolean {
    return this.models.has(normalizedModelId);
  }

  resolveModel(normalizedModelId: string, rawModelId: string): string {
    return this.models.get(normalizedModelId) ?? this.defaultModel;
  }
}
