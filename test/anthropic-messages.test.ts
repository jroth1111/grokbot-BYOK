/**
 * Unit tests for the Anthropic Messages translation layer
 * (src/translate/anthropic-messages.ts).
 */
import { describe, it, expect } from "vitest";
import {
  translateChatToAnthropic,
  AnthropicStreamTranslator,
  adaptAnthropicStream,
  parseThinkingSuffix,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
} from "../src/translate/anthropic-messages.js";
import { ToolCallAccumulator } from "../src/translate/tools.js";
import { SseParser } from "../src/protocol/sse.js";
import type { OpenAIChatRequest, OpenAISSEChunk } from "../src/types.js";

function chatBody(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    ...overrides,
  };
}

describe("parseThinkingSuffix", () => {
  it("splits -thinking-N aliases", () => {
    expect(parseThinkingSuffix("claude-sonnet-4-5-thinking-10000")).toEqual({
      model: "claude-sonnet-4-5",
      budgetTokens: 10000,
    });
    expect(parseThinkingSuffix("claude-sonnet-4-5")).toBeNull();
    expect(parseThinkingSuffix("claude-x-thinking-1")).toBeNull(); // below floor
  });
});

describe("translateChatToAnthropic", () => {
  it("lifts system to the top level and maps user/assistant text", () => {
    const body = translateChatToAnthropic(
      chatBody({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello!" },
          { role: "user", content: "bye" },
        ],
      }),
    );
    expect(body.system).toBe("be terse");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello!" }] },
      { role: "user", content: [{ type: "text", text: "bye" }] },
    ]);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
  });

  it("maps tool_calls history to tool_use and tool results to tool_result turns", () => {
    const body = translateChatToAnthropic(
      chatBody({
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "toolu_1", content: "72F" },
        ],
      }),
    );
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
            input: { city: "NYC" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "72F" },
        ],
      },
    ]);
  });

  it("maps tools, temperature, and the thinking suffix", () => {
    const body = translateChatToAnthropic(
      chatBody({
        model: "claude-opus-4-5-thinking-32000",
        max_tokens: 100,
        temperature: 0.3,
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
    expect(body.model).toBe("claude-opus-4-5");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
    // max_tokens lifted above the thinking budget
    expect(body.max_tokens).toBeGreaterThanOrEqual(32000 + 1024);
    expect(body.tools?.[0].name).toBe("get_weather");
    expect(body.tools?.[0].input_schema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.temperature).toBe(0.3);
  });
});

function feedAll(translator: AnthropicStreamTranslator, events: object[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    out.push(...translator.feed(JSON.stringify(event)));
  }
  return out;
}

describe("AnthropicStreamTranslator", () => {
  it("streams text deltas and finishes with usage + [DONE]", () => {
    const translator = new AnthropicStreamTranslator("claude-sonnet-4-5");
    const outputs = feedAll(translator, [
      { type: "message_start", message: { usage: { input_tokens: 12 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "He" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]);
    const contents = outputs
      .filter((o) => o !== "[DONE]")
      .map((o) => JSON.parse(o).choices[0].delta.content ?? "");
    expect(contents.join("")).toBe("Hey");
    const finish = JSON.parse(outputs[outputs.length - 2]);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toEqual({ prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
    expect(outputs[outputs.length - 1]).toBe("[DONE]");
  });

  it("maps thinking deltas to reasoning_content", () => {
    const translator = new AnthropicStreamTranslator("claude-sonnet-4-5");
    const outputs = feedAll(translator, [
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    ]);
    expect(JSON.parse(outputs[0]).choices[0].delta.reasoning_content).toBe("hmm");
  });

  it("streams tool_use blocks into rebuildable tool_call deltas", () => {
    const translator = new AnthropicStreamTranslator("claude-sonnet-4-5");
    const outputs = feedAll(translator, [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_9", name: "get_weather" },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ci' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ty":1}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    ]);
    const acc = new ToolCallAccumulator();
    for (const payload of outputs) {
      if (payload !== "[DONE]") acc.feed(JSON.parse(payload) as OpenAISSEChunk);
    }
    expect(acc.size).toBe(1);
    expect(acc.callList[0]).toEqual({
      id: "toolu_9",
      name: "get_weather",
      args: '{"city":1}',
    });
    expect(outputs[outputs.length - 1]).toBe("[DONE]");
    const finish = JSON.parse(outputs[outputs.length - 2]);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");
  });

  it("signals failure without [DONE] on stream errors", () => {
    const translator = new AnthropicStreamTranslator("claude-sonnet-4-5");
    const outputs = feedAll(translator, [
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
    expect(outputs.some((o) => o === "[DONE]")).toBe(false);
    expect(translator.didFail).toBe(true);
    expect(translator.getFailure()).toContain("Overloaded");
  });

  it("maps max_tokens to length", () => {
    const translator = new AnthropicStreamTranslator("claude-sonnet-4-5");
    const outputs = feedAll(translator, [
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } },
    ]);
    expect(JSON.parse(outputs[0]).choices[0].finish_reason).toBe("length");
  });
});

describe("adaptAnthropicStream", () => {
  it("converts a raw Anthropic SSE byte stream into OpenAI SSE bytes", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse.slice(0, 60)));
        controller.enqueue(new TextEncoder().encode(sse.slice(60)));
        controller.close();
      },
    });

    const reader = adaptAnthropicStream(upstream, "claude-sonnet-4-5").getReader();
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
    expect(parsed[parsed.length - 1].usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 1,
      total_tokens: 4,
    });
  });
});
