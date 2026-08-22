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

/** Validation schema for a single API key entry. */
const keyInfoSchema = z.object({
  value: z.string(),
  weight: z.number().positive().optional(),
  models: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

/** Validation schema for per-provider network config. */
const networkConfigSchema = z.object({
  requestTimeoutMs: z.number().positive().optional(),
  maxRetries: z.number().nonnegative().optional(),
  retryBackoffInitialMs: z.number().positive().optional(),
  retryBackoffMaxMs: z.number().positive().optional(),
  streamIdleTimeoutMs: z.number().positive().optional(),
  rateLimitCooldownMs: z.number().nonnegative().optional(),
  serverErrorCooldownMs: z.number().nonnegative().optional(),
  failureThreshold: z.number().positive().optional(),
});

/** Validation schema for per-provider compat flag overrides. */
const compatOverridesSchema = z.object({
  supportsReasoningEffort: z.boolean().optional(),
  thinkingFormat: z
    .enum(["openai", "zai", "qwen", "qwen-chat-template", "openrouter"])
    .optional(),
  reasoningContentField: z.string().optional(),
  requiresAssistantContentForToolCalls: z.boolean().optional(),
  supportsMultipleSystemMessages: z.boolean().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  streamIdleTimeoutMs: z.number().positive().optional(),
  stripDeepseekSpecialTokens: z.boolean().optional(),
  streamMarkupHealingPattern: z
    .enum(["kimi", "dsml", "thinking"])
    .optional(),
  supportsImages: z.boolean().optional(),
});

/** Validation schema for a single provider entry. */
export const providerConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string(),
  keys: z.array(keyInfoSchema).optional(),
  defaultModel: z.string(),
  models: z.record(z.string(), z.string()),
  network: networkConfigSchema.optional(),
  compat: compatOverridesSchema.optional(),
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

/** Validation schema for session affinity. */
const sessionAffinitySchema = z.object({
  enabled: z.boolean().default(false),
  ttlMs: z.number().positive().optional(),
});

/** Validation schema for the full shim configuration. */
export const shimConfigSchema = z.object({
  port: z.number().default(8788),
  host: z.string().default("127.0.0.1"),
  logDir: z.string().default(""),
  failover: z.boolean().default(true),
  requestTimeoutMs: z.number().positive().default(30000),
  routingStrategy: z.enum(["priority", "round-robin", "weighted-round-robin", "fill-first"]).default("priority"),
  sessionAffinity: sessionAffinitySchema,
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
