/**
 * Edge-case tests for the protocol layer: Connect envelopes, SSE parsing, and
 * proto3 JSON helpers. These complement protocol.test.ts with cases not
 * already covered there.
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
  valueToJs,
  structToJs,
  safeStringify,
} from "../src/protocol/proto3.js";

// ---------------------------------------------------------------------------
// Connect envelopes — edge cases
// ---------------------------------------------------------------------------

describe("Connect envelopes — edge cases", () => {
  it("parseEnvelopes with an empty buffer returns an empty array", () => {
    expect(parseEnvelopes(Buffer.alloc(0))).toEqual([]);
  });

  it("parseEnvelopes with an incomplete header (< 5 bytes) throws", () => {
    // 4 bytes — one short of the 5-byte header.
    const partial = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    expect(() => parseEnvelopes(partial)).toThrow(
      /incomplete Connect envelope header/,
    );
  });

  it("parseEnvelopes with a 1-byte buffer throws (incomplete header)", () => {
    expect(() => parseEnvelopes(Buffer.from([0x00]))).toThrow(
      /incomplete Connect envelope header/,
    );
  });

  it("parseEnvelopes with an incomplete body (declared > available) throws", () => {
    const header = Buffer.alloc(5);
    header.writeUInt8(DATA_FLAGS, 0);
    header.writeUInt32BE(100, 1);
    const buf = Buffer.concat([header, Buffer.from("only a few", "utf8")]);
    expect(() => parseEnvelopes(buf)).toThrow(
      /incomplete Connect envelope body/,
    );
  });

  it("parseEnvelopes parses multiple envelopes including a zero-length body", () => {
    const a = encodeEnvelope(DATA_FLAGS, Buffer.from("first", "utf8"));
    const empty = encodeEnvelope(END_STREAM_FLAGS, Buffer.alloc(0));
    const b = encodeEnvelope(DATA_FLAGS, Buffer.from("third", "utf8"));
    const envelopes = parseEnvelopes(Buffer.concat([a, empty, b]));
    expect(envelopes).toHaveLength(3);
    expect(envelopes[0].data.toString("utf8")).toBe("first");
    expect(envelopes[1].flags).toBe(END_STREAM_FLAGS);
    expect(envelopes[1].data.length).toBe(0);
    expect(envelopes[2].data.toString("utf8")).toBe("third");
  });

  it("parseEnvelopes with a zero-length body (header says 0 bytes) returns empty data", () => {
    const encoded = encodeEnvelope(DATA_FLAGS, Buffer.alloc(0));
    const envelopes = parseEnvelopes(encoded);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].data.length).toBe(0);
  });

  it("encodeEnvelope with empty data buffer produces just the 5-byte header", () => {
    const encoded = encodeEnvelope(DATA_FLAGS, Buffer.alloc(0));
    expect(encoded.length).toBe(5);
    // Header bytes: flags=0x00, length=0x00000000.
    expect(Array.from(encoded)).toEqual([0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it("encodeEnvelope preserves an exact arbitrary flags value", () => {
    const flags = 0x02; // end-stream
    const encoded = encodeEnvelope(flags, Buffer.from("body", "utf8"));
    expect(encoded[0]).toBe(flags);
    const envelopes = parseEnvelopes(encoded);
    expect(envelopes[0].flags).toBe(flags);
  });

  it("encodeEnvelope preserves a high flags byte (0xff)", () => {
    const encoded = encodeEnvelope(0xff, Buffer.from("x", "utf8"));
    expect(encoded[0]).toBe(0xff);
    expect(parseEnvelopes(encoded)[0].flags).toBe(0xff);
  });

  it("round-trip: encode then parse gives back the same data", () => {
    const payload = Buffer.from('{"k":"v","n":3}', "utf8");
    const encoded = encodeEnvelope(DATA_FLAGS, payload);
    const [env] = parseEnvelopes(encoded);
    expect(env.flags).toBe(DATA_FLAGS);
    expect(env.data.equals(payload)).toBe(true);
  });

  it("round-trip with a large payload (10000 bytes)", () => {
    const payload = Buffer.alloc(10000, 0x41); // 10000 'A' bytes
    const encoded = encodeEnvelope(DATA_FLAGS, payload);
    expect(encoded.length).toBe(10005);
    const [env] = parseEnvelopes(encoded);
    expect(env.data.equals(payload)).toBe(true);
    expect(env.data.length).toBe(10000);
  });

  it("parseEnvelopes returns independent copies of the body data", () => {
    const payload = Buffer.from("hello", "utf8");
    const encoded = encodeEnvelope(DATA_FLAGS, payload);
    const [env] = parseEnvelopes(encoded);
    // The body data should be an independent copy, not a subarray view that
    // aliases the input buffer. Verify content correctness, then mutate the
    // input buffer and confirm the envelope data is unaffected.
    expect(env.data.toString("utf8")).toBe("hello");
    expect(env.data.length).toBe(5);
    encoded[5] = 0x58; // overwrite 'h' with 'X' in the input buffer
    expect(env.data.toString("utf8")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// SSE parser — edge cases
// ---------------------------------------------------------------------------

describe("SseParser — edge cases", () => {
  it("feeding an empty string produces no events", () => {
    const parser = new SseParser();
    parser.feed("");
    expect(parser.drain()).toEqual([]);
  });

  it("feeding only comment lines produces no events", () => {
    const parser = new SseParser();
    parser.feed(":keepalive\n:another comment\n\n");
    expect(parser.drain()).toEqual([]);
  });

  it("ignores event: and id: lines, extracting only data:", () => {
    const parser = new SseParser();
    parser.feed("event: ping\nid: 42\ndata: payload\n\n");
    expect(parser.drain()).toEqual(["payload"]);
  });

  it("handles data: without a space after the colon", () => {
    const parser = new SseParser();
    parser.feed("data:nospace\n\n");
    expect(parser.drain()).toEqual(["nospace"]);
  });

  it("strips only the first space after data: when multiple spaces present", () => {
    const parser = new SseParser();
    parser.feed("data:  two spaces\n\n");
    // "data:  two spaces" -> slice(5) = "  two spaces", strip one leading
    // space -> " two spaces", then the dispatched payload is trimmed, which
    // removes the remaining leading space -> "two spaces".
    expect(parser.drain()).toEqual(["two spaces"]);
  });

  it("data: with one leading space vs no space both yield the same trimmed payload", () => {
    const parser = new SseParser();
    parser.feed("data:value\ndata: value\n\n");
    // Both forms produce "value"; joined with \n then trimmed.
    expect(parser.drain()).toEqual(["value\nvalue"]);
  });

  it("joins multiple data: lines in one event with \\n", () => {
    const parser = new SseParser();
    parser.feed("data: line1\ndata: line2\ndata: line3\n\n");
    expect(parser.drain()).toEqual(["line1\nline2\nline3"]);
  });

  it("handles CRLF line endings", () => {
    const parser = new SseParser();
    parser.feed("data: hello\r\n\r\n");
    expect(parser.drain()).toEqual(["hello"]);
  });

  it("handles mixed \\n and \\r\\n line endings", () => {
    const parser = new SseParser();
    parser.feed("data: a\ndata: b\r\n\r\n");
    expect(parser.drain()).toEqual(["a\nb"]);
  });

  it("handles data spread across multiple feed() calls (partial line)", () => {
    const parser = new SseParser();
    parser.feed('data: {"par');
    expect(parser.drain()).toEqual([]);
    parser.feed('tial":1}\n');
    expect(parser.drain()).toEqual([]);
    parser.feed("\n");
    expect(parser.drain()).toEqual(['{"partial":1}']);
  });

  it("passes [DONE] through as a data payload", () => {
    const parser = new SseParser();
    parser.feed("data: [DONE]\n\n");
    expect(parser.drain()).toEqual(["[DONE]"]);
  });

  it("does not dispatch an event for blank lines with no preceding data", () => {
    const parser = new SseParser();
    parser.feed("\n\n\n");
    expect(parser.drain()).toEqual([]);
  });

  it("dispatches multiple events separated by blank lines", () => {
    const parser = new SseParser();
    parser.feed("data: one\n\ndata: two\n\ndata: three\n\n");
    expect(parser.drain()).toEqual(["one", "two", "three"]);
  });

  it("drain() returns an empty array when no events are buffered", () => {
    const parser = new SseParser();
    parser.feed("data: pending\n");
    expect(parser.drain()).toEqual([]);
  });

  it("drain() clears the queue — a second call returns an empty array", () => {
    const parser = new SseParser();
    parser.feed("data: hello\n\n");
    expect(parser.drain()).toEqual(["hello"]);
    expect(parser.drain()).toEqual([]);
  });

  it("trims whitespace-only data payloads to empty and skips them", () => {
    const parser = new SseParser();
    parser.feed("data:   \n\ndata: real\n\n");
    expect(parser.drain()).toEqual(["real"]);
  });

  it("ignores unknown field prefixes", () => {
    const parser = new SseParser();
    parser.feed("retry: 5000\nfoo: bar\ndata: ok\n\n");
    expect(parser.drain()).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// Proto3 helpers — edge cases
// ---------------------------------------------------------------------------

describe("roleToOpenAI — edge cases", () => {
  it("maps null to user", () => {
    expect(roleToOpenAI(null as unknown as undefined)).toBe("user");
  });

  it("maps an empty string to user", () => {
    expect(roleToOpenAI("")).toBe("user");
  });

  it("maps an unknown number (99) to user", () => {
    expect(roleToOpenAI(99)).toBe("user");
  });

  it("maps a suffixed ASSISTANT name to assistant", () => {
    expect(roleToOpenAI("INFERENCE_MESSAGE_ROLE_ASSISTANT")).toBe("assistant");
  });

  it("maps a short _SYSTEM suffix to system", () => {
    expect(roleToOpenAI("_SYSTEM")).toBe("system");
  });

  it("maps lowercase 'tool' to tool", () => {
    expect(roleToOpenAI("tool")).toBe("tool");
  });

  it("maps uppercase 'TOOL' to tool", () => {
    expect(roleToOpenAI("TOOL")).toBe("tool");
  });

  it("maps a numeric string '2' to assistant", () => {
    expect(roleToOpenAI("2")).toBe("assistant");
  });

  it("maps a numeric string '4' to system", () => {
    expect(roleToOpenAI("4")).toBe("system");
  });

  it("maps a whitespace-padded name to user (trimmed then matched)", () => {
    expect(roleToOpenAI("  user  ")).toBe("user");
  });
});

describe("roleEnumNumber — edge cases", () => {
  it("maps a negative numeric string '-1' to the default (1)", () => {
    expect(roleEnumNumber("-1")).toBe(1);
  });

  it("maps a negative number to the default (1)", () => {
    expect(roleEnumNumber(-5)).toBe(1);
  });

  it("maps an out-of-range positive numeric string '99' to 1", () => {
    expect(roleEnumNumber("99")).toBe(1);
  });

  it("maps a whitespace-only string to 1", () => {
    expect(roleEnumNumber("   ")).toBe(1);
  });

  it("maps a bare lowercase name 'assistant' to 2", () => {
    expect(roleEnumNumber("assistant")).toBe(2);
  });
});

describe("valueToJs — edge cases", () => {
  it("unwraps nullValue (any value) to null", () => {
    expect(valueToJs({ nullValue: 0 })).toBeNull();
    expect(valueToJs({ nullValue: "NULL" })).toBeNull();
  });

  it("unwraps numberValue to a number", () => {
    expect(valueToJs({ numberValue: 3.14 })).toBe(3.14);
  });

  it("unwraps stringValue to a string", () => {
    expect(valueToJs({ stringValue: "hello" })).toBe("hello");
  });

  it("unwraps boolValue to a boolean", () => {
    expect(valueToJs({ boolValue: false })).toBe(false);
  });

  it("unwraps structValue to an object", () => {
    expect(
      valueToJs({ structValue: { fields: { x: { numberValue: 1 } } } }),
    ).toEqual({ x: 1 });
  });

  it("unwraps listValue to an array", () => {
    expect(
      valueToJs({
        listValue: { values: [{ numberValue: 1 }, { stringValue: "a" }] },
      }),
    ).toEqual([1, "a"]);
  });

  it("unwraps a plain array by mapping each element through valueToJs", () => {
    expect(
      valueToJs([{ numberValue: 1 }, { stringValue: "x" }, "plain"]),
    ).toEqual([1, "x", "plain"]);
  });

  it("returns null for null input", () => {
    expect(valueToJs(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(valueToJs(undefined)).toBeNull();
  });

  it("returns a plain string unchanged (not wrapped)", () => {
    expect(valueToJs("plain")).toBe("plain");
  });

  it("returns a plain number unchanged (not wrapped)", () => {
    expect(valueToJs(7)).toBe(7);
  });

  it("returns a plain boolean unchanged (not wrapped)", () => {
    expect(valueToJs(true)).toBe(true);
  });

  it("unwraps a listValue with missing values as an empty array", () => {
    expect(valueToJs({ listValue: {} })).toEqual([]);
  });

  it("unwraps nested structValue inside listValue", () => {
    expect(
      valueToJs({
        listValue: {
          values: [
            { structValue: { fields: { a: { numberValue: 1 } } } },
          ],
        },
      }),
    ).toEqual([{ a: 1 }]);
  });
});

describe("structToJs — edge cases", () => {
  it("returns {} for null", () => {
    expect(structToJs(null)).toEqual({});
  });

  it("returns {} for a non-object (string)", () => {
    expect(structToJs("string")).toEqual({});
  });

  it("returns {} for a number", () => {
    expect(structToJs(42)).toEqual({});
  });

  it("unwraps a plain object's value wrappers", () => {
    expect(
      structToJs({ a: { nullValue: 0 }, b: { numberValue: 5 } }),
    ).toEqual({ a: null, b: 5 });
  });

  it("leaves plain (non-wrapped) values in a plain object unchanged", () => {
    expect(structToJs({ a: "x", b: 2 })).toEqual({ a: "x", b: 2 });
  });

  it("treats an object with a null fields property as a plain object", () => {
    // null fields fails the struct-form check, so the plain-object path runs
    // and valueToJs(null) -> null.
    expect(structToJs({ fields: null })).toEqual({ fields: null });
  });

  it("treats an object with a non-object fields property as a plain object", () => {
    // A string fields value fails the struct-form check; the plain-object path
    // leaves the string value unwrapped.
    expect(structToJs({ fields: "oops" })).toEqual({ fields: "oops" });
  });

  it("unwraps nested structs within fields", () => {
    expect(
      structToJs({
        fields: {
          nested: {
            structValue: { fields: { inner: { stringValue: "v" } } },
          },
        },
      }),
    ).toEqual({ nested: { inner: "v" } });
  });
});

describe("safeStringify — edge cases", () => {
  it("returns '' for null", () => {
    expect(safeStringify(null)).toBe("");
  });

  it("returns '' for undefined", () => {
    expect(safeStringify(undefined)).toBe("");
  });

  it("does not throw on a cyclic object and returns String(v)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let threw = false;
    let result = "";
    try {
      result = safeStringify(circular);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(typeof result).toBe("string");
    // JSON.stringify throws on cycles, so the fallback String(obj) is used.
    expect(result).toBe(String(circular));
  });

  it("serializes a nested object", () => {
    expect(safeStringify({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
  });

  it("serializes a string value", () => {
    expect(safeStringify("text")).toBe('"text"');
  });
});
