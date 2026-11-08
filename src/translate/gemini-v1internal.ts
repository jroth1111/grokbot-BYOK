/**
 * Translation between the OpenAI Chat Completions dialect (the shim's
 * internal lingua franca) and the Antigravity v1internal Gemini wire
 * format (daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent).
 *
 * Request direction:  OpenAIChatRequest → { model, metadata?, request: {
 *                      contents, systemInstruction, tools, toolConfig,
 *                      generationConfig } }
 * Response direction: Antigravity SSE frames ({"response":{candidates…
 *                      }}) → OpenAI chat.completion.chunk SSE + [DONE]
 *
 * The response adapter synthesizes standard OpenAI SSE chunks, so every
 * downstream consumer works on Antigravity responses unchanged. A clean
 * EOF without a finishReason is treated as a NORMAL end (native Antigravity
 * tool-call streams end that way): a terminal chunk + [DONE] are
 * synthesized when content was already emitted.
 */

import type { OpenAIChatRequest, OpenAISSEChunk } from "../types.js";
import { SseParser } from "../protocol/sse.js";

// ---------------------------------------------------------------------------
// Gemini v1internal request types (subset the shim produces)
// ---------------------------------------------------------------------------

export interface GeminiPart {
  text?: string;
  /** true on Gemini thought-summary parts → reasoning_content downstream. */
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiRequestBody {
  model: string;
  request: {
    contents: GeminiContent[];
    systemInstruction?: { parts: GeminiPart[] };
    tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    toolConfig?: { functionCallingConfig: { mode: string } };
    generationConfig?: Record<string, unknown>;
  };
}

function textOf(content: string | unknown[] | null | undefined): string {
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
 * Convert an OpenAI Chat Completions request body into an Antigravity
 * v1internal generateContent request body. NOTE: the account's project id
 * rides as a `?project=` QUERY parameter (added by the fetch layer), not in
 * the body — the endpoint rejects any metadata field in either position.
 */
export function translateChatToGemini(body: OpenAIChatRequest): GeminiRequestBody {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  /** tool_call_id → function name (for functionResponse naming). */
  const callNames = new Map<string, string>();

  for (const msg of body.messages ?? []) {
    if (msg.role === "system") {
      const text = textOf(msg.content);
      if (text.length > 0) system.push(text);
      continue;
    }
    if (msg.role === "user") {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === "string") {
        if (msg.content.length > 0) parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== "object") continue;
          const p = part as { type?: string; text?: string };
          if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
            parts.push({ text: p.text });
          }
          // Images: Antigravity accepts inlineData in principle; the shim
          // strips images for non-vision models upstream, and the free
          // Gemini catalog here is text-only — dropped for v1.
        }
      }
      if (parts.length > 0) contents.push({ role: "user", parts });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = textOf(msg.content);
      if (text.length > 0) parts.push({ text });
      for (const tc of msg.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function?.arguments || "{}");
          if (parsed !== null && typeof parsed === "object") {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = { _raw: tc.function?.arguments ?? "" };
        }
        parts.push({ functionCall: { name: tc.function?.name ?? "", args, id: tc.id } });
        if (tc.id) callNames.set(tc.id, tc.function?.name ?? "");
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    if (msg.role === "tool") {
      const name = callNames.get(msg.tool_call_id ?? "") ?? "";
      let response: Record<string, unknown> = {};
      if (typeof msg.content === "string") {
        try {
          const parsed = JSON.parse(msg.content);
          response =
            parsed !== null && typeof parsed === "object"
              ? (parsed as Record<string, unknown>)
              : { result: msg.content };
        } catch {
          response = { result: msg.content };
        }
      } else if (msg.content !== null && msg.content !== undefined) {
        response = { result: msg.content };
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response,
              id: msg.tool_call_id ?? undefined,
            },
          },
        ],
      });
      continue;
    }
  }

  const request: GeminiRequestBody["request"] = { contents };

  if (system.length > 0) {
    request.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
  }

  if (body.tools && body.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: body.tools.map((tool) => ({
          name: tool.function?.name ?? "",
          description: tool.function?.description ?? "",
          parameters: tool.function?.parameters ?? {
            type: "object",
            properties: {},
          },
        })),
      },
    ];
    request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const maxTokens =
    body.max_tokens ??
    (body as { max_completion_tokens?: number }).max_completion_tokens;
  const generationConfig: Record<string, unknown> = {};
  if (typeof maxTokens === "number" && maxTokens > 0) {
    generationConfig.maxOutputTokens = maxTokens;
  }
  if (typeof body.temperature === "number") {
    generationConfig.temperature = body.temperature;
  }
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }

  return {
    model: body.model,
    request,
  };
}

// ---------------------------------------------------------------------------
// Response translation: Antigravity SSE → OpenAI chat.completion.chunk SSE
// ---------------------------------------------------------------------------

/** Gemini finishReason → OpenAI finish_reason. */
function mapFinishReason(reason: string | undefined, anyFunctionCall: boolean): string {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "BLOCKLIST") {
    return "content_filter";
  }
  // STOP / unspecified / clean-EOF: tool calls win when any were emitted.
  return anyFunctionCall ? "tool_calls" : "stop";
}

/**
 * Stateful translator from Antigravity SSE frame payloads to OpenAI SSE
 * chunk payloads. Each frame is a JSON object whose `response` field holds
 * the Gemini chunk (candidates/usageMetadata).
 */
export class GeminiStreamTranslator {
  private readonly model: string;
  private chunkCounter = 0;
  private finished = false;
  private failed = false;
  private anyFunctionCall = false;
  private toolCount = 0;
  private emittedContent = false;
  private failureMessage: string | undefined;

