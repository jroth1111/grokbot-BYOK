/**
 * Shared types used across the shim's modules.
 *
 * These define the contracts between the protocol layer, translation layer,
 * provider layer, and server. Each module imports from here rather than
 * reaching into another module's internals.
 */

// ---------------------------------------------------------------------------
// Connect protocol types
// ---------------------------------------------------------------------------

/** A single Connect streaming envelope (5-byte header + payload). */
export interface ConnectEnvelope {
  flags: number;
  data: Buffer;
}

/** Parsed Connect request body (InferenceStreamRequest in proto3 JSON). */
export interface InferenceStreamRequest {
  messages?: InferenceMessage[];
  tools?: InferenceTool[];
  requestedModel?: { modelId?: string; model_id?: string; maxMode?: boolean };
  modelConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  invocationId?: string;
  model_id?: string;
  modelId?: string;
  /** Cursor conversation id (proto3 JSON camelCase). */
  chatId?: string;
  /** Whether to use server-side prompt caching. */
  usePromptCache?: boolean;
  /** Cache key for prompt caching. */
  promptCacheKey?: string;
  /** Workspace file paths included as context. */
  workspacePaths?: string[];
  /** When true, image content is stripped from the request. */
  excludeImages?: boolean;
  /** Cursor prompt-summarizer configuration (opaque message, passed through). */
  promptSummarizerConfig?: unknown;
  /** Cursor prompt template (opaque message, passed through). */
  promptTmpl?: unknown;
  /** Cursor prompt inputs (opaque message, passed through). */
  promptInputs?: unknown;
  /** Cursor request type enum (number or suffixed enum string). */
  requestType?: number | string;
  /** Cursor request checkpoint (opaque message, passed through). */
  requestCheckpoint?: unknown;
}

/** A single message in the inference request. */
export interface InferenceMessage {
  role?: number | string;
  text?: string;
  parts?: { parts: InferenceContentPart[] };
  toolContent?: { parts: InferenceToolResultPart[] };
  toolCalls?: InferenceToolCall[];
}

export interface InferenceContentPart {
  text?: { text?: string };
  image?: { url?: string; data?: string; mimeType?: string };
  file?: { name?: string };
}

export interface InferenceToolResultPart {
  toolCallId?: string;
  result?: unknown;
}

export interface InferenceToolCall {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

export interface InferenceTool {
  name?: string;
  description?: string;
  parameters?: unknown;
}

// ---------------------------------------------------------------------------
// OpenAI types
// ---------------------------------------------------------------------------

/** OpenAI chat/completions request (streaming). */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: true;
  stream_options?: { include_usage: true };
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A single SSE chunk from the OpenAI streaming response. */
export interface OpenAISSEChunk {
  id?: string;
  model?: string;
  /** Always "chat.completion.chunk" for streaming responses. */
  object?: string;
  /** Unix timestamp (seconds) of chunk creation. */
  created?: number;
  /** Provider fingerprint of the model that served the request. */
  system_fingerprint?: string;
  choices?: {
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Total tokens (prompt + completion); always present on the usage chunk. */
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    /** CamelCase alias for total_tokens (some OpenAI-compatible providers). */
    totalTokens?: number;
    /** Breakdown of prompt tokens (e.g. cached tokens from prompt caching). */
    prompt_tokens_details?: { cached_tokens?: number };
    /** Breakdown of completion tokens (e.g. reasoning tokens for o1-style models). */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

// ---------------------------------------------------------------------------
// Connect response frame types
// ---------------------------------------------------------------------------

export type InferenceStreamResponse =
  | { responseInfo: { id: string; model: string; createdAt: string; messages: unknown[] } }
  | { textPart: { text: string; isFinal: boolean } }
  | { toolCallPart: { toolCallId: string; toolName: string; args: string; isComplete: boolean } }
  | {
      usage: {
        promptTokens: number;
        completionTokens: number;
        /** Total tokens (prompt + completion), if reported by the provider. */
        totalTokens?: number;
        /** Reasoning tokens consumed by chain-of-thought models, if reported. */
        reasoningTokens?: number;
        /** Cached prompt tokens (prompt caching), if reported. */
        cachedTokens?: number;
      };
    }
  | { error: { message: string; code: string; errorType: string } };

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

/** Routing strategy for selecting among providers that can handle a model. */
export type RoutingStrategy = "priority" | "round-robin" | "weighted-round-robin" | "fill-first";

/** A single API key with optional model aliases and weight. */
export interface KeyInfo {
  /** The API key value. */
  value: string;
  /** Weight for weighted-round-robin (default 1). */
  weight?: number;
  /** Per-key model aliases that override the provider-level map. */
  models?: Record<string, string>;
  /** Whether this key is enabled (default true). */
  enabled?: boolean;
}

/** Per-provider network / retry configuration. */
export interface NetworkConfig {
  /** Request timeout in ms (overrides global requestTimeoutMs). */
  requestTimeoutMs?: number;
  /** Max retries within this provider before failing over (default 0). */
  maxRetries?: number;
  /** Initial backoff in ms for exponential retry (default 500). */
  retryBackoffInitialMs?: number;
  /** Max backoff cap in ms (default 5000). */
  retryBackoffMaxMs?: number;
  /** Stream idle timeout in ms — close if no data for this long (default 120000). */
  streamIdleTimeoutMs?: number;
  /** Cooldown in ms for 429 rate-limit errors (default 10000). */
  rateLimitCooldownMs?: number;
  /** Cooldown in ms for 5xx server errors (default 30000). */
  serverErrorCooldownMs?: number;
  /** Failure threshold before circuit opens (default 3). */
  failureThreshold?: number;
}

/** A configured LLM provider adapter. */
export interface Provider {
  readonly name: string;
  readonly baseUrl: string;
  /** All API keys for this provider (may be one or many). */
  readonly keys: KeyInfo[];
  /** The first key's value (convenience for single-key providers). */
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly network: NetworkConfig;
  /** Alias -> canonical model id map (provider-level, merged with per-key maps). */
  readonly models: Map<string, string>;
  /** Returns true if this provider has an alias for the given model id. */
  canHandle(normalizedModelId: string): boolean;
  /** Resolves a model id to the canonical id to send to this provider's API. */
  resolveModel(normalizedModelId: string, rawModelId: string): string;
  /** Select the next API key (for key rotation). */
  selectKey(): KeyInfo;
  /** Mark a key as failed (for rotation). */
  markKeyFailed(key: KeyInfo): void;
  /** Clear failed-key state (called at the start of each request). */
  resetKeyFailures(): void;
}

/** Configuration for a single provider. */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** Additional API keys for this provider (optional, for key rotation). */
  keys?: KeyInfo[];
  defaultModel: string;
  models: Record<string, string>;
  /** Per-provider network/retry config. */
  network?: NetworkConfig;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface SessionAffinityConfig {
  /** Enable session-sticky routing (default false). */
  enabled: boolean;
  /** TTL for session-to-provider bindings in ms (default 3600000 = 1h). */
  ttlMs?: number;
}

export interface ShimConfig {
  port: number;
  host: string;
  logDir: string;
  failover: boolean;
  requestTimeoutMs: number;
  /** Routing strategy for selecting among providers (default "priority"). */
  routingStrategy: RoutingStrategy;
  /** Session affinity / sticky routing config. */
  sessionAffinity: SessionAffinityConfig;
  providers: {
    priority: string[];
    configs: Record<string, ProviderConfig>;
  };
  hostConfig: {
    sandHostDir: string;
    defaultModel: string;
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
