/**
 * Config loader for the shim.
 *
 * Reads a JSON config file from disk, interpolates `${ENV_VAR}` references
 * found in string values using `process.env`, then validates the result
 * against the zod schema exported from `./config/schema.js`.
 *
 * If the config file cannot be found, a built-in `DEFAULT_CONFIG` is returned
 * instead so the shim can boot with sane defaults (opencode-go as the primary
 * provider).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ShimConfig } from "./types.js";
import { parseConfig, DEFAULT_CONFIG_PATH } from "./config/schema.js";

/** Built-in default configuration used when no config file is present. */
export const DEFAULT_CONFIG: ShimConfig = {
  port: 8788,
  host: "127.0.0.1",
  logDir: "",
  failover: true,
  requestTimeoutMs: 30000,
  routingStrategy: "priority",
  sessionAffinity: { enabled: false },
  providers: {
    priority: ["opencode-go", "opencode-zen", "local"],
    configs: {
      "opencode-go": {
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "",
        defaultModel: "ox-alpha-free",
        models: {},
      },
      "opencode-zen": {
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: "",
        defaultModel: "x-preview-f-free",
        models: {},
      },
      local: {
        baseUrl: "http://127.0.0.1:3003/v1",
        apiKey: "",
        defaultModel: "glm-5-2",
        models: {},
      },
    },
  },
  hostConfig: {
    sandHostDir: "",
    defaultModel: "Ox Alpha Free",
  },
};

/**
 * Replace `${VAR_NAME}` patterns in `value` with the corresponding
 * `process.env.VAR_NAME`. Patterns whose env var is undefined are left
 * untouched (the literal `${VAR_NAME}` text remains).
 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const replacement = process.env[name];
    return replacement === undefined ? match : replacement;
  });
}

/**
 * Recursively walk a parsed config value, interpolating `${VAR}` references in
 * every string. Objects and arrays are traversed; non-string primitives are
 * returned unchanged.
 */
function interpolateDeep<T>(value: T): T {
  if (typeof value === "string") {
    return interpolateEnv(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(interpolateDeep) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Load and validate the shim configuration.
 *
 * Resolution order for the file path:
 *   1. The explicit `configPath` argument, if provided.
 *   2. The `SHIM_CONFIG` environment variable, if set.
 *   3. `DEFAULT_CONFIG_PATH` (`config/config.json`) relative to `process.cwd()`.
 *
 * If the resolved file does not exist (or cannot be read), `DEFAULT_CONFIG` is
 * returned. Otherwise the file is parsed as JSON, env references are
 * interpolated, and the result is validated via `parseConfig`.
 *
 * After loading, shim-level env vars (SHIM_PORT, SHIM_HOST, SHIM_LOG_DIR,
 * SHIM_FAILOVER) override the config file values for backward compatibility
 * with v1 scripts and deploy tooling.
 */
export function loadConfig(configPath?: string): ShimConfig {
  const resolved =
    configPath ??
    process.env.SHIM_CONFIG ??
    path.resolve(process.cwd(), DEFAULT_CONFIG_PATH);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    return applyEnvOverrides(DEFAULT_CONFIG);
  }

  const parsed = JSON.parse(raw) as unknown;
  const interpolated = interpolateDeep(parsed);
  return applyEnvOverrides(parseConfig(interpolated));
}

/**
 * Apply shim-level environment variable overrides on top of the loaded config.
 * This preserves backward compatibility with v1 scripts that set SHIM_PORT,
 * SHIM_HOST, etc. directly rather than editing the config file.
 */
function applyEnvOverrides(config: ShimConfig): ShimConfig {
  const overrides: Partial<ShimConfig> = {};
  if (process.env.SHIM_PORT) overrides.port = parseInt(process.env.SHIM_PORT, 10);
  if (process.env.SHIM_HOST) overrides.host = process.env.SHIM_HOST;
  if (process.env.SHIM_LOG_DIR !== undefined) overrides.logDir = process.env.SHIM_LOG_DIR;
  if (process.env.SHIM_FAILOVER !== undefined) overrides.failover = process.env.SHIM_FAILOVER !== "0";
  return { ...config, ...overrides };
}
