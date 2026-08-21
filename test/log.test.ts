/**
 * Tests for the structured JSON logger.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "../src/log.js";

// ---------------------------------------------------------------------------
// stdout capture helpers
// ---------------------------------------------------------------------------

let captured: string[] = [];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  captured = [];
  originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    captured.push(chunk);
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

/** Parse the captured stdout lines into JSON objects. */
function lines(): Record<string, unknown>[] {
  return captured
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe("createLogger", () => {
  it('info() emits JSON with level "info"', () => {
    const log = createLogger();
    log.info("hello");
    const [rec] = lines();
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("hello");
  });

  it('warn() emits JSON with level "warn"', () => {
    const log = createLogger();
    log.warn("careful");
    const [rec] = lines();
    expect(rec.level).toBe("warn");
    expect(rec.msg).toBe("careful");
  });

  it('error() emits JSON with level "error"', () => {
    const log = createLogger();
    log.error("boom");
    const [rec] = lines();
    expect(rec.level).toBe("error");
    expect(rec.msg).toBe("boom");
  });

  it("each log line has ts (ISO string), level, msg", () => {
    const log = createLogger();
    log.info("msg");
    const [rec] = lines();
    expect(typeof rec.ts).toBe("string");
    // ISO string should parse back to a valid Date.
    expect(new Date(rec.ts as string).toString()).not.toBe("Invalid Date");
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("msg");
  });

  it("fields are merged into the JSON object", () => {
    const log = createLogger();
    log.info("routing", { model: "sand-default", provider: "opencode-go" });
    const [rec] = lines();
    expect(rec.model).toBe("sand-default");
    expect(rec.provider).toBe("opencode-go");
    expect(rec.msg).toBe("routing");
  });

  it("Error objects are serialized to {message, stack}", () => {
    const log = createLogger();
    const err = new Error("something broke");
    log.error("failed", { error: err });
    const [rec] = lines();
    const serialized = rec.error as { message: string; stack?: string };
    expect(serialized.message).toBe("something broke");
    expect(typeof serialized.stack).toBe("string");
  });

  it("Buffer values are serialized to utf8 string", () => {
    const log = createLogger();
    const buf = Buffer.from("hello-bytes", "utf8");
    log.info("buf", { data: buf });
    const [rec] = lines();
    expect(rec.data).toBe("hello-bytes");
  });

  it("BigInt values are serialized to string", () => {
    const log = createLogger();
    log.info("bigint", { count: 9007199254740993n });
    const [rec] = lines();
    expect(rec.count).toBe("9007199254740993");
  });

  it("undefined fields don't break JSON", () => {
    const log = createLogger();
    log.info("undef", { maybe: undefined });
    const [rec] = lines();
    // JSON.stringify drops undefined values from objects.
    expect("maybe" in rec).toBe(false);
    expect(rec.msg).toBe("undef");
  });

  it("empty fields object works", () => {
    const log = createLogger();
    log.info("empty", {});
    const [rec] = lines();
    expect(rec.msg).toBe("empty");
    expect(rec.level).toBe("info");
  });

  it("no fields argument works", () => {
    const log = createLogger();
    log.info("nofields");
    const [rec] = lines();
    expect(rec.msg).toBe("nofields");
    expect(rec.level).toBe("info");
    expect(Object.keys(rec).sort()).toEqual(["level", "msg", "ts"]);
  });

  it("emits one JSON line per call", () => {
    const log = createLogger();
    log.info("a");
    log.warn("b");
    log.error("c");
    const recs = lines();
    expect(recs).toHaveLength(3);
    expect(recs[0].msg).toBe("a");
    expect(recs[1].msg).toBe("b");
    expect(recs[2].msg).toBe("c");
  });
});
