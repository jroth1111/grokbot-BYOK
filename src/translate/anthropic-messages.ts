/**
 * Translation between the OpenAI Chat Completions dialect (the shim's
 * internal lingua franca) and the Anthropic Messages API wire format used
 * by Claude-subscription OAuth accounts (api.anthropic.com/v1/messages).
 *
 * Request direction:  OpenAIChatRequest      → Anthropic Messages body
 * Response direction: Anthropic SSE events   → OpenAI chat.completion.chunk
 *                                            SSE stream (then [DONE])
 *
 * The response adapter synthesizes standard OpenAI SSE chunks, so every
 * downstream consumer — tool-call accumulation, think-tag filtering, usage
 * extraction, stream timeouts, failover, performance tracking — works on
 * Claude responses unchanged.
 */

import type { OpenAIChatRequest, OpenAISSEChunk } from "../types.js";
import { SseParser } from "../protocol/sse.js";

// ---------------------------------------------------------------------------
// Anthropic Messages request types (subset the shim produces)
// ---------------------------------------------------------------------------

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
    };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequestBody {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature?: number;
  stream: true;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "none" };
  thinking?: { type: "enabled"; budget_tokens: number };
}

/** Default output budget — Anthropic requires max_tokens on every request. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

/**
 * Split a `-thinking-<N>` suffix off a model alias (e.g.
 * `claude-sonnet-4-5-thinking-10000` → sonnet + a 10k thinking budget).
 * Returns null when the model carries no suffix.
 */
export function parseThinkingSuffix(
  model: string,
): { model: string; budgetTokens: number } | null {
  const match = model.match(/^(.*?)-thinking-(\d+)$/);
  if (!match) return null;
  const budget = parseInt(match[2], 10);
  if (!Number.isFinite(budget) || budget < 1024) return null;
  return { model: match[1], budgetTokens: budget };
}

function dataUrlParts(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function openaiContentToBlocks(
  content: string | unknown[] | null | undefined,
  role: "user" | "assistant",
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string; image_url?: { url?: string } };
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      blocks.push({ type: "text", text: p.text });
    } else if (p.type === "image_url" && typeof p.image_url?.url === "string") {
      const parsed = dataUrlParts(p.image_url.url);
      if (parsed) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
        });
      }
      // Remote image URLs are not supported by the Messages API — dropped.
    }
  }
  return blocks;
}

/**
 * Convert an OpenAI Chat Completions request body into an Anthropic
 * Messages request body (streaming).
 *
 * Mapping notes:
 * - system messages concatenate into the top-level `system` field
 * - assistant tool_calls history becomes `tool_use` blocks; tool results
 *   become their own user turn carrying a `tool_result` block
 * - `max_tokens` is REQUIRED by Anthropic — defaults apply
 * - a `-thinking-<N>` model-alias suffix enables extended thinking with
 *   that budget (and lifts max_tokens above the budget)
 */
export function translateChatToAnthropic(
  body: OpenAIChatRequest,
): AnthropicRequestBody {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];

  const thinkingSpec = parseThinkingSuffix(body.model);
  const model = thinkingSpec?.model ?? body.model;

  for (const msg of body.messages ?? []) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p) => (p?.type === "text" ? String(p.text ?? "") : ""))
                .join("")
            : "";
      if (text.length > 0) system.push(text);
      continue;
    }
    if (msg.role === "user") {
      const blocks = openaiContentToBlocks(msg.content, "user");
      if (blocks.length > 0) messages.push({ role: "user", content: blocks });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = openaiContentToBlocks(msg.content, "assistant");
      for (const tc of msg.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function?.arguments || "{}");
          if (parsed !== null && typeof parsed === "object") {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = { _raw: tc.function?.arguments ?? "" };
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name ?? "",
          input,
        });
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role === "tool") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content === null || msg.content === undefined
            ? ""
            : JSON.stringify(msg.content);
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: msg.tool_call_id ?? "", content: text },
        ],
      });
      continue;
    }
  }

  const requestedMax =
    body.max_tokens ??
    (body as { max_completion_tokens?: number }).max_completion_tokens;
  let maxTokens =
    typeof requestedMax === "number" && requestedMax > 0
      ? requestedMax
      : ANTHROPIC_DEFAULT_MAX_TOKENS;
  if (thinkingSpec) {
    // Thinking budgets must stay strictly below max_tokens.
    maxTokens = Math.max(maxTokens, thinkingSpec.budgetTokens + 1024);
  }

  const out: AnthropicRequestBody = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
  };
  if (system.length > 0) out.system = system.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = body.temperature;

  if (body.tools && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      name: tool.function?.name ?? "",
      description: tool.function?.description ?? "",
      input_schema: tool.function?.parameters ?? { type: "object", properties: {} },
    }));
    out.tool_choice = { type: "auto" };
  }

  if (thinkingSpec) {
    out.thinking = { type: "enabled", budget_tokens: thinkingSpec.budgetTokens };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Response translation: Anthropic SSE → OpenAI chat.completion.chunk SSE
// ---------------------------------------------------------------------------

/** Anthropic stop_reason → OpenAI finish_reason. */
function mapStopReason(reason: string | undefined, anyToolUse: boolean): string {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "stop_sequence" || reason === "end_turn" || reason === undefined) {
    return anyToolUse ? "tool_calls" : "stop";
  }
  return "stop";
}

/**
 * Stateful translator from Anthropic SSE event payloads to OpenAI SSE chunk
 * payloads. Feed each completed SSE `data:` payload; receive zero or more
 * OpenAI chunk JSON strings plus a final "[DONE]" sentinel.
 *
 * Pure logic, no I/O — trivially unit-testable.
 */