  constructor(model: string) {
    this.model = model;
  }

  getFailure(): string | undefined {
    return this.failureMessage;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get didFail(): boolean {
    return this.failed;
  }

  feed(data: string): string[] {
    if (this.finished) return [];
    if (data === "[DONE]") {
      this.finished = true;
      return ["[DONE]"];
    }

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [];
    }
    // Frames are wrapped: {"response": {...gemini chunk...}}; accept bare
    // Gemini chunks too (defensive).
    const chunk =
      frame.response !== null && typeof frame.response === "object"
        ? (frame.response as Record<string, unknown>)
        : frame;

    const out: string[] = [];
    const candidates = chunk.candidates;
    if (Array.isArray(candidates)) {
      for (const rawCandidate of candidates) {
        const candidate = rawCandidate as Record<string, unknown>;
        const content = candidate.content as Record<string, unknown> | undefined;
        const parts = content?.parts;
        if (Array.isArray(parts)) {
          for (const rawPart of parts) {
            const part = rawPart as Record<string, unknown>;
            if (typeof part.text === "string" && part.text.length > 0) {
              if (part.thought === true) {
                out.push(this.chunk({ reasoning_content: part.text }));
              } else {
                this.emittedContent = true;
                out.push(this.chunk({ content: part.text }));
              }
            }
            const fc = part.functionCall as Record<string, unknown> | undefined;
            if (fc && typeof fc.name === "string") {
              this.anyFunctionCall = true;
              this.emittedContent = true;
              const ordinal = this.toolCount++;
              let args: Record<string, unknown> = {};
              if (fc.args !== null && typeof fc.args === "object") {
                args = fc.args as Record<string, unknown>;
              }
              out.push(
                this.chunk({
                  tool_calls: [
                    {
                      index: ordinal,
                      id: typeof fc.id === "string" && fc.id ? fc.id : `call_${ordinal}`,
                      type: "function",
                      function: {
                        name: fc.name,
                        arguments: JSON.stringify(args),
                      },
                    },
                  ],
                }),
              );
            }
          }
        }
        if (typeof candidate.finishReason === "string" && !this.finished) {
          const usage = chunk.usageMetadata as Record<string, unknown> | undefined;
          out.push(this.finishChunk(candidate.finishReason, usage));
          this.finished = true;
          out.push("[DONE]");
        }
      }
    }

    // Usage-only split frame (no candidates): finish when finishReason was
    // already seen, else remember usage for a later terminal frame.
    if (!this.finished) {
      const usage = chunk.usageMetadata as Record<string, unknown> | undefined;
      if (usage && !Array.isArray(candidates)) {
        // Pure usage frame after a finishReason-bearing frame — emit DONE
        // if the finish chunk already went out... it hasn't (finished guard
        // above), so hold the usage for the clean-EOF synthesis instead.
        this.pendingUsage = usage;
      }
    }

    if (chunk.error !== null && typeof chunk.error === "object") {
      const error = chunk.error as Record<string, unknown>;
      this.failureMessage =
        typeof error.message === "string" ? error.message : "antigravity stream error";
      this.finished = true;
      this.failed = true;
    }
    return out;
  }

  private pendingUsage: Record<string, unknown> | undefined;

  /**
   * Clean EOF without a finishReason is a NORMAL end for Antigravity
   * (observed on tool-call streams): synthesize the terminal chunk.
   * Returns [] when nothing was emitted (downstream empty-completion
   * handling applies) or the stream already finished.
   */
  flushEof(): string[] {
    if (this.finished || !this.emittedContent) return [];
    this.finished = true;
    return [this.finishChunk(undefined, this.pendingUsage), "[DONE]"];
  }

  private chunk(delta: Record<string, unknown>): string {
    const chunk: OpenAISSEChunk = {
      id: `chatcmpl-ag-${Date.now().toString(36)}-${this.chunkCounter++}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return JSON.stringify(chunk);
  }

  private finishChunk(
    finishReason: string | undefined,
    usage: Record<string, unknown> | undefined,
  ): string {
    const reason = mapFinishReason(finishReason, this.anyFunctionCall);
    const prompt =
      typeof usage?.promptTokenCount === "number" ? usage.promptTokenCount : undefined;
    const completion =
      typeof usage?.candidatesTokenCount === "number"
        ? usage.candidatesTokenCount
        : undefined;
    const total =
      typeof usage?.totalTokenCount === "number" ? usage.totalTokenCount : undefined;
    const reasoning =
      typeof (usage as Record<string, unknown> | undefined)?.thoughtsTokenCount ===
      "number"
        ? ((usage as Record<string, unknown>).thoughtsTokenCount as number)
        : undefined;
    const chunk: OpenAISSEChunk = {
      id: `chatcmpl-ag-${Date.now().toString(36)}-${this.chunkCounter++}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
      ...(prompt !== undefined || completion !== undefined
        ? {
            usage: {
              ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
              ...(completion !== undefined ? { completion_tokens: completion } : {}),
              ...(total !== undefined ? { total_tokens: total } : {}),
              ...(reasoning !== undefined
                ? { completion_tokens_details: { reasoning_tokens: reasoning } }
                : {}),
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
 * Transform an HTTP body streaming Antigravity v1internal SSE frames into
 * one streaming standard OpenAI chat.completion.chunk SSE (incl. [DONE]).
 */
export function adaptGeminiStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const translator = new GeminiStreamTranslator(model);
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
        // Clean EOF without finishReason — normal Antigravity end.
        for (const bytes of emit(translator.flushEof())) {
          controller.enqueue(bytes);
        }
      },
    }),
  );
}
