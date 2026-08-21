/**
 * Provider registry with pluggable routing strategies.
 *
 * The registry owns the set of configured providers and decides which one
 * handles a given request. Routing is driven by the configured priority list
 * together with a {@link RoutingStrategy}:
 *
 *   - "priority" / "fill-first": The first provider (in priority order) whose
 *     `canHandle` accepts the normalized model id wins. All traffic goes to
 *     the highest-priority provider until it fails (the circuit breaker then
 *     removes it from rotation).
 *   - "round-robin": Among providers that `canHandle` the model, rotate
 *     through them in round-robin fashion. A per-model cursor tracks position.
 *   - "weighted-round-robin": Among providers that `canHandle` the model,
 *     select based on the smooth weighted round-robin (SWRR) algorithm using
 *     each provider's first key weight.
 *
 * If no provider claims the id, the first provider in priority order (the
 * default) is used. The registry also exposes a failover chain whose shape
 * depends on the active strategy.
 */
import type { Provider, ProviderConfig, RoutingStrategy } from "../types.js";
import { BaseProvider, normalizeModelId } from "./base.js";

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private priorityOrder: string[] = [];
  private readonly strategy: RoutingStrategy;

  /** Round-robin cursor per normalized model id. */
  private roundRobinCursors: Map<string, number> = new Map();

  /** SWRR state: normalizedModelId -> providerName -> currentWeight. */
  private weightedState: Map<string, Map<string, number>> = new Map();

  constructor(
    configs: Record<string, ProviderConfig>,
    priority: string[],
    strategy: RoutingStrategy = "priority",
  ) {
    this.strategy = strategy;

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

  /** The active routing strategy. */
  getStrategy(): RoutingStrategy {
    return this.strategy;
  }

  /**
   * Resolve which provider should handle a request for the given model id.
   *
   * Returns both the chosen provider and the normalized model id so callers
   * can pass the normalized id to `provider.resolveModel` without
   * re-normalizing. Selection honors the configured routing strategy.
   */
  resolveProvider(modelId: string): { provider: Provider; normalizedId: string } {
    const normalizedId = normalizeModelId(modelId);

    if (this.strategy === "round-robin") {
      const selected = this.selectRoundRobin(normalizedId);
      if (selected) {
        return { provider: selected, normalizedId };
      }
    } else if (this.strategy === "weighted-round-robin") {
      const selected = this.selectWeighted(normalizedId);
      if (selected) {
        return { provider: selected, normalizedId };
      }
    }

    // "priority" and "fill-first" share the same selection logic: the first
    // provider in priority order that canHandle the model. This is also the
    // fallback when a round-robin/weighted strategy has no eligible provider.
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
   * Round-robin selection among providers that canHandle the model.
   *
   * Returns the selected provider, or undefined when no eligible provider
   * exists. Advances the per-model cursor so the next call picks the
   * following provider in rotation.
   */
  private selectRoundRobin(normalizedId: string): Provider | undefined {
    const eligible = this.eligibleProviders(normalizedId);
    if (eligible.length === 0) {
      return undefined;
    }
    const cursor = this.roundRobinCursors.get(normalizedId) ?? 0;
    const idx = cursor % eligible.length;
    const selected = eligible[idx];
    this.roundRobinCursors.set(normalizedId, idx + 1);
    return selected;
  }

  /**
   * Smooth weighted round-robin (SWRR) selection.
   *
   * For each eligible provider we maintain a running "current weight". On
   * every request each provider's current weight is increased by its
   * configured weight, the provider with the highest current weight is
   * selected, and the total configured weight is then subtracted from the
   * selected provider's current weight. This yields a smooth distribution
   * proportional to the configured weights.
   */
  private selectWeighted(normalizedId: string): Provider | undefined {
    const eligible = this.eligibleProviders(normalizedId);
    if (eligible.length === 0) {
      return undefined;
    }

    // Clamp each provider's effective weight to >= 0. A negative weight is
    // invalid configuration; if left as-is it can shrink the total weight
    // toward zero (or below), which breaks the SWRR invariant: subtracting
    // a non-positive total from the selected provider's current weight would
    // never reduce it (or would increase it), so that provider's current
    // weight would grow without bound and it would be selected forever.
    const weights = eligible.map((p) => Math.max(0, this.providerWeight(p)));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    // When every eligible provider has zero weight, the SWRR algorithm is
    // degenerate: every provider's current weight stays 0 and the strict
    // `>` comparison always picks the first one. Fall back to plain
    // round-robin so traffic still distributes evenly across eligible
    // providers instead of hammering the first one forever.
    if (totalWeight === 0) {
      return this.selectRoundRobin(normalizedId);
    }

    let state = this.weightedState.get(normalizedId);
    if (!state) {
      state = new Map<string, number>();
      this.weightedState.set(normalizedId, state);
    }

    let best: Provider | undefined;
    let bestWeight = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < eligible.length; i++) {
      const provider = eligible[i];
      const weight = weights[i];
      const current = (state.get(provider.name) ?? 0) + weight;
      state.set(provider.name, current);
      if (current > bestWeight) {
        bestWeight = current;
        best = provider;
      }
    }

    if (best) {
      state.set(best.name, (state.get(best.name) ?? 0) - totalWeight);
    }
    return best;
  }

  /**
   * Providers (in priority order) that canHandle the given normalized model
   * id. Only providers listed in the priority order are considered.
   */
  private eligibleProviders(normalizedId: string): Provider[] {
    const result: Provider[] = [];
    for (const name of this.priorityOrder) {
      const provider = this.providers.get(name);
      if (provider && provider.canHandle(normalizedId)) {
        result.push(provider);
      }
    }
    return result;
  }

  /** The configured weight for a provider (from its first key, default 1). */
  private providerWeight(provider: Provider): number {
    return provider.keys[0]?.weight ?? 1;
  }

  /**
   * Build the failover chain for a given primary provider.
   *
   * When failover is disabled, only the primary provider is returned. When
   * enabled, the chain shape depends on the routing strategy:
   *
   *   - "priority" / "fill-first": the primary first, followed by every other
   *     provider in priority order (deduplicated).
   *   - "round-robin": the selected provider first, then the remaining
   *     eligible providers in round-robin order, then the rest in priority
   *     order.
   *   - "weighted-round-robin": the selected provider first, then the
   *     remaining eligible providers ordered by descending weight, then the
   *     rest in priority order.
   *
   * The optional `normalizedModelId` is required for strategy-aware chains
   * (round-robin / weighted-round-robin); when omitted the priority-order
   * chain is produced regardless of strategy.
   */
  getFailoverChain(
    primaryProvider: Provider,
    failover: boolean,
    normalizedModelId?: string,
  ): Provider[] {
    if (!failover) {
      return [primaryProvider];
    }

    // Strategy-aware chains need to know which providers canHandle the model.
    if (
      normalizedModelId !== undefined &&
      (this.strategy === "round-robin" ||
        this.strategy === "weighted-round-robin")
    ) {
      return this.strategyAwareChain(primaryProvider, normalizedModelId);
    }

    // "priority" / "fill-first" (and the no-model-id fallback): primary first
    // then every other provider in priority order, deduplicated.
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

  /**
   * Build a strategy-aware failover chain for round-robin / weighted strategies.
   *
   * The chain is: [selected, ...other eligible providers in strategy order,
   * ...remaining providers in priority order], deduplicated.
   */
  private strategyAwareChain(
    primaryProvider: Provider,
    normalizedModelId: string,
  ): Provider[] {
    const chain: Provider[] = [primaryProvider];
    const seen = new Set<string>([primaryProvider.name]);

    const eligible = this.eligibleProviders(normalizedModelId);

    // Order the other eligible providers according to the strategy.
    let orderedEligible: Provider[];
    if (eligible.length === 0) {
      // No provider canHandle the model (e.g. the primary was the
      // strategy-fallback default). Skip strategy ordering entirely — the
      // priority-order tail below still gives failover somewhere to go.
      // Guarding here also avoids `cursor % 0` producing NaN.
      orderedEligible = [];
    } else if (this.strategy === "round-robin") {
      // Continue the round-robin rotation from the position after the
      // selected provider so the failover chain mirrors live routing.
      const cursor = this.roundRobinCursors.get(normalizedModelId) ?? 0;
      const start = cursor % eligible.length;
      orderedEligible = [];
      for (let i = 0; i < eligible.length; i++) {
        orderedEligible.push(eligible[(start + i) % eligible.length]);
      }
    } else {
      // weighted-round-robin: remaining eligible providers by descending weight.
      orderedEligible = [...eligible].sort(
        (a, b) => this.providerWeight(b) - this.providerWeight(a),
      );
    }

    for (const provider of orderedEligible) {
      if (seen.has(provider.name)) {
        continue;
      }
      chain.push(provider);
      seen.add(provider.name);
    }

    // Append the rest (providers that cannot handle the model) in priority
    // order so failover still has somewhere to go if every eligible provider
    // is unavailable.
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
