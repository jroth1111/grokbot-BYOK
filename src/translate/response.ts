/**
 * Factory functions for building Connect InferenceStreamResponse frames.
 *
 * Each function returns a single discriminated frame matching one of the
 * variants of {@link InferenceStreamResponse}. These are used by the
 * streaming layer to translate OpenAI SSE chunks back into Connect frames.
 */

import type { InferenceStreamResponse } from "../types.js";

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
 */
export function makeUsageFrame(
  promptTokens: number,
  completionTokens: number,
): InferenceStreamResponse {
  return {
    usage: {
      promptTokens: safeTokenCount(promptTokens),
      completionTokens: safeTokenCount(completionTokens),
    },
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
