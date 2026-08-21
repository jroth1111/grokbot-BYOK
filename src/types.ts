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
    promptTokens?: number;
    completionTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Connect response frame types
// ---------------------------------------------------------------------------

export type InferenceStreamResponse =
  | { responseInfo: { id: string; model: string; createdAt: string; messages: unknown[] } }
  | { textPart: { text: string; isFinal: boolean } }
  | { toolCallPart: { toolCallId: string; toolName: string; args: string; isComplete: boolean } }
  | { usage: { promptTokens: number; completionTokens: number } }
  | { error: { message: string; code: string; errorType: string } };

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

/** A configured LLM provider adapter. */
export interface Provider {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  /** Alias -> canonical model id map (this provider only, no shared aliases). */
  readonly models: Map<string, string>;
  /** Returns true if this provider has an alias for the given model id. */
  canHandle(normalizedModelId: string): boolean;
  /** Resolves a model id to the canonical id to send to this provider's API. */
  resolveModel(normalizedModelId: string, rawModelId: string): string;
}

/** Configuration for a single provider. */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  models: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ShimConfig {
  port: number;
  host: string;
  logDir: string;
  failover: boolean;
  requestTimeoutMs: number;
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
