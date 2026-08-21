/**
 * Edge-case tests for request/response translation and tool-call accumulation.
 * These complement translate.test.ts with cases not already covered there.
 */
import { describe, it, expect } from "vitest";
import { convertRequest } from "../src/translate/request.js";
import {
  makeResponseInfoFrame,
  makeTextFrame,
  makeToolCallFrame,
  makeUsageFrame,
  makeErrorFrame,
} from "../src/translate/response.js";
import { ToolCallAccumulator } from "../src/translate/tools.js";
import type {
  InferenceStreamRequest,
  OpenAISSEChunk,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// convertRequest — edge cases
// ---------------------------------------------------------------------------

describe("convertRequest — edge cases", () => {
  it("an empty messages array yields an empty messages array in the output", () => {
    const body = convertRequest({ messages: [] });
    expect(body.messages).toEqual([]);
  });

  it("a request with no messages field yields an empty messages array", () => {
    const body = convertRequest({});
    expect(body.messages).toEqual([]);
  });

  it("a message with no text and no parts produces content ''", () => {
    const body = convertRequest({ messages: [{ role: 1 }] });
    expect(body.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("a message with both text and parts lets text take precedence", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 1,
          text: "the text",
          parts: {
            parts: [{ text: { text: "from parts" } }],
          },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("the text");
  });

  it("an assistant message with tool_calls surfaces tool_calls in the output", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 2,
          toolCalls: [
            {
              toolCallId: "call_1",
              toolName: "get_weather",
              args: { fields: { city: { stringValue: "SF" } } },
            },
          ],
        },
      ],
    };
    const body = convertRequest(req);
    const msg = body.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);
  });

  it("an assistant message with no tool_calls has no tool_calls field", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 2, text: "just text" }],
    };
    const body = convertRequest(req);
    expect(body.messages[0].tool_calls).toBeUndefined();
  });

  it("an assistant message with empty content coerces content to null", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 2 }],
    };
    const body = convertRequest(req);
    // content || null -> null for empty string.
    expect(body.messages[0].content).toBeNull();
  });

  it("a tool result with an undefined result produces content ''", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 3,
          toolContent: {
            parts: [{ toolCallId: "call_1", result: undefined }],
          },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "" },
    ]);
  });

  it("a tool result with a null result produces content ''", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 3,
          toolContent: {
            parts: [{ toolCallId: "call_1", result: null }],
          },
        },
      ],
    };
    const body = convertRequest(req);
    // safeStringify(null) -> "".
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "" },
    ]);
  });

  it("multiple tool results in one message expand into multiple tool messages", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 3,
          toolContent: {
            parts: [
              { toolCallId: "call_1", result: { a: 1 } },
              { toolCallId: "call_2", result: { b: 2 } },
            ],
          },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: '{"a":1}' },
      { role: "tool", tool_call_id: "call_2", content: '{"b":2}' },
    ]);
  });

  it("a tool result part with no toolCallId defaults to ''", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 3,
          toolContent: { parts: [{ result: { x: 1 } }] },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages[0].tool_call_id).toBe("");
  });

  it("tools with an empty name are filtered out", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      tools: [
        { name: "", description: "no name", parameters: {} },
        { name: "real", description: "real tool", parameters: {} },
      ],
    };
    const body = convertRequest(req);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "real", description: "real tool", parameters: {} },
      },
    ]);
  });

  it("tools with an undefined name are filtered out", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      tools: [{ description: "no name" }, { name: "real" }],
    };
    const body = convertRequest(req);
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0].function.name).toBe("real");
  });

  it("tools with undefined parameters default parameters to {}", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      tools: [{ name: "real" }],
    };
    const body = convertRequest(req);
    expect(body.tools![0].function.parameters).toEqual({});
  });

  it("tools with no description default description to ''", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      tools: [{ name: "real" }],
    };
    const body = convertRequest(req);
    expect(body.tools![0].function.description).toBe("");
  });

  it("modelConfig with all fields is fully applied", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      modelConfig: {
        maxTokens: 256,
        temperature: 0.7,
        topP: 0.8,
        stopSequences: ["stop1", "stop2"],
      },
    };
    const body = convertRequest(req);
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.8);
    expect(body.stop).toEqual(["stop1", "stop2"]);
  });

  it("modelConfig with an empty stopSequences array omits the stop field", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      modelConfig: { stopSequences: [] },
    };
    const body = convertRequest(req);
    expect(body.stop).toBeUndefined();
  });

  it("no modelConfig means no optional fields are set on the output", () => {
    const body = convertRequest({ messages: [{ role: 1, text: "hi" }] });
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.stop).toBeUndefined();
  });

  it("an image part with only data (no url) uses data as the image url", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 1,
          parts: {
            parts: [{ image: { data: "data:image/png;base64,AAAA" } }],
          },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages[0].content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" },
      },
    ]);
  });

  it("an image part with neither url nor data defaults the url to ''", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 1,
          parts: { parts: [{ image: {} }] },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "" } },
    ]);
  });

  it("a file part produces a text content '[file: name]'", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 1,
          parts: { parts: [{ file: { name: "report.pdf" } }] },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "[file: report.pdf]" },
    ]);
  });

  it("a file part with no name produces '[file: ]'", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 1,
          parts: { parts: [{ file: {} }] },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "[file: ]" },
    ]);
  });

  it("a text part with null text is skipped", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 1,
          parts: { parts: [{ text: { text: null as unknown as string } }] },
        },
      ],
    };
    const body = convertRequest(req);
    // No content parts produced -> content is the empty array.
    expect(body.messages[0].content).toEqual([]);
  });

  it("the output is always configured for streaming with usage", () => {
    const body = convertRequest({ messages: [] });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Response frame factories — edge cases
// ---------------------------------------------------------------------------

describe("response frame factories — edge cases", () => {
  it("makeTextFrame with an empty string yields text ''", () => {
    const frame = makeTextFrame("", true);
    expect("textPart" in frame).toBe(true);
    if ("textPart" in frame) {
      expect(frame.textPart.text).toBe("");
    }
  });

  it("makeTextFrame with null text coerces to ''", () => {
    const frame = makeTextFrame(null as unknown as string, false);
    expect("textPart" in frame).toBe(true);
    if ("textPart" in frame) {
      expect(frame.textPart.text).toBe("");
      expect(frame.textPart.isFinal).toBe(false);
    }
  });

  it("makeTextFrame with undefined text coerces to ''", () => {
    const frame = makeTextFrame(undefined as unknown as string, true);
    expect("textPart" in frame).toBe(true);
    if ("textPart" in frame) {
      expect(frame.textPart.text).toBe("");
      expect(frame.textPart.isFinal).toBe(true);
    }
  });

  it("makeTextFrame isFinal true sets isFinal true", () => {
    const frame = makeTextFrame("done", true);
    expect("textPart" in frame).toBe(true);
    if ("textPart" in frame) {
      expect(frame.textPart.isFinal).toBe(true);
    }
  });

  it("makeTextFrame isFinal false sets isFinal false", () => {
    const frame = makeTextFrame("chunk", false);
    expect("textPart" in frame).toBe(true);
    if ("textPart" in frame) {
      expect(frame.textPart.isFinal).toBe(false);
    }
  });

  it("makeToolCallFrame with empty args yields args ''", () => {
    const frame = makeToolCallFrame("call_1", "fn", "", true);
    expect("toolCallPart" in frame).toBe(true);
    if ("toolCallPart" in frame) {
      expect(frame.toolCallPart.args).toBe("");
      expect(frame.toolCallPart.isComplete).toBe(true);
    }
  });

  it("makeToolCallFrame with null args coerces to ''", () => {
    const frame = makeToolCallFrame(
      "call_1",
      "fn",
      null as unknown as string,
      false,
    );
    expect("toolCallPart" in frame).toBe(true);
    if ("toolCallPart" in frame) {
      expect(frame.toolCallPart.args).toBe("");
    }
  });

  it("makeToolCallFrame preserves id and name", () => {
    const frame = makeToolCallFrame("id-xyz", "tool_name", "{}", true);
    expect("toolCallPart" in frame).toBe(true);
    if ("toolCallPart" in frame) {
      expect(frame.toolCallPart.toolCallId).toBe("id-xyz");
      expect(frame.toolCallPart.toolName).toBe("tool_name");
    }
  });

  it("makeUsageFrame with 0 tokens yields 0, 0", () => {
    const frame = makeUsageFrame(0, 0);
    expect("usage" in frame).toBe(true);
    if ("usage" in frame) {
      expect(frame.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    }
  });

  it("makeUsageFrame coerces undefined tokens to 0", () => {
    const frame = makeUsageFrame(
      undefined as unknown as number,
      undefined as unknown as number,
    );
    expect("usage" in frame).toBe(true);
    if ("usage" in frame) {
      expect(frame.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    }
  });

  it("makeUsageFrame without extended fields omits them (compact frame)", () => {
    const frame = makeUsageFrame(10, 20);
    expect("usage" in frame).toBe(true);
    if ("usage" in frame) {
      expect(frame.usage.promptTokens).toBe(10);
      expect(frame.usage.completionTokens).toBe(20);
      expect(frame.usage.totalTokens).toBeUndefined();
      expect(frame.usage.reasoningTokens).toBeUndefined();
      expect(frame.usage.cachedTokens).toBeUndefined();
    }
  });

  it("makeUsageFrame forwards extended token details when provided", () => {
    const frame = makeUsageFrame(92, 18, 110, 5, 64);
    expect("usage" in frame).toBe(true);
    if ("usage" in frame) {
      expect(frame.usage.promptTokens).toBe(92);
      expect(frame.usage.completionTokens).toBe(18);
      expect(frame.usage.totalTokens).toBe(110);
      expect(frame.usage.reasoningTokens).toBe(5);
      expect(frame.usage.cachedTokens).toBe(64);
    }
  });

  it("makeUsageFrame coerces negative/NaN extended fields to 0", () => {
    const frame = makeUsageFrame(10, 20, -5, NaN, Infinity);
    expect("usage" in frame).toBe(true);
    if ("usage" in frame) {
      // totalTokens: -5 is finite but negative → safeTokenCount → 0
      expect(frame.usage.totalTokens).toBe(0);
      // reasoningTokens: NaN → not finite → not included
      expect(frame.usage.reasoningTokens).toBeUndefined();
      // cachedTokens: Infinity → not finite → not included
      expect(frame.usage.cachedTokens).toBeUndefined();
    }
  });

  it("makeErrorFrame with an empty message defaults to 'inference error'", () => {
    const frame = makeErrorFrame("");
    expect("error" in frame).toBe(true);
    if ("error" in frame) {
      expect(frame.error.message).toBe("inference error");
      expect(frame.error.code).toBe("");
      expect(frame.error.errorType).toBe(
        "INFERENCE_STREAM_ERROR_TYPE_UNKNOWN",
      );
    }
  });

  it("makeErrorFrame preserves a provided message", () => {
    const frame = makeErrorFrame("kaboom");
    expect("error" in frame).toBe(true);
    if ("error" in frame) {
      expect(frame.error.message).toBe("kaboom");
    }
  });

  it("makeErrorFrame with null message defaults to 'inference error'", () => {
    const frame = makeErrorFrame(null as unknown as string);
    expect("error" in frame).toBe(true);
    if ("error" in frame) {
      expect(frame.error.message).toBe("inference error");
    }
  });

  it("makeResponseInfoFrame produces a string createdAt timestamp", () => {
    const frame = makeResponseInfoFrame("chatcmpl-x", "gpt-4o");
    expect("responseInfo" in frame).toBe(true);
    if ("responseInfo" in frame) {
      expect(typeof frame.responseInfo.createdAt).toBe("string");
      expect(frame.responseInfo.createdAt.length).toBeGreaterThan(0);
      // Should be numeric-looking (milliseconds since epoch).
      expect(Number.isFinite(Number(frame.responseInfo.createdAt))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ToolCallAccumulator — edge cases
// ---------------------------------------------------------------------------

describe("ToolCallAccumulator — edge cases", () => {
  it("feeding a chunk with no choices produces no accumulation", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({ choices: undefined });
    expect(acc.size).toBe(0);
  });

  it("feeding a chunk with an empty choices array produces no accumulation", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({ choices: [] });
    expect(acc.size).toBe(0);
  });

  it("feeding a chunk with choices but no tool_calls produces no accumulation", () => {
    const acc = new ToolCallAccumulator();
    const chunk: OpenAISSEChunk = {
      choices: [{ index: 0, delta: { content: "hello" } }],
    };
    acc.feed(chunk);
    expect(acc.size).toBe(0);
  });

  it("feeding a chunk with choices but null tool_calls produces no accumulation", () => {
    const acc = new ToolCallAccumulator();
    const chunk: OpenAISSEChunk = {
      choices: [{ index: 0, delta: { tool_calls: undefined } }],
    };
    acc.feed(chunk);
    expect(acc.size).toBe(0);
  });

  it("feeds multiple deltas for the same index concatenate args", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "c", function: { name: "f", arguments: '{"a":' } },
            ],
          },
        },
      ],
    });
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '1}' } }],
          },
        },
      ],
    });
    expect(acc.size).toBe(1);
    const frames = acc.flush(true);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const tc = frames[0];
    expect("toolCallPart" in tc).toBe(true);
    if ("toolCallPart" in tc) {
      expect(tc.toolCallPart.args).toBe('{"a":1}');
    }
  });

  it("feeds deltas for different indices produce separate calls", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "c0", function: { name: "f0", arguments: "{}" } },
              { index: 1, id: "c1", function: { name: "f1", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    expect(acc.size).toBe(2);
    const frames = acc.flush(true);
    expect(frames).toHaveLength(2);
  });

  it("a delta with id but no name, then a delta with name but no id, preserves both", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_id", function: { arguments: "{" } },
            ],
          },
        },
      ],
    });
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { name: "tool_name", arguments: "}" } },
            ],
          },
        },
      ],
    });
    const frames = acc.flush(true);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const tc = frames[0];
    expect("toolCallPart" in tc).toBe(true);
    if ("toolCallPart" in tc) {
      expect(tc.toolCallPart.toolCallId).toBe("call_id");
      expect(tc.toolCallPart.toolName).toBe("tool_name");
      expect(tc.toolCallPart.args).toBe("{}");
    }
  });

  it("flush with isStreamComplete=true marks frames isComplete=true", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }],
          },
        },
      ],
    });
    const frames = acc.flush(true);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect("toolCallPart" in frame).toBe(true);
      if ("toolCallPart" in frame) {
        expect(frame.toolCallPart.isComplete).toBe(true);
      }
    }
  });

  it("flush with isStreamComplete=false marks frames isComplete=false", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }],
          },
        },
      ],
    });
    const frames = acc.flush(false);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect("toolCallPart" in frame).toBe(true);
      if ("toolCallPart" in frame) {
        expect(frame.toolCallPart.isComplete).toBe(false);
      }
    }
  });

  it("flush with no accumulated calls returns an empty array", () => {
    const acc = new ToolCallAccumulator();
    expect(acc.flush(true)).toEqual([]);
    expect(acc.flush(false)).toEqual([]);
  });

  it("size is 0 before any feed", () => {
    const acc = new ToolCallAccumulator();
    expect(acc.size).toBe(0);
  });

  it("size reflects the number of unique indices", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 2, id: "c2", function: { name: "f2", arguments: "{}" } },
              { index: 0, id: "c0", function: { name: "f0", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    expect(acc.size).toBe(2);
  });

  it("flush emits frames in ascending index order", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 5, id: "c5", function: { name: "f5", arguments: "{}" } },
              { index: 1, id: "c1", function: { name: "f1", arguments: "{}" } },
              { index: 3, id: "c3", function: { name: "f3", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    const frames = acc.flush(true);
    const names = frames.map((f) =>
      "toolCallPart" in f ? f.toolCallPart.toolName : "",
    );
    expect(names).toEqual(["f1", "f3", "f5"]);
  });

  it("feeding after flush continues accumulating (flush does not clear state)", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "c0", function: { name: "f0", arguments: "{}" } }],
          },
        },
      ],
    });
    const first = acc.flush(true);
    expect(first).toHaveLength(1);
    // flush() does not clear the internal map, so size is unchanged.
    expect(acc.size).toBe(1);
    // A second flush returns the same accumulated calls again.
    const second = acc.flush(true);
    expect(second).toHaveLength(1);
    // Feeding a new index adds to the existing accumulation.
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 1, id: "c1", function: { name: "f1", arguments: "{}" } }],
          },
        },
      ],
    });
    expect(acc.size).toBe(2);
    const third = acc.flush(true);
    expect(third).toHaveLength(2);
  });

  it("a delta with no id and no name defaults both to ''", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: "x" } }],
          },
        },
      ],
    });
    const frames = acc.flush(true);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const tc = frames[0];
    expect("toolCallPart" in tc).toBe(true);
    if ("toolCallPart" in tc) {
      expect(tc.toolCallPart.toolCallId).toBe("");
      expect(tc.toolCallPart.toolName).toBe("");
      expect(tc.toolCallPart.args).toBe("x");
    }
  });
});
