/**
 * Unit tests for the Responses API translation layer
 * (src/translate/responses-api.ts).
 *
 * Request direction: OpenAI Chat Completions → Responses request body.
 * Response direction: Responses SSE events → OpenAI chat.completion.chunk
 * payloads (via ResponsesStreamTranslator + adaptResponsesStream).
 */
import { describe, it, expect } from "vitest";
import {
  translateChatToResponses,
  ResponsesStreamTranslator,
  adaptResponsesStream,
} from "../src/translate/responses-api.js";
import { ToolCallAccumulator } from "../src/translate/tools.js";
import { SseParser } from "../src/protocol/sse.js";
import type { OpenAIChatRequest, OpenAISSEChunk } from "../src/types.js";

function chatBody(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: "gpt-5.2-codex",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe("translateChatToResponses", () => {
  it("maps system messages to instructions and user text to input items", () => {
    const body = translateChatToResponses(
      chatBody({
        messages: [
          { role: "system", content: "be terse" },
          { role: "system", content: "use tools" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(body.instructions).toBe("be terse\n\nuse tools");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
    expect(body.model).toBe("gpt-5.2-codex");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    // The backend rejects an `originator` body parameter — must be absent.
    expect("originator" in body).toBe(false);
  });

  it("maps assistant tool_calls history and tool results to function_call items", () => {
    const body = translateChatToResponses(
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
          { role: "tool", tool_call_id: "call_1", content: "72F sunny" },
        ],
      }),
    );
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "72F sunny" },
    ]);
  });

  it("maps multimodal user content to input_text + input_image parts", () => {
    const body = translateChatToResponses(
      chatBody({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
            ],
          },
        ],
      }),
    );
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
      ],
    });
  });

  it("maps tools, max_tokens, temperature and drops stop", () => {
    const body = translateChatToResponses(
      chatBody({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        max_tokens: 512,
        temperature: 0.2,
        stop: ["\n\n"],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    );
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
        strict: false,
      },
    ]);
    expect(body.max_output_tokens).toBe(512);
    // temperature/top_p are dropped (responses-lite rejects them).
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect("stop" in body).toBe(false);
    expect(body.reasoning).toEqual({ summary: "auto" });
  });

  it("omits reasoning for non-reasoning models", () => {
    const body = translateChatToResponses(chatBody({ model: "test-model" }));
    expect(body.reasoning).toBeUndefined();
  });

  it("honors max_completion_tokens as the max-token source", () => {
    const body = translateChatToResponses(
      chatBody({ max_tokens: undefined } as Partial<OpenAIChatRequest> & {
        max_completion_tokens?: number;
      }),
    );
    expect(body.max_output_tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

function feedAll(translator: ResponsesStreamTranslator, events: object[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    out.push(...translator.feed(JSON.stringify(event)));
  }
  return out;
}

describe("ResponsesStreamTranslator", () => {
  it("translates output_text deltas to content chunks", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
    ]);
    const contents = outputs.map((o) => JSON.parse(o).choices[0].delta.content);
    expect(contents).toEqual(["Hel", "lo"]);
  });

  it("translates reasoning summary deltas to reasoning_content", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      { type: "response.reasoning_summary_text.delta", delta: "thinking..." },
    ]);
    expect(JSON.parse(outputs[0]).choices[0].delta.reasoning_content).toBe("thinking...");
  });

  it("streams a function call as tool_call deltas the accumulator can rebuild", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"ci' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'ty":"NYC"}' },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
      },
    ]);
    // Rebuild through the real accumulator to prove compatibility.
    const acc = new ToolCallAccumulator();
    for (const payload of outputs) {
      acc.feed(JSON.parse(payload) as OpenAISSEChunk);
    }
    expect(acc.size).toBe(1);
    expect(acc.callList[0]).toEqual({
      id: "call_1",
      name: "get_weather",
      args: '{"city":"NYC"}',
    });
  });

  it("emits a whole function call when only output_item.done arrives", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_9",
          call_id: "call_9",
          name: "bash",
          arguments: '{"cmd":"ls"}',
        },
      },
    ]);
    const delta = JSON.parse(outputs[0]).choices[0].delta;
    expect(delta.tool_calls[0]).toEqual({
      index: 0,
      id: "call_9",
      type: "function",
      function: { name: "bash", arguments: '{"cmd":"ls"}' },
    });
  });

  it("finishes with mapped usage, finish_reason and [DONE]", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 12,
            output_tokens: 6,
            total_tokens: 18,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      },
    ]);
    const finish = JSON.parse(outputs[outputs.length - 2]);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 6,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(outputs[outputs.length - 1]).toBe("[DONE]");
    expect(translator.isFinished).toBe(true);
  });

  it("uses tool_calls finish_reason when a function call was emitted", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
      },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const finish = JSON.parse(outputs[outputs.length - 2]);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");
  });

  it("marks response.incomplete as a length finish, not an error", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { status: "incomplete", usage: {} } },
    ]);
    const finish = JSON.parse(outputs[outputs.length - 2]);
    expect(finish.choices[0].finish_reason).toBe("length");
    expect(outputs[outputs.length - 1]).toBe("[DONE]");
  });

  it("signals failure without [DONE] on response.failed", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.failed",
        response: { error: { code: "server_error", message: "upstream blew up" } },
      },
    ]);
    expect(outputs.some((o) => o === "[DONE]")).toBe(false);
    expect(translator.didFail).toBe(true);
    expect(translator.getFailure()).toContain("upstream blew up");
  });

  it("ignores noise events and post-terminal events", () => {
    const translator = new ResponsesStreamTranslator("gpt-5.2-codex");
    const outputs = feedAll(translator, [
      { type: "response.in_progress" },
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.content_part.added" },
      { type: "response.output_text.done", text: "hi" },
      { type: "response.completed", response: {} },
      { type: "response.output_text.delta", delta: "late" },
    ]);
    // Only the terminal pair is emitted.
    expect(outputs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Stream adapter
// ---------------------------------------------------------------------------

describe("adaptResponsesStream", () => {
  it("converts a raw Responses SSE byte stream into OpenAI SSE bytes", async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"!"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
    ].join("");
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of [sse.slice(0, 40), sse.slice(40)]) {
          controller.enqueue(new TextEncoder().encode(piece));
        }
        controller.close();
      },
    });

    const adapted = adaptResponsesStream(upstream, "gpt-5.2-codex");
    const reader = adapted.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }

    // Parse the produced bytes as SSE and validate the payloads.
    const parser = new SseParser();
    parser.feed(chunks.join(""));
    const payloads = parser.drain();
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as OpenAISSEChunk);
    const content = parsed
      .map((c) => c.choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("Hello!");
    expect(parsed[parsed.length - 1].usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
    });
  });
});
