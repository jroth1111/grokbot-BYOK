/**
 * Translation between the OpenAI Chat Completions dialect (the shim's
 * internal lingua franca) and the OpenAI *Responses* API wire format used
 * by the ChatGPT-backend endpoint (`chatgpt.com/backend-api/codex/responses`)
 * that "Sign in with ChatGPT" (Codex-style OAuth) accounts talk to.
 *
 * Request direction:  OpenAIChatRequest          → ResponsesRequestBody
 * Response direction: Responses SSE event stream → OpenAI chat.completion.chunk
 *                                            SSE stream (then [DONE])
 *
 * The response adapter synthesizes standard OpenAI SSE chunks, so every
 * downstream consumer — tool-call accumulation, think-tag filtering, usage
 * extraction, stream timeouts, failover, performance tracking — works on
 * ChatGPT-backend responses unchanged.
 */

import type { OpenAIChatRequest, OpenAISSEChunk } from "../types.js";
import { SseParser } from "../protocol/sse.js";

// ---------------------------------------------------------------------------
// Responses API request types (subset the shim produces/consumes)
// ---------------------------------------------------------------------------

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "developer" | "system";
      content: ResponsesContentPart[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: false;
}

export interface ResponsesRequestBody {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: { effort?: string; summary?: "auto" | "concise" | "detailed" };
  parallel_tool_calls?: boolean;
  stream: true;
  store: false;
}

/** Models that get reasoning summaries streamed back as reasoning_content. */
const REASONING_MODEL_RE = /gpt-5|codex|o1|o3|o4/i;

// ---------------------------------------------------------------------------
// Request translation: Chat Completions → Responses
// ---------------------------------------------------------------------------

function contentPartsToResponses(
  content: string | unknown[] | null | undefined,
  role: "user" | "assistant",
): ResponsesContentPart[] {
  if (typeof content === "string") {
    return [
      role === "user"
        ? { type: "input_text", text: content }
        : { type: "output_text", text: content },
    ];
  }
  if (!Array.isArray(content)) return [];
  const parts: ResponsesContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string; image_url?: { url?: string } };
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(
        role === "user"
          ? { type: "input_text", text: p.text }
          : { type: "output_text", text: p.text },
      );
    } else if (p.type === "image_url" && typeof p.image_url?.url === "string") {
      // data: URLs pass straight through; http(s) URLs are fetched by OpenAI.
      parts.push({ type: "input_image", image_url: p.image_url.url });
    }
  }
  return parts;
}

