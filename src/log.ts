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
import { sanitizeProviderErrorMessage } from "./observability/error-redaction.js";
import { redactSecrets } from "./observability/log-redaction.js";

/**
 * Build a JSON.stringify replacer that handles `BigInt`, `Error`, and
 * `Buffer` values, and guards against circular references.
 *
 * `JSON.stringify` invokes a value's `toJSON()` method *before* the replacer
 * runs, so for `Buffer` (which defines `toJSON`) the `value` argument is
 * already the serialized `{ type: "Buffer", data: [...] }` shape rather than
 * the original `Buffer`. We therefore inspect the original value via
 * `this[key]` and serialize it ourselves.
 *
 * A per-call `WeakSet` tracks every object value we have already entered. If
 * the same object reference is encountered again it is replaced with the
 * string `"[Circular]"`, which prevents `JSON.stringify` from throwing
 * `TypeError: Converting circular structure to JSON`. A logger must never
 * throw, so this guard is essential. (Shared — non-cyclic — references are
 * also rendered as `"[Circular]"` on their second sighting; this matches the
 * behaviour of production loggers such as pino and is acceptable for log
 * output.)
 *
 * A fresh replacer (and therefore a fresh `WeakSet`) is created for each
 * `emit()` call so state never leaks between log lines.
 */
function makeReplacer(): (this: Record<string, unknown>, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function jsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
    const original = this[key];

    // Cycle detection: track every object we enter and short-circuit a
    // revisit. Primitives (including bigint) are skipped here.
    if (original !== null && typeof original === "object") {
      if (seen.has(original as object)) {
        return "[Circular]";
      }
      seen.add(original as object);
    }

    // BigInt is not JSON-serializable by default.
    if (typeof original === "bigint") {
      return original.toString();
    }
    if (original instanceof Error) {
      return {
        message: sanitizeProviderErrorMessage(original.message),
        stack: typeof original.stack === "string" ? redactSecrets(original.stack) : original.stack,
      };
    }
    if (Buffer.isBuffer(original)) {
      return original.toString("utf8");
    }
    return value;
  };
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
  // A logger must never throw: wrap serialization so an unexpected
  // (non-circular) failure still emits a usable line rather than crashing
  // the caller. The replacer handles the known hard cases (BigInt, Error,
  // Buffer, circular references) up front.
  let line: string;
  try {
    line = JSON.stringify(record, makeReplacer());
  } catch (err) {
    line = JSON.stringify({
      ts: record.ts,
      level,
      msg,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  process.stdout.write(line + "\n");
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
