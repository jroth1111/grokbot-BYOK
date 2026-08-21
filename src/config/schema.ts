/**
 * Zod validation schema for the shim configuration.
 *
 * The schema mirrors the `ShimConfig` / `ProviderConfig` interfaces declared
 * in `src/types.ts`. Raw config (parsed from JSON) is run through
 * `parseConfig` which both validates and applies the documented defaults.
 */
import { z } from "zod";
import type { ShimConfig } from "../types.js";

/** Default path to the config file, relative to the process cwd. */
export const DEFAULT_CONFIG_PATH = "config/config.json";

/** Validation schema for a single provider entry. */
export const providerConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string(),
  defaultModel: z.string(),
  models: z.record(z.string(), z.string()),
});

/** Validation schema for the `providers` block. */
const providersSchema = z.object({
  priority: z.array(z.string()),
  configs: z.record(z.string(), providerConfigSchema),
});

/** Validation schema for the `hostConfig` block. */
const hostConfigSchema = z.object({
  sandHostDir: z.string(),
  defaultModel: z.string(),
});

/** Validation schema for the full shim configuration. */
export const shimConfigSchema = z.object({
  port: z.number().default(8788),
  host: z.string().default("127.0.0.1"),
  logDir: z.string().default(""),
  failover: z.boolean().default(true),
  requestTimeoutMs: z.number().default(30000),
  providers: providersSchema,
  hostConfig: hostConfigSchema,
});

/**
 * Validate an unknown raw config object and return a fully-formed `ShimConfig`.
 *
 * Throws a `ZodError` (via `schema.parse`) when the input does not conform.
 */
export function parseConfig(raw: unknown): ShimConfig {
  return shimConfigSchema.parse(raw) as ShimConfig;
}
