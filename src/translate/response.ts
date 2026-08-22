/**
 * Factory functions for building Connect InferenceStreamResponse frames.
 *
 * Each function returns a single discriminated frame matching one of the
 * variants of {@link InferenceStreamResponse}. These are used by the
 * streaming layer to translate OpenAI SSE chunks back into Connect frames.
 */

import type { InferenceStreamResponse, OpenAISSEChunk } from "../types.js";

/**
 * Build a `responseInfo` frame carrying the response id and model name.
 *
 * @param id     The response id (typically the OpenAI completion id).
 * @param model  The model name that served the request.
 */
export function makeResponseInfoFrame(
  id: string,
  model: string,
): InferenceStreamResponse {
  return {
    responseInfo: {
      id,
      model,
      createdAt: String(Date.now()),
      messages: [],
    },
  };
}

/**
 * Build a `textPart` frame carrying a text delta.
 *
 * @param text     The text delta (may be empty).
 * @param isFinal  True when this is the final text part of the stream.
 */
export function makeTextFrame(
  text: string,
  isFinal: boolean,
): InferenceStreamResponse {
  return {
    textPart: {
      text: text || "",
      isFinal: !!isFinal,
    },
  };
}

/**
 * Build a `toolCallPart` frame carrying a tool call delta.
 *
 * @param toolCallId  The tool call id.
 * @param toolName    The tool/function name.
 * @param args        The accumulated JSON arguments string (may be partial).
 * @param isComplete  True when the tool call is fully received.
 */
export function makeToolCallFrame(
  toolCallId: string,
  toolName: string,
  args: string,
  isComplete: boolean,
): InferenceStreamResponse {
  return {
    toolCallPart: {
      toolCallId,
      toolName,
      args: args || "",
      isComplete: !!isComplete,
    },
  };
}

/**
 * Coerce a raw token count into a safe non-negative finite number.
 *
 * `NaN`, `Infinity`, `-Infinity`, `undefined`, and negative values all
 * collapse to `0`; any other finite, non-negative value is returned as-is.
 * This is stricter than a plain `value || 0`, which lets negatives and
 * `Infinity` leak through (token counts can never be negative or infinite).
 */
function safeTokenCount(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Build a `usage` frame carrying token usage counts.
 *
 * @param promptTokens     The number of prompt tokens consumed.
 * @param completionTokens The number of completion tokens consumed.
 * @param totalTokens      Total tokens (prompt + completion), if reported.
 * @param reasoningTokens  Reasoning tokens (chain-of-thought), if reported.
 * @param cachedTokens     Cached prompt tokens, if reported.
 */
export function makeUsageFrame(
  promptTokens: number,
  completionTokens: number,
  totalTokens?: number,
  reasoningTokens?: number,
  cachedTokens?: number,
): InferenceStreamResponse {
  const usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  } = {
    promptTokens: safeTokenCount(promptTokens),
    completionTokens: safeTokenCount(completionTokens),
  };
  // Only include extended fields when the provider actually reported them,
  // so the frame stays compact for providers that don't send token details.
  if (totalTokens != null && Number.isFinite(totalTokens)) {
    usage.totalTokens = safeTokenCount(totalTokens);
  }
  if (reasoningTokens != null && Number.isFinite(reasoningTokens)) {
    usage.reasoningTokens = safeTokenCount(reasoningTokens);
  }
  if (cachedTokens != null && Number.isFinite(cachedTokens)) {
    usage.cachedTokens = safeTokenCount(cachedTokens);
  }
  return { usage };
}

/**
 * Normalized usage object extracted from an OpenAI SSE chunk.
 */
export interface ExtractedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

function firstPositiveNumber(...values: (number | undefined)[]): number {
  for (const value of values) {
    if (typeof value === "number" && value > 0) return value;
  }
  return 0;
}

/**
 * Extract a normalized usage object from an OpenAI SSE chunk's `usage` block.
 *
 * Checks all the field variants providers use (camelCase aliases, top-level
 * `cached_tokens`, DeepSeek `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`,
 * OpenRouter `prompt_tokens_details.cache_write_tokens`) and returns a single
 * object with `promptTokens`, `completionTokens`, `totalTokens`,
 * `reasoningTokens`, `cachedTokens`, and `cacheWriteTokens`. Returns `null`
 * when the chunk carries no usage block.
 */
export function extractUsage(chunk: OpenAISSEChunk): ExtractedUsage | null {
  const usage = chunk.usage;
  if (!usage) return null;
  const promptTokens =
    usage.prompt_tokens ?? usage.promptTokens ?? 0;
  const completionTokens =
    usage.completion_tokens ?? usage.completionTokens ?? 0;
  const reportedTotal =
    usage.total_tokens ?? usage.totalTokens;
  const cachedTokens = firstPositiveNumber(
    usage.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
  );
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const cacheWriteOpenRouter = usage.prompt_tokens_details?.cache_write_tokens;
  const cacheWriteDeepSeek = usage.prompt_cache_miss_tokens;
  const hasDeepSeekCacheHitAndMiss =
    usage.prompt_cache_hit_tokens !== undefined &&
    usage.prompt_cache_miss_tokens !== undefined;
  const cacheWriteTokens =
    cacheWriteOpenRouter ?? cacheWriteDeepSeek ?? 0;
  const isDeepSeekUsage =
    hasDeepSeekCacheHitAndMiss &&
    cacheWriteOpenRouter === undefined &&
    (cacheWriteDeepSeek ?? 0) > 0;
  const cacheWrite = isDeepSeekUsage ? 0 : cacheWriteTokens;
  const totalTokens =
    typeof reportedTotal === "number"
      ? reportedTotal
      : Math.max(0, promptTokens - cachedTokens - cacheWrite) +
        completionTokens +
        cachedTokens +
        cacheWrite;
  return {
    promptTokens: safeTokenCount(promptTokens),
    completionTokens: safeTokenCount(completionTokens),
    totalTokens: safeTokenCount(totalTokens),
    reasoningTokens: safeTokenCount(reasoningTokens),
    cachedTokens: safeTokenCount(cachedTokens),
    cacheWriteTokens: safeTokenCount(cacheWrite),
  };
}

/**
 * Build an `error` frame carrying an error message.
 *
 * @param message  The human-readable error message.
 */
export function makeErrorFrame(message: string): InferenceStreamResponse {
  return {
    error: {
      message: message || "inference error",
      code: "",
      errorType: "INFERENCE_STREAM_ERROR_TYPE_UNKNOWN",
    },
  };
}
