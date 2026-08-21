/**
 * Tests for provider routing, failover chains, and the circuit breaker.
 */
import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { CircuitBreaker } from "../src/providers/failover.js";
import type { ProviderConfig } from "../src/types.js";

/** Provider configs taken from config/config.example.json. */
function exampleConfigs(): Record<string, ProviderConfig> {
  return {
    "opencode-go": {
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "",
      defaultModel: "ox-alpha-free",
      models: {
        "ox alpha free": "ox-alpha-free",
        "ox alpha": "ox-alpha-free",
        "ox-alpha": "ox-alpha-free",
        "ox-alpha-free": "ox-alpha-free",
        "ox": "ox-alpha-free",
        "0x alpha": "ox-alpha-free",
        "0x-alpha": "ox-alpha-free",
        "0x": "ox-alpha-free",
        "x-preview-f-free": "ox-alpha-free",
        "go alpha": "ox-alpha-free",
        "go-alpha": "ox-alpha-free",
        "go": "ox-alpha-free",
        "sand-default": "ox-alpha-free",
        "sand default": "ox-alpha-free",
        "default": "ox-alpha-free",
      },
    },
    "opencode-zen": {
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "",
      defaultModel: "x-preview-f-free",
      models: {
        "0x alpha free": "x-preview-f-free",
        "0x alpha": "x-preview-f-free",
        "0x-alpha": "x-preview-f-free",
        "0x": "x-preview-f-free",
        "ox alpha free": "x-preview-f-free",
        "ox alpha": "x-preview-f-free",
        "ox-alpha": "x-preview-f-free",
        "ox": "x-preview-f-free",
        "x-preview-f-free": "x-preview-f-free",
      },
    },
    local: {
      baseUrl: "http://127.0.0.1:3003/v1",
      apiKey: "",
      defaultModel: "glm-5-2",
      models: {
        "glm-5.2 high": "glm-5-2-max",
        "glm-5.2 max": "glm-5-2-max",
        "glm-5-2-high": "glm-5-2-max",
        "glm-5-2-max": "glm-5-2-max",
        "glm-5.2": "glm-5-2",
        "glm-5-2": "glm-5-2",
        "glm5.2": "glm-5-2",
        "glm": "glm-5-2",
        "swe-1.7 max": "swe-1-7",
        "swe-1.7": "swe-1-7",
        "swe-1-7": "swe-1-7",
        "swe-1.6 slow": "swe-1-6-slow",
        "swe-1.6 fast": "swe-1-6-fast",
        "swe-1.6": "swe-1-6-fast",
        "swe-1-6-slow": "swe-1-6-slow",
        "swe-1-6-fast": "swe-1-6-fast",
        "swe": "swe-1-7",
        "sand-default": "glm-5-2",
        "deepseek-v4-flash": "deepseek-v4-flash",
        "deepseek-v4-pro": "deepseek-v4-pro",
        "muse-spark": "muse-spark-1.2-contributor",
      },
    },
  };
}

describe("ProviderRegistry.resolveProvider", () => {
  it("routes sand-default to opencode-go (first in priority that has it)", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const { provider } = registry.resolveProvider("sand-default");
    expect(provider.name).toBe("opencode-go");
  });

  it("routes glm-5.2 to local (only local has it)", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const { provider } = registry.resolveProvider("glm-5.2");
    expect(provider.name).toBe("local");
  });

  it("routes 0x alpha to opencode-go (first in priority)", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const { provider } = registry.resolveProvider("0x alpha");
    expect(provider.name).toBe("opencode-go");
  });

  it("falls back to the default provider for unknown models", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const { provider } = registry.resolveProvider("unknown-model");
    expect(provider.name).toBe("opencode-go");
  });

  it("routes 0x alpha to opencode-zen when it is first in priority", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-zen",
      "opencode-go",
      "local",
    ]);
    const { provider } = registry.resolveProvider("0x alpha");
    expect(provider.name).toBe("opencode-zen");
  });

  it("returns the normalized model id", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const { normalizedId } = registry.resolveProvider("  Sand-Default  ");
    expect(normalizedId).toBe("sand-default");
  });
});

describe("ProviderRegistry.getFailoverChain", () => {
  it("returns all providers in priority order starting with primary when failover=true", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const primary = registry.getProvider("opencode-go")!;
    const chain = registry.getFailoverChain(primary, true);
    expect(chain.map((p) => p.name)).toEqual([
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
  });

  it("starts with the primary even when it is not first in priority", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const primary = registry.getProvider("local")!;
    const chain = registry.getFailoverChain(primary, true);
    // Primary first, then remaining providers in priority order, deduped.
    expect(chain.map((p) => p.name)).toEqual([
      "local",
      "opencode-go",
      "opencode-zen",
    ]);
  });

  it("returns only the primary when failover=false", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const primary = registry.getProvider("opencode-go")!;
    const chain = registry.getFailoverChain(primary, false);
    expect(chain).toHaveLength(1);
    expect(chain[0].name).toBe("opencode-go");
  });

  it("does not duplicate the primary in the chain", () => {
    const configs = exampleConfigs();
    const registry = new ProviderRegistry(configs, [
      "opencode-go",
      "opencode-zen",
      "local",
    ]);
    const primary = registry.getProvider("opencode-go")!;
    const chain = registry.getFailoverChain(primary, true);
    const names = chain.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("CircuitBreaker", () => {
  it("allows trying all providers initially", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    expect(breaker.shouldTry("opencode-go")).toBe(true);
    expect(breaker.shouldTry("local")).toBe(true);
  });

  it("opens the circuit after the failure threshold is reached", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    breaker.recordFailure("opencode-go");
    breaker.recordFailure("opencode-go");
    expect(breaker.shouldTry("opencode-go")).toBe(true);
    breaker.recordFailure("opencode-go");
    expect(breaker.shouldTry("opencode-go")).toBe(false);
    expect(breaker.getState("opencode-go").open).toBe(true);
  });

  it("allows a half-open probe after resetTimeout elapses", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 50 });
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.shouldTry("p")).toBe(false);
    // Wait for the reset window to elapse.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(breaker.shouldTry("p")).toBe(true);
        resolve();
      }, 80);
    });
  });

  it("closes the circuit on recordSuccess", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.shouldTry("p")).toBe(false);
    breaker.recordSuccess("p");
    expect(breaker.shouldTry("p")).toBe(true);
    expect(breaker.getState("p").open).toBe(false);
    expect(breaker.getState("p").failures).toBe(0);
  });

  it("re-opens the circuit on recordFailure after a half-open probe", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 50 });
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Half-open: probe allowed.
        expect(breaker.shouldTry("p")).toBe(true);
        // A failed probe re-opens the circuit.
        breaker.recordFailure("p");
        expect(breaker.shouldTry("p")).toBe(false);
        expect(breaker.getState("p").open).toBe(true);
        resolve();
      }, 80);
    });
  });

  it("keeps provider states independent", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    breaker.recordFailure("a");
    breaker.recordFailure("a");
    expect(breaker.shouldTry("a")).toBe(false);
    expect(breaker.shouldTry("b")).toBe(true);
  });
});
