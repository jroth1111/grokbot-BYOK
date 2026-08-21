/**
 * Structured JSON logger.
 *
 * Each log call emits a single line of JSON to stdout, e.g.:
 *
 *   {"ts":"2026-08-21T15:30:00.000Z","level":"info","msg":"routing","model":"sand-default"}
 *
 * Field values that are `Error` or `Buffer` instances are serialized into
 * plain JSON-safe structures so the output never contains unserializable
 * values. `BigInt` values are also handled (converted to string) so a stray
 * bigint never throws inside `JSON.stringify`.
 */
import type { Logger, LogLevel } from "./types.js";

/**
 * JSON.stringify replacer that handles `BigInt`, `Error`, and `Buffer`
 * values. Anything else is passed through unchanged.
 *
 * `JSON.stringify` invokes a value's `toJSON()` method *before* the replacer
 * runs, so for `Buffer` (which defines `toJSON`) the `value` argument is
 * already the serialized `{ type: "Buffer", data: [...] }` shape rather than
 * the original `Buffer`. We therefore inspect the original value via
 * `this[key]` and serialize it ourselves.
 */
function jsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this[key];

  // BigInt is not JSON-serializable by default.
  if (typeof original === "bigint") {
    return original.toString();
  }
  if (original instanceof Error) {
    return { message: original.message, stack: original.stack };
  }
  if (Buffer.isBuffer(original)) {
    return original.toString("utf8");
  }
  return value;
}

/**
 * Emit a single structured log line to stdout.
 */
function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      record[k] = v;
    }
  }
  process.stdout.write(JSON.stringify(record, jsonReplacer) + "\n");
}

/**
 * Create a new `Logger` instance. Each method emits a JSON line at the
 * corresponding level.
 */
export function createLogger(): Logger {
  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
