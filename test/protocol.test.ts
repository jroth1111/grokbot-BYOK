/**
 * Tests for the protocol layer: Connect envelopes, SSE parsing, and proto3
 * JSON helpers.
 */
import { describe, it, expect } from "vitest";
import {
  encodeEnvelope,
  parseEnvelopes,
  DATA_FLAGS,
  END_STREAM_FLAGS,
} from "../src/protocol/connect.js";
import { SseParser } from "../src/protocol/sse.js";
import {
  roleToOpenAI,
  roleEnumNumber,
  structToJs,
  valueToJs,
  safeStringify,
} from "../src/protocol/proto3.js";

// ---------------------------------------------------------------------------
// Connect envelopes
// ---------------------------------------------------------------------------

describe("Connect envelopes", () => {
  it("encode/decode round-trip preserves flags and data", () => {
    const payload = Buffer.from('{"hello":"world"}', "utf8");
    const encoded = encodeEnvelope(DATA_FLAGS, payload);
    const envelopes = parseEnvelopes(encoded);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].flags).toBe(DATA_FLAGS);
    expect(envelopes[0].data.equals(payload)).toBe(true);
  });

  it("round-trips an end-stream trailer frame", () => {
    const payload = Buffer.from("{}", "utf8");
    const encoded = encodeEnvelope(END_STREAM_FLAGS, payload);
    const envelopes = parseEnvelopes(encoded);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].flags).toBe(END_STREAM_FLAGS);
    expect(envelopes[0].data.toString("utf8")).toBe("{}");
  });

  it("parses multiple envelopes in one buffer", () => {
    const a = encodeEnvelope(DATA_FLAGS, Buffer.from("aaa", "utf8"));
    const b = encodeEnvelope(DATA_FLAGS, Buffer.from("bbb", "utf8"));
    const c = encodeEnvelope(END_STREAM_FLAGS, Buffer.from("ccc", "utf8"));
    const buf = Buffer.concat([a, b, c]);
    const envelopes = parseEnvelopes(buf);
    expect(envelopes).toHaveLength(3);
    expect(envelopes[0].data.toString("utf8")).toBe("aaa");
    expect(envelopes[1].data.toString("utf8")).toBe("bbb");
    expect(envelopes[2].flags).toBe(END_STREAM_FLAGS);
    expect(envelopes[2].data.toString("utf8")).toBe("ccc");
  });

  it("throws on an incomplete header", () => {
    // Only 3 bytes — less than the 5-byte header.
    const partial = Buffer.from([0x00, 0x00, 0x01]);
    expect(() => parseEnvelopes(partial)).toThrow(/incomplete Connect envelope header/);
  });

  it("throws on an incomplete body", () => {
    // Header declares 10 bytes but only 2 follow.
    const header = Buffer.alloc(5);
    header.writeUInt8(DATA_FLAGS, 0);
    header.writeUInt32BE(10, 1);
    const buf = Buffer.concat([header, Buffer.from("ab", "utf8")]);
    expect(() => parseEnvelopes(buf)).toThrow(/incomplete Connect envelope body/);
  });

  it("encodes an empty data envelope", () => {
    const encoded = encodeEnvelope(DATA_FLAGS, Buffer.alloc(0));
    // 5-byte header + 0-byte body.
    expect(encoded.length).toBe(5);
    const envelopes = parseEnvelopes(encoded);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].data.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

describe("SseParser", () => {
  it("parses a single data line", () => {
    const parser = new SseParser();
    parser.feed('data: {"foo":1}\n\n');
    expect(parser.drain()).toEqual(['{"foo":1}']);
  });

  it("joins multi-line data fields with newlines", () => {
    const parser = new SseParser();
    parser.feed("data: line1\ndata: line2\n\n");
    expect(parser.drain()).toEqual(["line1\nline2"]);
  });

  it("handles \\r\\n line endings", () => {
    const parser = new SseParser();
    parser.feed("data: hello\r\n\r\n");
    expect(parser.drain()).toEqual(["hello"]);
  });

  it("ignores event:, id:, and comment lines", () => {
    const parser = new SseParser();
    parser.feed(":keepalive\nevent: ping\nid: 42\ndata: payload\n\n");
    expect(parser.drain()).toEqual(["payload"]);
  });

  it("handles partial chunks fed in pieces", () => {
    const parser = new SseParser();
    parser.feed('data: {"a"');
    expect(parser.drain()).toEqual([]);
    parser.feed(':1}\n');
    expect(parser.drain()).toEqual([]);
    parser.feed("\n");
    expect(parser.drain()).toEqual(['{"a":1}']);
  });

  it("passes [DONE] through as a data payload", () => {
    const parser = new SseParser();
    parser.feed("data: [DONE]\n\n");
    expect(parser.drain()).toEqual(["[DONE]"]);
  });

  it("skips empty data lines", () => {
    const parser = new SseParser();
    parser.feed("data:\n\ndata: real\n\n");
    expect(parser.drain()).toEqual(["real"]);
  });

  it("supports data:value without a space", () => {
    const parser = new SseParser();
    parser.feed("data:nospace\n\n");
    expect(parser.drain()).toEqual(["nospace"]);
  });
});

// ---------------------------------------------------------------------------
// Proto3 helpers
// ---------------------------------------------------------------------------

describe("roleToOpenAI", () => {
  it("maps numeric roles", () => {
    expect(roleToOpenAI(1)).toBe("user");
    expect(roleToOpenAI(2)).toBe("assistant");
    expect(roleToOpenAI(3)).toBe("tool");
    expect(roleToOpenAI(4)).toBe("system");
  });

  it("defaults undefined to user", () => {
    expect(roleToOpenAI(undefined)).toBe("user");
  });

  it("handles suffixed enum names", () => {
    expect(roleToOpenAI("INFERENCE_MESSAGE_ROLE_USER")).toBe("user");
    expect(roleToOpenAI("INFERENCE_MESSAGE_ROLE_ASSISTANT")).toBe("assistant");
    expect(roleToOpenAI("INFERENCE_MESSAGE_ROLE_TOOL")).toBe("tool");
    expect(roleToOpenAI("INFERENCE_MESSAGE_ROLE_SYSTEM")).toBe("system");
    expect(roleToOpenAI("_USER")).toBe("user");
    expect(roleToOpenAI("_SYSTEM")).toBe("system");
  });

  it("handles bare names (case-insensitive)", () => {
    expect(roleToOpenAI("USER")).toBe("user");
    expect(roleToOpenAI("assistant")).toBe("assistant");
    expect(roleToOpenAI("Tool")).toBe("tool");
    expect(roleToOpenAI("system")).toBe("system");
  });

  it("defaults unknown values to user", () => {
    expect(roleToOpenAI(99)).toBe("user");
    expect(roleToOpenAI("unknown")).toBe("user");
    expect(roleToOpenAI("")).toBe("user");
  });
});

describe("roleEnumNumber", () => {
  it("returns numbers in range as-is", () => {
    expect(roleEnumNumber(1)).toBe(1);
    expect(roleEnumNumber(4)).toBe(4);
  });

  it("parses numeric strings", () => {
    expect(roleEnumNumber("2")).toBe(2);
    expect(roleEnumNumber("3")).toBe(3);
  });

  it("defaults null/undefined to 1", () => {
    expect(roleEnumNumber(undefined)).toBe(1);
    expect(roleEnumNumber(null as unknown as undefined)).toBe(1);
  });
});

describe("structToJs", () => {
  it("unwraps a {fields:{}} wrapper", () => {
    const struct = {
      fields: {
        a: { numberValue: 1 },
        b: { stringValue: "hi" },
        c: { boolValue: true },
      },
    };
    expect(structToJs(struct)).toEqual({ a: 1, b: "hi", c: true });
  });

  it("handles an empty fields wrapper", () => {
    expect(structToJs({ fields: {} })).toEqual({});
  });

  it("unwraps value wrappers in a plain object", () => {
    expect(structToJs({ a: { nullValue: 0 }, b: { numberValue: 5 } })).toEqual({
      a: null,
      b: 5,
    });
  });

  it("returns {} for non-object input", () => {
    expect(structToJs(null)).toEqual({});
    expect(structToJs("string")).toEqual({});
  });
});

describe("valueToJs", () => {
  it("unwraps nullValue", () => {
    expect(valueToJs({ nullValue: 0 })).toBeNull();
  });

  it("unwraps numberValue", () => {
    expect(valueToJs({ numberValue: 42 })).toBe(42);
  });

  it("unwraps stringValue", () => {
    expect(valueToJs({ stringValue: "hello" })).toBe("hello");
  });

  it("unwraps boolValue", () => {
    expect(valueToJs({ boolValue: true })).toBe(true);
    expect(valueToJs({ boolValue: false })).toBe(false);
  });

  it("unwraps structValue", () => {
    expect(valueToJs({ structValue: { fields: { x: { numberValue: 1 } } } })).toEqual({
      x: 1,
    });
  });

  it("unwraps listValue", () => {
    expect(
      valueToJs({
        listValue: { values: [{ numberValue: 1 }, { stringValue: "a" }] },
      }),
    ).toEqual([1, "a"]);
  });

  it("returns null for null/undefined", () => {
    expect(valueToJs(null)).toBeNull();
    expect(valueToJs(undefined)).toBeNull();
  });

  it("returns plain values unchanged", () => {
    expect(valueToJs("plain")).toBe("plain");
    expect(valueToJs(7)).toBe(7);
  });
});

describe("safeStringify", () => {
  it("returns '' for null and undefined", () => {
    expect(safeStringify(null)).toBe("");
    expect(safeStringify(undefined)).toBe("");
  });

  it("serializes objects", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("serializes arrays", () => {
    expect(safeStringify([1, 2])).toBe("[1,2]");
  });

  it("falls back to String() on circular references", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = safeStringify(circular);
    // JSON.stringify throws on cycles, so we get String(obj) (e.g. "[object Object]").
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
