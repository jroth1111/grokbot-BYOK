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
 *
 * Before loading the config file, a `.env` file is sourced from the project
 * root (if present) so the shim works standalone — not just via the
 * `start-shim` launcher. Already-set env vars win (caller's env takes
 * precedence over `.env`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ShimConfig } from "./types.js";
import { parseConfig, DEFAULT_CONFIG_PATH } from "./config/schema.js";
import { sourceEnvFile } from "./utils/env.js";

/** Built-in default configuration used when no config file is present. */
export const DEFAULT_CONFIG: ShimConfig = {
  port: 8788,
  host: "127.0.0.1",
  logDir: "",
  failover: true,
  requestTimeoutMs: 30000,
  routingStrategy: "priority",
  sessionAffinity: { enabled: false },
  visionFallbackModel: "",
  providers: {
    priority: ["opencode-go", "opencode-zen", "local"],
    configs: {
      "opencode-go": {
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "${OPENCODE_API_KEY}",
        defaultModel: "ox-alpha-free",
        models: {},
      },
      "opencode-zen": {
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: "${OPENCODE_API_KEY}",
        defaultModel: "x-preview-f-free",
        models: {},
      },
      local: {
        baseUrl: "http://127.0.0.1:3003/v1",
        apiKey: "${LOCAL_API_KEY}",
        defaultModel: "glm-5.2",
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

/** Return `value` unless it is an empty string, in which case return `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/** Structurally clone a plain-JSON config value (no functions/dates expected). */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
 * After loading, operational env vars (SHIM_PORT, SHIM_HOST, SHIM_LOG_DIR,
 * SHIM_FAILOVER) override the config file. All other configuration —
 * providers, models, routing — is config-file-only via `${VAR}` interpolation.
 */
export function loadConfig(configPath?: string): ShimConfig {
  // Source .env before resolving config — the config file uses ${VAR}
  // interpolation for secrets, so env vars must be populated first.
  sourceEnvFile();

  const resolved =
    nonEmpty(configPath) ??
    nonEmpty(process.env.SHIM_CONFIG) ??
    path.resolve(process.cwd(), DEFAULT_CONFIG_PATH);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    // File missing or unreadable: boot with a *copy* of the built-in defaults
    // so callers cannot mutate the module-level DEFAULT_CONFIG object.
    return applyEnvOverrides(deepClone(DEFAULT_CONFIG));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // A present-but-malformed config is a real error: surface it with the
    // resolved path rather than silently falling back to defaults (which would
    // mask the misconfiguration) or leaking a raw, context-free SyntaxError.
    throw new Error(`Failed to parse config file at ${resolved}: ${(e as Error).message}`);
  }
  const interpolated = interpolateDeep(parsed);
  return applyEnvOverrides(parseConfig(interpolated));
}

/**
 * Apply operational env-var overrides on top of the loaded config.
 *
 * Only truly operational settings (port, host, log dir, failover toggle)
 * are overridable via env — everything else lives in the config file with
 * `${VAR}` interpolation for secrets. This avoids two configuration sources.
 */

/** String values (case-insensitive, trimmed) treated as boolean `false`. */
const FALSY_ENV_VALUES = new Set(["0", "false", "no", "off", ""]);

function applyEnvOverrides(config: ShimConfig): ShimConfig {
  const overrides: Partial<ShimConfig> = {};
  if (process.env.SHIM_PORT) {
    const port = parseInt(process.env.SHIM_PORT, 10);
    if (!Number.isFinite(port)) {
      throw new Error(
        `SHIM_PORT is not a valid integer: ${JSON.stringify(process.env.SHIM_PORT)}`,
      );
    }
    overrides.port = port;
  }
  if (process.env.SHIM_HOST) overrides.host = process.env.SHIM_HOST;
  if (process.env.SHIM_LOG_DIR !== undefined) overrides.logDir = process.env.SHIM_LOG_DIR;
  if (process.env.SHIM_FAILOVER !== undefined) {
    overrides.failover = !FALSY_ENV_VALUES.has(process.env.SHIM_FAILOVER.trim().toLowerCase());
  }
  if (process.env.VISION_FALLBACK_MODEL) {
    overrides.visionFallbackModel = process.env.VISION_FALLBACK_MODEL;
  }
  return { ...config, ...overrides };
}