export class AnthropicStreamTranslator {
  private readonly model: string;
  private chunkCounter = 0;
  private finished = false;
  private failed = false;
  private anyToolUse = false;
  /** Anthropic content-block index → our tool-call ordinal. */
  private toolBlockOrdinals = new Map<number, number>();
  private toolCount = 0;
  private inputTokens = 0;
  private failureMessage: string | undefined;

  constructor(model: string) {
    this.model = model;
  }

  /** Non-[DONE] terminal failure. Undefined when healthy. */
  getFailure(): string | undefined {
    return this.failureMessage;
  }

  /** True once the terminal event was seen. */
  get isFinished(): boolean {
    return this.finished;
  }

  /** True when the terminal event was a failure. */
  get didFail(): boolean {
    return this.failed;
  }

  feed(data: string): string[] {
    if (this.finished) return [];
    if (data === "[DONE]") {
      // Defensive: some gateways append their own sentinel.
      this.finished = true;
      return ["[DONE]"];
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = typeof event.type === "string" ? event.type : "";
    const out: string[] = [];

    switch (type) {
      case "message_start": {
        const message = event.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (typeof usage?.input_tokens === "number") {
          this.inputTokens = usage.input_tokens;
        }
        break;
      }
      case "content_block_start": {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const blockIndex = typeof event.index === "number" ? event.index : 0;
          const ordinal = this.toolCount++;
          this.toolBlockOrdinals.set(blockIndex, ordinal);
          this.anyToolUse = true;
          out.push(
            this.chunk({
              tool_calls: [
                {
                  index: ordinal,
                  id: typeof block.id === "string" ? block.id : `call_${ordinal}`,
                  type: "function",
                  function: {
                    name: typeof block.name === "string" ? block.name : "",
                    arguments: "",
                  },
                },
              ],
            }),
          );
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!delta) break;
        const deltaType = typeof delta.type === "string" ? delta.type : "";
        if (deltaType === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          out.push(this.chunk({ content: delta.text }));
        } else if (
          deltaType === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking.length > 0
        ) {
          out.push(this.chunk({ reasoning_content: delta.thinking }));
        } else if (
          deltaType === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          delta.partial_json.length > 0
        ) {
          const blockIndex = typeof event.index === "number" ? event.index : 0;
          const ordinal = this.toolBlockOrdinals.get(blockIndex) ?? 0;
          out.push(
            this.chunk({
              tool_calls: [{ index: ordinal, function: { arguments: delta.partial_json } }],
            }),
          );
        }
        // signature_delta and future delta types are ignored.
        break;
      }
      case "message_delta": {
        const delta = event.delta as Record<string, unknown> | undefined;
        const usage = event.usage as Record<string, unknown> | undefined;
        if (typeof usage?.output_tokens === "number") {
          out.push(this.finishChunk(delta?.stop_reason, usage));
          this.finished = true;
          out.push("[DONE]");
        }
        break;
      }
      case "message_stop": {
        if (!this.finished) {
          out.push(this.finishChunk(undefined, undefined));
          this.finished = true;
          out.push("[DONE]");
        }
        break;
      }
      case "error": {
        const error = event.error as Record<string, unknown> | undefined;
        this.failureMessage =
          typeof error?.message === "string" ? error.message : `anthropic stream error`;
        this.finished = true;
        this.failed = true;
        break;
      }
      default:
        // ping / content_block_stop / message prelude noise — ignored.
        break;
    }
    return out;
  }

  private chunk(delta: Record<string, unknown>): string {
    const chunk: OpenAISSEChunk = {
      id: `chatcmpl-claude-${Date.now().toString(36)}-${this.chunkCounter++}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return JSON.stringify(chunk);
  }

  private finishChunk(
    stopReason: unknown,
    usage: Record<string, unknown> | undefined,
  ): string {
    const reason = mapStopReason(
      typeof stopReason === "string" ? stopReason : undefined,
      this.anyToolUse,
    );
    const outputTokens =
      typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined;
    const totalTokens =
      typeof usage?.output_tokens === "number" && this.inputTokens > 0
        ? this.inputTokens + (usage.output_tokens as number)
        : undefined;
    const chunk: OpenAISSEChunk = {
      id: `chatcmpl-claude-${Date.now().toString(36)}-${this.chunkCounter++}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
      ...(outputTokens !== undefined
        ? {
            usage: {
              ...(this.inputTokens > 0 ? { prompt_tokens: this.inputTokens } : {}),
              ...(outputTokens !== undefined ? { completion_tokens: outputTokens } : {}),
              ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
            },
          }
        : {}),
    };
    return JSON.stringify(chunk);
  }
}

// ---------------------------------------------------------------------------
// Stream adapter
// ---------------------------------------------------------------------------

/**
 * Transform an HTTP body streaming Anthropic Messages SSE events into one
 * streaming standard OpenAI chat.completion.chunk SSE (incl. [DONE]).
 */
export function adaptAnthropicStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const translator = new AnthropicStreamTranslator(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const emit = (outputs: string[]): Uint8Array[] =>
    outputs.map((payload) =>
      encoder.encode(
        payload === "[DONE]" ? "data: [DONE]\n\n" : `data: ${payload}\n\n`,
      ),
    );

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        parser.feed(decoder.decode(chunk, { stream: true }));
        for (const data of parser.drain()) {
          for (const bytes of emit(translator.feed(data))) {
            controller.enqueue(bytes);
          }
        }
      },
      flush(controller) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          parser.feed(tail);
        }
        for (const data of parser.drain()) {
          for (const bytes of emit(translator.feed(data))) {
            controller.enqueue(bytes);
          }
        }
      },
    }),
  );
}
