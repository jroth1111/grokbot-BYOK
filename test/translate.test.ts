/**
 * Tests for request/response translation and tool-call accumulation.
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
// convertRequest
// ---------------------------------------------------------------------------

describe("convertRequest", () => {
  it("translates a basic text user message", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hello" }],
    };
    const body = convertRequest(req);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("translates system + user messages", () => {
    const req: InferenceStreamRequest = {
      messages: [
        { role: 4, text: "you are helpful" },
        { role: 1, text: "hi" },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("translates an assistant message with tool_calls", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 2,
          text: "calling tool",
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
    expect(body.messages).toHaveLength(1);
    const msg = body.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("calling tool");
    expect(msg.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);
  });

  it("translates tool result messages into tool-role messages", () => {
    const req: InferenceStreamRequest = {
      messages: [
        {
          role: 3,
          toolContent: {
            parts: [
              { toolCallId: "call_1", result: { temperature: 72 } },
            ],
          },
        },
      ],
    };
    const body = convertRequest(req);
    expect(body.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temperature":72}',
      },
    ]);
  });

  it("translates a tools array into OpenAI tool definitions", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "Get the weather",
          parameters: { fields: { city: { stringValue: "" } } },
        },
        { name: "", description: "no name", parameters: {} },
      ],
    };
    const body = convertRequest(req);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: { city: "" },
        },
      },
    ]);
  });

  it("does not set tools when there are none", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
    };
    const body = convertRequest(req);
    expect(body.tools).toBeUndefined();
  });

  it("applies modelConfig fields", () => {
    const req: InferenceStreamRequest = {
      messages: [{ role: 1, text: "hi" }],
      modelConfig: {
        maxTokens: 100,
        temperature: 0.5,
        topP: 0.9,
        stopSequences: ["stop1", "stop2"],
      },
    };
    const body = convertRequest(req);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(["stop1", "stop2"]);
  });

  it("handles empty messages", () => {
    const req: InferenceStreamRequest = { messages: [] };
    const body = convertRequest(req);
    expect(body.messages).toEqual([]);
  });

  it("handles a request with no messages field at all", () => {
    const body = convertRequest({});
    expect(body.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Response frame factories
// ---------------------------------------------------------------------------

describe("response frame factories", () => {
  it("makeResponseInfoFrame has correct id/model/createdAt", () => {
    const frame = makeResponseInfoFrame("chatcmpl-1", "gpt-4");
    expect("responseInfo" in frame).toBe(true);
    if ("responseInfo" in frame) {
      expect(frame.responseInfo.id).toBe("chatcmpl-1");
      expect(frame.responseInfo.model).toBe("gpt-4");
      expect(frame.responseInfo.createdAt).toEqual(expect.any(String));
      expect(frame.responseInfo.messages).toEqual([]);
    }
  });

  it("makeTextFrame with isFinal true", () => {
    const frame = makeTextFrame("done", true);
    expect("textPart" in frame).toBe(true);
    if ("textPart" in frame) {
      expect(frame.textPart).toEqual({ text: "done", isFinal: true });
    }
  });

  it("makeTextFrame with isFinal false", () => {
    const frame = makeTextFrame("chunk", false);
    expect("textPart" in frame).toBe(true);
    if ("textPart" in frame) {
      expect(frame.textPart).toEqual({ text: "chunk", isFinal: false });
    }
  });

  it("makeTextFrame coerces empty text", () => {
    const frame = makeTextFrame("", true);
    if ("textPart" in frame) {
      expect(frame.textPart.text).toBe("");
      expect(frame.textPart.isFinal).toBe(true);
    }
  });

  it("makeToolCallFrame with isComplete true", () => {
    const frame = makeToolCallFrame("call_1", "get_weather", '{"city":"SF"}', true);
    if ("toolCallPart" in frame) {
      expect(frame.toolCallPart).toEqual({
        toolCallId: "call_1",
        toolName: "get_weather",
        args: '{"city":"SF"}',
        isComplete: true,
      });
    }
  });

  it("makeToolCallFrame with isComplete false", () => {
    const frame = makeToolCallFrame("call_1", "get_weather", '{"city":', false);
    if ("toolCallPart" in frame) {
      expect(frame.toolCallPart.isComplete).toBe(false);
      expect(frame.toolCallPart.args).toBe('{"city":');
    }
  });

  it("makeUsageFrame carries token counts", () => {
    const frame = makeUsageFrame(10, 20);
    if ("usage" in frame) {
      expect(frame.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
    }
  });

  it("makeUsageFrame coerces zero/undefined to 0", () => {
    const frame = makeUsageFrame(0, 0);
    if ("usage" in frame) {
      expect(frame.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    }
  });

  it("makeErrorFrame carries a message", () => {
    const frame = makeErrorFrame("something broke");
    if ("error" in frame) {
      expect(frame.error.message).toBe("something broke");
      expect(frame.error.errorType).toBe("INFERENCE_STREAM_ERROR_TYPE_UNKNOWN");
    }
  });

  it("makeErrorFrame defaults to a generic message", () => {
    const frame = makeErrorFrame("");
    if ("error" in frame) {
      expect(frame.error.message).toBe("inference error");
    }
  });
});

// ---------------------------------------------------------------------------
// ToolCallAccumulator
// ---------------------------------------------------------------------------

describe("ToolCallAccumulator", () => {
  it("feeds a single chunk with one tool call", () => {
    const acc = new ToolCallAccumulator();
    const chunk: OpenAISSEChunk = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
        },
      ],
    };
    acc.feed(chunk);
    expect(acc.size).toBe(1);
    const frames = acc.flush(true);
    expect(frames).toHaveLength(1);
    const tc = frames[0];
    if ("toolCallPart" in tc) {
      expect(tc.toolCallPart).toEqual({
        toolCallId: "call_1",
        toolName: "get_weather",
        args: '{"city":"SF"}',
        isComplete: true,
      });
    }
  });

  it("accumulates args across multiple chunks", () => {
    const acc = new ToolCallAccumulator();
    const chunk1: OpenAISSEChunk = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":' } },
            ],
          },
        },
      ],
    };
    const chunk2: OpenAISSEChunk = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '"SF"}' } },
            ],
          },
        },
      ],
    };
    acc.feed(chunk1);
    acc.feed(chunk2);
    expect(acc.size).toBe(1);
    const frames = acc.flush(true);
    const tc = frames[0];
    if ("toolCallPart" in tc) {
      expect(tc.toolCallPart.args).toBe('{"city":"SF"}');
      expect(tc.toolCallPart.isComplete).toBe(true);
    }
  });

  it("flush with isStreamComplete=true marks calls complete", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] },
        },
      ],
    });
    const frames = acc.flush(true);
    const tc = frames[0];
    if ("toolCallPart" in tc) {
      expect(tc.toolCallPart.isComplete).toBe(true);
    }
  });

  it("flush with isStreamComplete=false marks calls incomplete", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] },
        },
      ],
    });
    const frames = acc.flush(false);
    const tc = frames[0];
    if ("toolCallPart" in tc) {
      expect(tc.toolCallPart.isComplete).toBe(false);
    }
  });

  it("handles multiple tool calls in one stream", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, id: "c2", function: { name: "tool_b", arguments: '{"b":2}' } },
              { index: 0, id: "c1", function: { name: "tool_a", arguments: '{"a":1}' } },
            ],
          },
        },
      ],
    });
    const frames = acc.flush(true);
    // Emitted in index order.
    expect(frames).toHaveLength(2);
    const first = frames[0];
    const second = frames[1];
    if ("toolCallPart" in first) {
      expect(first.toolCallPart.toolName).toBe("tool_a");
    }
    if ("toolCallPart" in second) {
      expect(second.toolCallPart.toolName).toBe("tool_b");
    }
  });

  it("returns [] when flushing an empty accumulator", () => {
    const acc = new ToolCallAccumulator();
    expect(acc.size).toBe(0);
    expect(acc.flush(true)).toEqual([]);
  });

  it("ignores chunks without tool_calls", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({
      choices: [
        { index: 0, delta: { content: "hello" } },
      ],
    });
    expect(acc.size).toBe(0);
  });
});
