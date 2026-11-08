/**
 * Unit tests for the Antigravity v1internal Gemini translation layer
 * (src/translate/gemini-v1internal.ts).
 */
import { describe, it, expect } from "vitest";
import {
  translateChatToGemini,
  GeminiStreamTranslator,
  adaptGeminiStream,
} from "../src/translate/gemini-v1internal.js";
import { ToolCallAccumulator } from "../src/translate/tools.js";
import { SseParser } from "../src/protocol/sse.js";
import type { OpenAIChatRequest, OpenAISSEChunk } from "../src/types.js";

function chatBody(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: "gemini-3-pro-preview",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    ...overrides,
  };
}

describe("translateChatToGemini", () => {
  it("maps system → systemInstruction and messages → contents", () => {
    const body = translateChatToGemini(
      chatBody({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
    );
    expect(body.model).toBe("gemini-3-pro-preview");
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(body.request.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
    // The v1internal endpoint rejects top-level stream/metadata fields.
    expect("stream" in body).toBe(false);
    expect("metadata" in body).toBe(false);
    expect("metadata" in body.request).toBe(false);
  });

  it("maps tools + generationConfig; project rides as a query param, never in the body", () => {
    const body = translateChatToGemini(
      chatBody({
        max_tokens: 256,
        temperature: 0.2,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "w",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    );
    expect("metadata" in body).toBe(false);
    expect("metadata" in body.request).toBe(false);
    expect("stream" in body).toBe(false);
    expect(body.request.tools?.[0].functionDeclarations?.[0]).toMatchObject({
      name: "get_weather",
    });
    expect(body.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(body.request.generationConfig).toEqual({
      maxOutputTokens: 256,
      temperature: 0.2,
    });
  });

  it("maps tool history to functionCall/functionResponse parts with name resolution", () => {
    const body = translateChatToGemini(
      chatBody({
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: '{"temp":72}' },
        ],
      }),
    );
    expect(body.request.contents).toEqual([
      { role: "user", parts: [{ text: "weather?" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" }, id: "call_1" } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "get_weather", response: { temp: 72 }, id: "call_1" } },
        ],
      },
    ]);
  });
});

function frame(response: Record<string, unknown>): string {
  return JSON.stringify({ response });
}

describe("GeminiStreamTranslator", () => {
  it("streams text parts and finishes with usage", () => {
    const translator = new GeminiStreamTranslator("gemini-3-pro-preview");
    const outputs = [
      ...translator.feed(frame({ candidates: [{ content: { role: "model", parts: [{ text: "He" }] } }] })),
      ...translator.feed(frame({ candidates: [{ content: { role: "model", parts: [{ text: "y" }] } }] })),
      ...translator.feed(
        frame({
          candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 },
        }),
      ),
    ];
    const contents = outputs
      .filter((o) => o !== "[DONE]")
      .map((o) => JSON.parse(o).choices[0].delta.content ?? "");
    expect(contents.join("")).toBe("Hey");
    const finish = JSON.parse(outputs[outputs.length - 2]);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11,
    });
    expect(outputs[outputs.length - 1]).toBe("[DONE]");
  });

  it("maps thought parts to reasoning_content and thoughtsTokenCount to reasoning_tokens", () => {
    const translator = new GeminiStreamTranslator("gemini-3-pro-preview");
    const mid = translator.feed(
      frame({
        candidates: [{ content: { role: "model", parts: [{ text: "ponder", thought: true }] } }],
      }),
    );
    expect(JSON.parse(mid[0]).choices[0].delta.reasoning_content).toBe("ponder");
    const end = translator.feed(
      frame({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 5,
          totalTokenCount: 8,
        },
      }),
    );
    expect(JSON.parse(end[0]).usage.completion_tokens_details).toEqual({
      reasoning_tokens: 5,
    });
  });

  it("emits functionCall parts as rebuildable tool_calls with tool_calls finish", () => {
    const translator = new GeminiStreamTranslator("gemini-3-pro-preview");
    const outputs = [
      ...translator.feed(
        frame({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" }, id: "fc_1" } }],
              },
            },
          ],
        }),
      ),
      ...translator.feed(frame({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] })),
    ];
    const acc = new ToolCallAccumulator();
    for (const payload of outputs) {
      if (payload !== "[DONE]") acc.feed(JSON.parse(payload) as OpenAISSEChunk);
    }
    expect(acc.callList[0]).toEqual({
      id: "fc_1",
      name: "get_weather",
      args: '{"city":"NYC"}',
    });
    expect(outputs[outputs.length - 1]).toBe("[DONE]");
    expect(JSON.parse(outputs[outputs.length - 2]).choices[0].finish_reason).toBe("tool_calls");
  });

  it("synthesizes a terminal chunk on clean EOF without finishReason (native behavior)", () => {
    const translator = new GeminiStreamTranslator("gemini-3-pro-preview");
    translator.feed(frame({ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] }));
    const flushed = translator.flushEof();
    expect(flushed).toHaveLength(2);
    expect(JSON.parse(flushed[0]).choices[0].finish_reason).toBe("stop");
    expect(flushed[1]).toBe("[DONE]");
    // Second flush is a no-op.
    expect(translator.flushEof()).toEqual([]);
  });

  it("maps SAFETY to content_filter and MAX_TOKENS to length", () => {
    const t1 = new GeminiStreamTranslator("m");
    const o1 = t1.feed(frame({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }));
    expect(JSON.parse(o1[0]).choices[0].finish_reason).toBe("length");
    const t2 = new GeminiStreamTranslator("m");
    const o2 = t2.feed(frame({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }));
    expect(JSON.parse(o2[0]).choices[0].finish_reason).toBe("content_filter");
  });
});

describe("adaptGeminiStream", () => {
  it("converts wrapped Antigravity frames into OpenAI SSE bytes", async () => {
    const sse = [
      `data: ${frame({ candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] })}\n\n`,
      `data: ${frame({
        candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
      })}\n\n`,
    ].join("");
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const reader = adaptGeminiStream(upstream, "gemini-3-pro-preview").getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    const parser = new SseParser();
    parser.feed(chunks.join(""));
    const payloads = parser.drain();
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as OpenAISSEChunk);
    expect(parsed.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")).toBe("Hi");
  });
});