function messageText(content: string | unknown[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * Convert an OpenAI Chat Completions request body into a Responses API
 * request body (streaming, non-persisted).
 *
 * Mapping notes:
 * - system messages concatenate into `instructions`
 * - assistant tool_calls history becomes `function_call` input items
 * - tool-result messages become `function_call_output` items
 * - `max_tokens`/`max_completion_tokens` → `max_output_tokens`
 * - `stop` is dropped (Responses has no stop-sequence param)
 * - reasoning models get `reasoning.summary: "auto"` so thinking streams
 *   back as summary deltas (mapped to reasoning_content downstream)
 */
export function translateChatToResponses(
  body: OpenAIChatRequest,
): ResponsesRequestBody {
  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const msg of body.messages ?? []) {
    if (msg.role === "system") {
      const text = messageText(msg.content);
      if (text.length > 0) instructions.push(text);
      continue;
    }
    if (msg.role === "user") {
      const content = contentPartsToResponses(msg.content, "user");
      if (content.length > 0) {
        input.push({ type: "message", role: "user", content });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const content = contentPartsToResponses(msg.content, "assistant");
      if (content.length > 0) {
        input.push({ type: "message", role: "assistant", content });
      }
      for (const tc of msg.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        });
      }
      continue;
    }
    if (msg.role === "tool") {
      const output =
        typeof msg.content === "string"
          ? msg.content
          : msg.content === null || msg.content === undefined
            ? ""
            : JSON.stringify(msg.content);
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output,
      });
      continue;
    }
    // Unknown role — treat as user text (defensive).
    const text = messageText(msg.content);
    if (text.length > 0) {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      });
    }
  }

  const out: ResponsesRequestBody = {
    model: body.model,
    input,
    stream: true,
    // store:false keeps transcripts server-side-less (Codex semantics);
    // NOTE: no `originator` field — the ChatGPT backend rejects it with
    // "Unsupported parameter: originator".
    store: false,
  };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");

  if (body.tools && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: "function" as const,
      name: tool.function?.name ?? "",
      description: tool.function?.description ?? "",
      parameters: tool.function?.parameters ?? { type: "object", properties: {} },
      strict: false,
    }));
  }

  // tool_choice passthrough (not part of OpenAIChatRequest today, but the
  // host could grow it — map the OpenAI shape to the Responses shape).
  const toolChoice = (body as { tool_choice?: unknown }).tool_choice;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    out.tool_choice = toolChoice;
  } else if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as { type?: string }).type === "function"
  ) {
    const fn = (toolChoice as { function?: { name?: string } }).function;
    if (fn?.name) out.tool_choice = { type: "function", name: fn.name };
  }

  const maxTokens =
    body.max_tokens ??
    (body as { max_completion_tokens?: number }).max_completion_tokens;
  if (typeof maxTokens === "number" && maxTokens > 0) {
    out.max_output_tokens = maxTokens;
  }
  // NOTE: temperature / top_p are intentionally NOT forwarded — the
  // ChatGPT backend's responses-lite endpoint rejects them with
  // "Unsupported parameter: temperature" (only the strict Codex parameter
  // subset is accepted). Sampling controls don't apply to these models.

  if (REASONING_MODEL_RE.test(body.model)) {
    out.reasoning = { summary: "auto" };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Response translation: Responses SSE → OpenAI chat.completion.chunk SSE
// ---------------------------------------------------------------------------

interface PendingFunctionCall {
  index: number;
  callId: string;
  name: string;
  streamedArgs: boolean;
}

/**
 * Stateful translator from Responses SSE event payloads to OpenAI SSE chunk
 * payloads. Feed each completed SSE `data:` payload; receive zero or more
 * OpenAI chunk JSON strings plus a final "[DONE]" sentinel.
 *
 * Pure logic, no I/O — trivially unit-testable.
 */
export class ResponsesStreamTranslator {
  private readonly model: string;
  private chunkCounter = 0;
  private toolIndex = 0;
  private anyFunctionCall = false;
  private finished = false;
  private failed = false;
  /** item_id → in-flight function_call (streaming args). */
  private pendingCalls = new Map<string, PendingFunctionCall>();
  private failureMessage: string | undefined;

  constructor(model: string) {
    this.model = model;
  }

  /** Non-[DONE] terminal failure (response.failed / error). Undefined when healthy. */
  getFailure(): string | undefined {
    return this.failureMessage;
  }

  /** True once the terminal event was seen (completed/incomplete/failed/error). */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Feed one SSE data payload (raw string). Returns OpenAI chunk payloads to
   * emit, in order — each is either a JSON object string or "[DONE]".
   */
  feed(data: string): string[] {
    if (this.finished) return [];
    if (data === "[DONE]") {
      // Defensive: some gateways append their own sentinel. Only forward it
      // when we never saw a terminal Responses event.
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
      case "response.output_text.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta.length > 0) {
          out.push(this.chunk({ content: delta }));
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta.length > 0) {
          out.push(this.chunk({ reasoning_content: delta }));
        }
        break;
      }
      case "response.output_item.added": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const itemId = typeof item.id === "string" ? item.id : "";
          const callId =
            typeof item.call_id === "string" && item.call_id.length > 0
              ? item.call_id
              : itemId;
          const name = typeof item.name === "string" ? item.name : "";
          const index = this.toolIndex++;
          this.pendingCalls.set(itemId, {
            index,
            callId,
            name,
            streamedArgs: false,
          });
          this.anyFunctionCall = true;
          // Register id + name immediately (also counts as first content for
          // downstream TTFB tracking via the tool accumulator).
          out.push(
            this.chunk({
              tool_calls: [
                { index, id: callId, type: "function", function: { name, arguments: "" } },
              ],
            }),
          );
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const itemId = typeof event.item_id === "string" ? event.item_id : "";
        const delta = typeof event.delta === "string" ? event.delta : "";
        const pending = this.pendingCalls.get(itemId);
        if (pending && delta.length > 0) {
          pending.streamedArgs = true;
          out.push(
            this.chunk({
              tool_calls: [
                {
                  index: pending.index,
                  function: { arguments: delta },
                },
              ],
            }),
          );
        }
        break;
      }
      case "response.output_item.done": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          this.anyFunctionCall = true;
          const itemId = typeof item.id === "string" ? item.id : "";
          const callId =
            typeof item.call_id === "string" && item.call_id.length > 0
              ? item.call_id
              : itemId;
          const name = typeof item.name === "string" ? item.name : "";
          const args = typeof item.arguments === "string" ? item.arguments : "";
          const pending = this.pendingCalls.get(itemId);
          if (pending) {
            // If the args were never streamed as deltas, emit them whole now.
            if (!pending.streamedArgs && args.length > 0) {
              out.push(
                this.chunk({
                  tool_calls: [
                    { index: pending.index, function: { arguments: args } },
                  ],
                }),
              );
            }
            this.pendingCalls.delete(itemId);
          } else {
            // Never saw output_item.added — emit the complete call in one shot.
            const index = this.toolIndex++;
            out.push(
              this.chunk({
                tool_calls: [
                  {
                    index,
                    id: callId,
                    type: "function",
                    function: { name, arguments: args },
                  },
                ],
              }),
            );
          }
        }
        break;
      }
      case "response.completed": {
        const response = event.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        out.push(this.finishChunk("stop", usage));
        this.finished = true;
        out.push("[DONE]");
        break;
      }
      case "response.incomplete": {
        // Hit a limit (e.g. max_output_tokens) — a length-finish, not an error.
        const response = event.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        out.push(this.finishChunk("length", usage));
        this.finished = true;
        out.push("[DONE]");
        break;
      }
      case "response.failed":
      case "error": {
        const response = event.response as Record<string, unknown> | undefined;
        const error = (event.error ?? response?.error) as
          | Record<string, unknown>
          | undefined;
        this.failureMessage =
          typeof error?.message === "string"
            ? error.message
            : `chatgpt backend stream failed (${type})`;
        // No [DONE]: downstream sees an unfinished stream and fails over,
        // mirroring how a mid-stream provider death is handled elsewhere.
        this.finished = true;
        this.failed = true;
        break;
      }
      default:
        // response.created / in_progress / output_item.added(message) /
        // content_part.* / *.done counters — noise for our purposes.
        break;
    }
    return out;
  }

  /** True when the terminal event was a failure. */
  get didFail(): boolean {
    return this.failed;
  }

  private chunk(delta: Record<string, unknown>): string {
    const chunk: OpenAISSEChunk = {
      id: `chatcmpl-resp-${Date.now().toString(36)}-${this.chunkCounter++}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return JSON.stringify(chunk);
  }

  private finishChunk(
    finishReason: string,
    usage: Record<string, unknown> | undefined,
  ): string {
    const reason = this.anyFunctionCall && finishReason === "stop" ? "tool_calls" : finishReason;
    const inputTokens = numberOrUndef(usage?.input_tokens);
    const outputTokens = numberOrUndef(usage?.output_tokens);
    const totalTokens = numberOrUndef(usage?.total_tokens);
    const inputDetails = usage?.input_tokens_details as
      | Record<string, unknown>
      | undefined;
    const outputDetails = usage?.output_tokens_details as
      | Record<string, unknown>
      | undefined;
    const chunk: OpenAISSEChunk = {
      id: `chatcmpl-resp-${Date.now().toString(36)}-${this.chunkCounter++}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
      ...(inputTokens !== undefined || outputTokens !== undefined
        ? {
            usage: {
              ...(inputTokens !== undefined ? { prompt_tokens: inputTokens } : {}),
              ...(outputTokens !== undefined
                ? { completion_tokens: outputTokens }
                : {}),
              ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
              ...(inputDetails?.cached_tokens !== undefined
                ? {
                    prompt_tokens_details: {
                      cached_tokens: numberOrUndef(inputDetails.cached_tokens),
                    },
                  }
                : {}),
              ...(outputDetails?.reasoning_tokens !== undefined
                ? {
                    completion_tokens_details: {
                      reasoning_tokens: numberOrUndef(outputDetails.reasoning_tokens),
                    },
                  }
                : {}),
            },
          }
        : {}),
    };
    return JSON.stringify(chunk);
  }
}

function numberOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Stream adapter: wrap a Responses SSE body into an OpenAI SSE body
// ---------------------------------------------------------------------------

/**
 * Transform an HTTP body streaming Responses API SSE events into one
 * streaming standard OpenAI chat.completion.chunk SSE (incl. [DONE]).
 *
 * The output is byte-for-byte what every existing downstream consumer of
 * `fetchCompletion` expects, so no other layer needs to know about the
 * Responses dialect.
 */
export function adaptResponsesStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const translator = new ResponsesStreamTranslator(model);
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
