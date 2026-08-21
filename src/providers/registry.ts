/**
 * Provider registry with deterministic priority-based routing.
 *
 * The registry owns the set of configured providers and decides which one
 * handles a given request. Routing is driven entirely by the configured
 * priority list — there is no implicit ordering beyond it:
 *
 *   1. The first provider (in priority order) whose `canHandle` accepts the
 *      normalized model id wins.
 *   2. If no provider claims the id, the first provider in priority order
 *      (the default) is used.
 *
 * The registry also exposes a failover chain: the primary provider first,
 * followed by the remaining providers in priority order (deduplicated).
 */
import type { Provider, ProviderConfig } from "../types.js";
import { BaseProvider, normalizeModelId } from "./base.js";

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private priorityOrder: string[] = [];

  constructor(configs: Record<string, ProviderConfig>, priority: string[]) {
    // Preserve the configured priority order; only keep names that have a
    // matching config so the chain stays valid.
    this.priorityOrder = priority.filter((name) => name in configs);

    // Construct a BaseProvider for every config entry. Providers not listed
    // in the priority array are still registered (reachable via getProvider)
    // but won't appear in routing or failover chains.
    for (const [name, config] of Object.entries(configs)) {
      this.providers.set(name, new BaseProvider(name, config));
    }
  }

  /**
   * Resolve which provider should handle a request for the given model id.
   *
   * Returns both the chosen provider and the normalized model id so callers
   * can pass the normalized id to `provider.resolveModel` without
   * re-normalizing.
   */
  resolveProvider(modelId: string): { provider: Provider; normalizedId: string } {
    const normalizedId = normalizeModelId(modelId);

    for (const name of this.priorityOrder) {
      const provider = this.providers.get(name);
      if (provider && provider.canHandle(normalizedId)) {
        return { provider, normalizedId };
      }
    }

    // No provider claimed the model id — fall back to the default (first in
    // priority order). If priority is empty, pick any registered provider.
    const fallback =
      this.providers.get(this.priorityOrder[0] ?? "") ??
      this.providers.values().next().value;
    if (!fallback) {
      throw new Error("No providers configured");
    }
    return { provider: fallback, normalizedId };
  }

  /**
   * Build the failover chain for a given primary provider.
   *
   * When failover is disabled, only the primary provider is returned. When
   * enabled, the primary is returned first followed by every other provider
   * in priority order, with the primary not repeated.
   */
  getFailoverChain(primaryProvider: Provider, failover: boolean): Provider[] {
    if (!failover) {
      return [primaryProvider];
    }

    const chain: Provider[] = [primaryProvider];
    const seen = new Set<string>([primaryProvider.name]);

    for (const name of this.priorityOrder) {
      if (seen.has(name)) {
        continue;
      }
      const provider = this.providers.get(name);
      if (provider) {
        chain.push(provider);
        seen.add(name);
      }
    }

    return chain;
  }

  /** Look up a provider by name, or undefined if none is registered. */
  getProvider(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** All registered provider names (insertion order of the configs). */
  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /** The first provider in priority order (the routing default). */
  getDefaultProvider(): Provider {
    const provider = this.providers.get(this.priorityOrder[0] ?? "");
    if (!provider) {
      throw new Error("No providers configured");
    }
    return provider;
  }
}
