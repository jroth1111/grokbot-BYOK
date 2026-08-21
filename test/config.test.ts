/**
 * Tests for the config loader and zod schema validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  interpolateEnv,
  DEFAULT_CONFIG,
} from "../src/config.js";
import {
  parseConfig,
  shimConfigSchema,
  providerConfigSchema,
} from "../src/config/schema.js";
import type { ShimConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minimal valid provider config block used across schema tests. */
function validProviders() {
  return {
    priority: ["opencode-go"],
    configs: {
      "opencode-go": {
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "secret",
        defaultModel: "ox-alpha-free",
        models: { "ox alpha": "ox-alpha-free" },
      },
    },
  };
}

/** Minimal valid hostConfig block. */
function validHostConfig() {
  return { sandHostDir: "", defaultModel: "Ox Alpha Free" };
}

/** Minimal valid sessionAffinity block. */
function validSessionAffinity() {
  return { enabled: false };
}

/** Write a temp JSON config file and return its absolute path. */
function writeTempConfig(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-cfg-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
  return file;
}

/** Recursively delete a directory (temp config cleanup). */
function cleanupTemp(file: string): void {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// interpolateEnv
// ---------------------------------------------------------------------------

describe("interpolateEnv", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.FOO = process.env.FOO;
    saved.BAR = process.env.BAR;
    saved.MY_VAR = process.env.MY_VAR;
    saved._MY_VAR = process.env._MY_VAR;
    saved.MISSING_VAR = process.env.MISSING_VAR;
  });

  afterEach(() => {
    delete process.env.FOO;
    delete process.env.BAR;
    delete process.env.MY_VAR;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("replaces ${VAR} with the env var value", () => {
    process.env.FOO = "bar";
    expect(interpolateEnv("hello ${FOO}!")).toBe("hello bar!");
  });

  it("leaves undefined env vars as the literal ${VAR}", () => {
    delete process.env.MISSING_VAR;
    expect(interpolateEnv("value=${MISSING_VAR}")).toBe("value=${MISSING_VAR}");
  });

  it("handles multiple vars in one string", () => {
    process.env.FOO = "1";
    process.env.BAR = "2";
    expect(interpolateEnv("${FOO}-${BAR}-${FOO}")).toBe("1-2-1");
  });

  it("only matches valid var names (starts with letter/underscore, alphanumeric+underscore)", () => {
    process.env.MY_VAR = "ok";
    process.env._MY_VAR = "also";
    // Valid names (including a leading underscore) are replaced.
    expect(interpolateEnv("${MY_VAR} ${_MY_VAR}")).toBe("ok also");
    // Invalid names (starting with a digit or containing invalid chars) are
    // left untouched because the regex doesn't match them.
    expect(interpolateEnv("${1BAD} ${BAD-NAME}")).toBe("${1BAD} ${BAD-NAME}");
  });

  it("does not replace $VAR without braces", () => {
    process.env.FOO = "bar";
    expect(interpolateEnv("$FOO and ${FOO}")).toBe("$FOO and bar");
  });

  it("handles empty string", () => {
    expect(interpolateEnv("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  const envKeys = ["SHIM_PORT", "SHIM_HOST", "SHIM_LOG_DIR", "SHIM_FAILOVER", "SHIM_CONFIG", "MY_API_KEY"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns DEFAULT_CONFIG when the config file doesn't exist", () => {
    const cfg = loadConfig("/nonexistent/path/to/config.json");
    expect(cfg.port).toBe(DEFAULT_CONFIG.port);
    expect(cfg.host).toBe(DEFAULT_CONFIG.host);
    expect(cfg.providers.priority).toEqual(DEFAULT_CONFIG.providers.priority);
  });

  it("loads and parses a valid config file", () => {
    const data: ShimConfig = {
      port: 9000,
      host: "0.0.0.0",
      logDir: "/var/log/shim",
      failover: false,
      requestTimeoutMs: 60000,
      routingStrategy: "round-robin",
      sessionAffinity: { enabled: true, ttlMs: 5000 },
      providers: validProviders(),
      hostConfig: validHostConfig(),
    };
    const file = writeTempConfig(data);
    try {
      const cfg = loadConfig(file);
      expect(cfg.port).toBe(9000);
      expect(cfg.host).toBe("0.0.0.0");
      expect(cfg.logDir).toBe("/var/log/shim");
      expect(cfg.failover).toBe(false);
      expect(cfg.routingStrategy).toBe("round-robin");
      expect(cfg.sessionAffinity.enabled).toBe(true);
      expect(cfg.sessionAffinity.ttlMs).toBe(5000);
    } finally {
      cleanupTemp(file);
    }
  });

  it("interpolates env vars in the loaded config", () => {
    process.env.MY_API_KEY = "interpolated-key";
    const data = {
      port: 8788,
      host: "127.0.0.1",
      sessionAffinity: validSessionAffinity(),
      providers: {
        priority: ["opencode-go"],
        configs: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            apiKey: "${MY_API_KEY}",
            defaultModel: "ox-alpha-free",
            models: {},
          },
        },
      },
      hostConfig: validHostConfig(),
    };
    const file = writeTempConfig(data);
    try {
      const cfg = loadConfig(file);
      expect(cfg.providers.configs["opencode-go"].apiKey).toBe("interpolated-key");
    } finally {
      cleanupTemp(file);
    }
  });

  it("SHIM_PORT overrides port", () => {
    process.env.SHIM_PORT = "9999";
    const file = writeTempConfig({
      port: 8000,
      host: "127.0.0.1",
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    try {
      const cfg = loadConfig(file);
      expect(cfg.port).toBe(9999);
    } finally {
      cleanupTemp(file);
    }
  });

  it("SHIM_HOST overrides host", () => {
    process.env.SHIM_HOST = "0.0.0.0";
    const file = writeTempConfig({
      port: 8788,
      host: "127.0.0.1",
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    try {
      const cfg = loadConfig(file);
      expect(cfg.host).toBe("0.0.0.0");
    } finally {
      cleanupTemp(file);
    }
  });

  it("SHIM_LOG_DIR overrides logDir", () => {
    process.env.SHIM_LOG_DIR = "/from/env";
    const file = writeTempConfig({
      port: 8788,
      host: "127.0.0.1",
      logDir: "/from/file",
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    try {
      const cfg = loadConfig(file);
      expect(cfg.logDir).toBe("/from/env");
    } finally {
      cleanupTemp(file);
    }
  });

  it('SHIM_FAILOVER="0" sets failover to false', () => {
    process.env.SHIM_FAILOVER = "0";
    const file = writeTempConfig({
      port: 8788,
      host: "127.0.0.1",
      failover: true,
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    try {
      const cfg = loadConfig(file);
      expect(cfg.failover).toBe(false);
    } finally {
      cleanupTemp(file);
    }
  });

  it('SHIM_FAILOVER="1" sets failover to true', () => {
    process.env.SHIM_FAILOVER = "1";
    const file = writeTempConfig({
      port: 8788,
      host: "127.0.0.1",
      failover: false,
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    try {
      const cfg = loadConfig(file);
      expect(cfg.failover).toBe(true);
    } finally {
      cleanupTemp(file);
    }
  });

  it("env overrides also apply to DEFAULT_CONFIG when file is missing", () => {
    process.env.SHIM_PORT = "7777";
    process.env.SHIM_HOST = "1.2.3.4";
    process.env.SHIM_LOG_DIR = "/logs";
    process.env.SHIM_FAILOVER = "0";
    const cfg = loadConfig("/nonexistent/config.json");
    expect(cfg.port).toBe(7777);
    expect(cfg.host).toBe("1.2.3.4");
    expect(cfg.logDir).toBe("/logs");
    expect(cfg.failover).toBe(false);
  });

  it("throws on invalid config (fails zod validation)", () => {
    // port is a string, not a number -> zod rejects.
    const file = writeTempConfig({
      port: "not-a-number",
      host: "127.0.0.1",
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    try {
      expect(() => loadConfig(file)).toThrow();
    } finally {
      cleanupTemp(file);
    }
  });

  it("uses SHIM_CONFIG env var when no explicit path is given", () => {
    const file = writeTempConfig({
      port: 5555,
      host: "127.0.0.1",
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    process.env.SHIM_CONFIG = file;
    try {
      const cfg = loadConfig();
      expect(cfg.port).toBe(5555);
    } finally {
      cleanupTemp(file);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG", () => {
  it("has port 8788", () => {
    expect(DEFAULT_CONFIG.port).toBe(8788);
  });

  it("has host 127.0.0.1", () => {
    expect(DEFAULT_CONFIG.host).toBe("127.0.0.1");
  });

  it("has failover true", () => {
    expect(DEFAULT_CONFIG.failover).toBe(true);
  });

  it("has logDir empty string", () => {
    expect(DEFAULT_CONFIG.logDir).toBe("");
  });

  it("has requestTimeoutMs 30000", () => {
    expect(DEFAULT_CONFIG.requestTimeoutMs).toBe(30000);
  });

  it('has routingStrategy "priority"', () => {
    expect(DEFAULT_CONFIG.routingStrategy).toBe("priority");
  });

  it("has sessionAffinity.enabled false", () => {
    expect(DEFAULT_CONFIG.sessionAffinity.enabled).toBe(false);
  });

  it("has the expected provider priority order", () => {
    expect(DEFAULT_CONFIG.providers.priority).toEqual(["opencode-go", "opencode-zen", "local"]);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("shimConfigSchema / parseConfig", () => {
  it("valid config with all fields passes", () => {
    const raw = {
      port: 9000,
      host: "0.0.0.0",
      logDir: "/logs",
      failover: false,
      requestTimeoutMs: 60000,
      routingStrategy: "round-robin",
      sessionAffinity: { enabled: true, ttlMs: 5000 },
      providers: validProviders(),
      hostConfig: validHostConfig(),
    };
    const cfg = parseConfig(raw);
    expect(cfg.port).toBe(9000);
    expect(cfg.routingStrategy).toBe("round-robin");
  });

  it("config missing optional fields gets defaults (port, host, failover, etc.)", () => {
    const raw = {
      // sessionAffinity intentionally omitted except for the empty object so
      // that `enabled` falls back to its schema default (false).
      sessionAffinity: {},
      providers: validProviders(),
      hostConfig: validHostConfig(),
    };
    const cfg = parseConfig(raw);
    expect(cfg.port).toBe(8788);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.logDir).toBe("");
    expect(cfg.failover).toBe(true);
    expect(cfg.requestTimeoutMs).toBe(30000);
    expect(cfg.routingStrategy).toBe("priority");
    expect(cfg.sessionAffinity.enabled).toBe(false);
  });

  it("config with invalid port (non-number) fails", () => {
    const raw = {
      port: "8000",
      sessionAffinity: validSessionAffinity(),
      providers: validProviders(),
      hostConfig: validHostConfig(),
    };
    expect(() => parseConfig(raw)).toThrow();
  });

  it("config with invalid baseUrl (not a URL) fails", () => {
    const raw = {
      sessionAffinity: validSessionAffinity(),
      providers: {
        priority: ["bad"],
        configs: {
          bad: {
            baseUrl: "not-a-url",
            apiKey: "k",
            defaultModel: "m",
            models: {},
          },
        },
      },
      hostConfig: validHostConfig(),
    };
    expect(() => parseConfig(raw)).toThrow();
  });

  it("config with keys array validates correctly", () => {
    const raw = {
      sessionAffinity: validSessionAffinity(),
      providers: {
        priority: ["opencode-go"],
        configs: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            apiKey: "k1",
            defaultModel: "m",
            models: {},
            keys: [
              { value: "k1", weight: 2 },
              { value: "k2", enabled: false, models: { a: "b" } },
            ],
          },
        },
      },
      hostConfig: validHostConfig(),
    };
    const cfg = parseConfig(raw);
    expect(cfg.providers.configs["opencode-go"].keys).toHaveLength(2);
    expect(cfg.providers.configs["opencode-go"].keys?.[0].weight).toBe(2);
  });

  it("config with network config validates correctly", () => {
    const raw = {
      sessionAffinity: validSessionAffinity(),
      providers: {
        priority: ["opencode-go"],
        configs: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            apiKey: "k",
            defaultModel: "m",
            models: {},
            network: {
              requestTimeoutMs: 10000,
              maxRetries: 3,
              retryBackoffInitialMs: 200,
              retryBackoffMaxMs: 2000,
              streamIdleTimeoutMs: 60000,
              rateLimitCooldownMs: 5000,
              serverErrorCooldownMs: 15000,
              failureThreshold: 5,
            },
          },
        },
      },
      hostConfig: validHostConfig(),
    };
    const cfg = parseConfig(raw);
    expect(cfg.providers.configs["opencode-go"].network?.maxRetries).toBe(3);
    expect(cfg.providers.configs["opencode-go"].network?.failureThreshold).toBe(5);
  });

  it("config with routingStrategy validates the enum", () => {
    const strategies = ["priority", "round-robin", "weighted-round-robin", "fill-first"] as const;
    for (const s of strategies) {
      const cfg = parseConfig({
        routingStrategy: s,
        sessionAffinity: validSessionAffinity(),
        providers: validProviders(),
        hostConfig: validHostConfig(),
      });
      expect(cfg.routingStrategy).toBe(s);
    }
  });

  it("config with an invalid routingStrategy fails", () => {
    expect(() =>
      parseConfig({
        routingStrategy: "bogus",
        sessionAffinity: validSessionAffinity(),
        providers: validProviders(),
        hostConfig: validHostConfig(),
      }),
    ).toThrow();
  });

  it("config with sessionAffinity validates correctly", () => {
    const cfg = parseConfig({
      sessionAffinity: { enabled: true, ttlMs: 10000 },
      providers: validProviders(),
      hostConfig: validHostConfig(),
    });
    expect(cfg.sessionAffinity.enabled).toBe(true);
    expect(cfg.sessionAffinity.ttlMs).toBe(10000);
  });

  it("config missing required providers field fails", () => {
    expect(() => parseConfig({ sessionAffinity: validSessionAffinity(), hostConfig: validHostConfig() })).toThrow();
  });

  it("config with empty priority array is valid", () => {
    const cfg = parseConfig({
      sessionAffinity: validSessionAffinity(),
      providers: { priority: [], configs: {} },
      hostConfig: validHostConfig(),
    });
    expect(cfg.providers.priority).toEqual([]);
  });

  it("shimConfigSchema is the exported zod object schema", () => {
    expect(typeof shimConfigSchema.parse).toBe("function");
    expect(
      shimConfigSchema.parse({
        sessionAffinity: validSessionAffinity(),
        providers: validProviders(),
        hostConfig: validHostConfig(),
      }).port,
    ).toBe(8788);
  });
});

// ---------------------------------------------------------------------------
// providerConfigSchema
// ---------------------------------------------------------------------------

describe("providerConfigSchema", () => {
  it("validates a well-formed provider config", () => {
    const parsed = providerConfigSchema.parse({
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      defaultModel: "m",
      models: { a: "b" },
    });
    expect(parsed.baseUrl).toBe("https://example.com/v1");
  });

  it("rejects a provider config missing defaultModel", () => {
    expect(() =>
      providerConfigSchema.parse({
        baseUrl: "https://example.com/v1",
        apiKey: "k",
        models: {},
      }),
    ).toThrow();
  });

  it("rejects a provider config with a non-URL baseUrl", () => {
    expect(() =>
      providerConfigSchema.parse({
        baseUrl: "nope",
        apiKey: "k",
        defaultModel: "m",
        models: {},
      }),
    ).toThrow();
  });
});
