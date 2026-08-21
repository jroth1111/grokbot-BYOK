/**
 * Proto3 JSON helpers for google.protobuf.Struct/Value and enum conversion.
 *
 * The Connect protocol carries inference messages as proto3 JSON, where
 * `google.protobuf.Struct` and `google.protobuf.Value` are represented with
 * tagged wrappers (`{numberValue: 1}`, `{structValue: {...}}`, etc.). This
 * module unwraps those into plain JS values and converts the
 * `InferenceMessageRole` enum between its numeric, suffixed-string, and
 * OpenAI-role-string forms.
 */

import type { OpenAIMessage } from "../types.js";

/** Numeric values of the InferenceMessageRole enum. */
const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;
const ROLE_TOOL = 3;
const ROLE_SYSTEM = 4;

/** Maps an enum number to its OpenAI role string. */
const ROLE_NUMBER_TO_OPENAI: Record<number, OpenAIMessage["role"]> = {
  [ROLE_USER]: "user",
  [ROLE_ASSISTANT]: "assistant",
  [ROLE_TOOL]: "tool",
  [ROLE_SYSTEM]: "system",
};

/**
 * Convert an InferenceMessageRole to an OpenAI role string.
 *
 * Accepts the enum as a number, a numeric string, a suffixed enum name
 * (e.g. `INFERENCE_MESSAGE_ROLE_USER` or `_USER`), or a bare name
 * (e.g. `USER`). Unknown or missing values default to `"user"`.
 *
 * @param role  The role value from a parsed Connect request.
 * @returns     One of `"user"`, `"assistant"`, `"tool"`, `"system"`.
 */
export function roleToOpenAI(
  role: number | string | undefined,
): "user" | "assistant" | "tool" | "system" {
  const num = roleEnumNumber(role);
  return ROLE_NUMBER_TO_OPENAI[num] ?? "user";
}

/**
 * Parse an InferenceMessageRole value to its enum number.
 *
 * Handles:
 *  - numbers (returned as-is when in range),
 *  - numeric strings (e.g. `"2"`),
 *  - suffixed enum names (e.g. `INFERENCE_MESSAGE_ROLE_USER`, `_USER`),
 *  - bare names (e.g. `USER`, `user`).
 *
 * Unknown values yield {@link ROLE_USER} (1) as a safe default.
 *
 * @param role  The role value from a parsed Connect request.
 * @returns     The enum number (1–4), defaulting to 1.
 */
export function roleEnumNumber(role: number | string | undefined): number {
  if (role === undefined || role === null) {
    return ROLE_USER;
  }

  if (typeof role === "number") {
    return role in ROLE_NUMBER_TO_OPENAI ? role : ROLE_USER;
  }

  const trimmed = role.trim();
  if (trimmed === "") {
    return ROLE_USER;
  }

  // Numeric string like "2".
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n in ROLE_NUMBER_TO_OPENAI ? n : ROLE_USER;
  }

  // Suffixed enum name: take the segment after the last underscore and
  // lowercase it (e.g. INFERENCE_MESSAGE_ROLE_USER -> user, _USER -> user).
  const suffix = trimmed.includes("_")
    ? trimmed.slice(trimmed.lastIndexOf("_") + 1)
    : trimmed;

  const normalized = suffix.toLowerCase();
  const nameToNumber: Record<string, number> = {
    user: ROLE_USER,
    assistant: ROLE_ASSISTANT,
    tool: ROLE_TOOL,
    system: ROLE_SYSTEM,
  };
  if (normalized in nameToNumber) {
    return nameToNumber[normalized];
  }

  return ROLE_USER;
}

/** A google.protobuf.Value tagged wrapper. */
interface ProtoValue {
  nullValue?: unknown;
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  structValue?: { fields?: Record<string, ProtoValue> };
  listValue?: { values?: ProtoValue[] };
}

/** Known `google.protobuf.Value` wrapper variant keys. */
const PROTO_VALUE_KEYS = [
  "nullValue",
  "numberValue",
  "stringValue",
  "boolValue",
  "structValue",
  "listValue",
] as const;

/**
 * True if `v` looks like a google.protobuf.Value wrapper.
 *
 * A well-formed proto3 `Value` is a oneof carrying exactly one of the variant
 * keys (`nullValue`/`numberValue`/`stringValue`/`boolValue`/`structValue`/
 * `listValue`). Requiring a single key avoids false positives where a plain
 * object merely happens to contain a wrapper-named field (e.g.
 * `{ name: "x", stringValue: "y" }`) and would otherwise be collapsed, silently
 * dropping the sibling fields.
 */
function isProtoValue(v: unknown): v is ProtoValue {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const keys = Object.keys(v as Record<string, unknown>);
  return (
    keys.length === 1 &&
    PROTO_VALUE_KEYS.includes(keys[0] as (typeof PROTO_VALUE_KEYS)[number])
  );
}

/**
 * Convert a google.protobuf.Value wrapper to a plain JS value.
 *
 * Recognizes the `nullValue`/`numberValue`/`stringValue`/`boolValue`/
 * `structValue`/`listValue` variants. Values that are not wrapped (already
 * plain JS) are returned unchanged.
 *
 * @param v  The value to unwrap.
 * @returns  The corresponding native JS value.
 */
export function valueToJs(v: unknown): unknown {
  if (v === null || v === undefined) {
    return null;
  }

  if (!isProtoValue(v)) {
    // Already a plain JS value (string/number/bool/array/object).
    if (Array.isArray(v)) {
      return v.map(valueToJs);
    }
    if (typeof v === "object") {
      return structToJs(v);
    }
    return v;
  }

  if (v.nullValue !== undefined) {
    return null;
  }
  if (v.numberValue !== undefined) {
    return v.numberValue;
  }
  if (v.stringValue !== undefined) {
    return v.stringValue;
  }
  if (v.boolValue !== undefined) {
    return v.boolValue;
  }
  if (v.structValue !== undefined) {
    return structToJs(v.structValue);
  }
  if (v.listValue !== undefined) {
    return (v.listValue.values ?? []).map(valueToJs);
  }

  return null;
}

/**
 * Convert a google.protobuf.Struct (`{fields: {...}}`) or a plain object to a
 * plain JS object, unwrapping each field's Value wrapper.
 *
 * @param struct  The struct or raw object to convert.
 * @returns       A plain JS record.
 */
export function structToJs(struct: unknown): Record<string, unknown> {
  if (struct === null || typeof struct !== "object") {
    return {};
  }

  // google.protobuf.Struct form: { fields: { key: Value } }
  if (
    "fields" in struct &&
    typeof (struct as { fields?: unknown }).fields === "object" &&
    (struct as { fields?: unknown }).fields !== null
  ) {
    const fields = (struct as { fields: Record<string, unknown> }).fields;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(fields)) {
      out[key] = valueToJs(val);
    }
    return out;
  }

  // Plain object: unwrap any Value wrappers found as values.
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(
    struct as Record<string, unknown>,
  )) {
    out[key] = valueToJs(val);
  }
  return out;
}

/**
 * Safely serialize a value to JSON.
 *
 * @param v  The value to stringify.
 * @returns  The JSON string, or `""` for null/undefined, or `String(v)` if
 *           `JSON.stringify` throws (e.g. on cyclic structures).
 */
export function safeStringify(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
