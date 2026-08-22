import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

// A verdict on whether a tool call's arguments actually satisfy the schema the
// caller declared for that tool.
//
// lib/tool-args.ts repairs what it can prove is repairable, and deliberately
// invents nothing. What it cannot do is say "this is still wrong" — so a call
// that violates its schema flows on unchallenged, and the Anthropic surface
// turns it into `input: {}` (routes/anthropic.ts parseToolInput does
// `try { JSON.parse } catch { return {} }`). The client then gets a tool_use
// block with no arguments and no explanation, which reads to an agent as the
// model having chosen to call the tool with nothing.
//
// Free-tier models are exactly the population that emits malformed tool calls,
// and a different model usually gets it right, so the useful response is the
// one the loop already has for a dead turn: throw before anything is committed
// and let failover try the next candidate.
//
// OFF by default. A false positive here costs a failover hop, and schemas in
// the wild are strange enough that the honest default is to look before
// leaping — enable it, watch the trail, then decide.

/** 2020-12, because that is what zod-to-json-schema and Pydantic v2 emit; a
 *  draft-07-only Ajv throws on their `$schema`. `strict: false` keeps an
 *  unknown keyword from being fatal — plenty of real schemas carry vendor
 *  extensions, and rejecting the schema would fail calls that are fine. */
const ajv = new (Ajv2020 as unknown as typeof import('ajv').default)({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

export function isToolArgumentValidationEnabled(): boolean {
  const raw = process.env.VALIDATE_TOOL_ARGUMENTS;
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Order-independent serialisation, so two schemas that differ only in key order
 * share one compiled validator.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Compiled validators, keyed by the schema's stable form. `null` is cached
 *  too: a schema Ajv refuses to compile must not be recompiled per request. */
const compiled = new Map<string, ValidateFunction | null>();
/** The stable string is the expensive half, and tool schemas are the same
 *  object for every call in a request, so memoise per object identity. */
const stableKeys = new WeakMap<object, string>();

function keyFor(schema: object): string {
  const cached = stableKeys.get(schema);
  if (cached !== undefined) return cached;
  const key = stableStringify(schema);
  stableKeys.set(schema, key);
  return key;
}

function compiledFor(schema: object): ValidateFunction | null {
  const key = keyFor(schema);
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;

  let fn: ValidateFunction | null = null;
  try {
    // Drop `$schema`: a declared dialect Ajv does not recognise is fatal at
    // compile time, and the dialect is not what we are checking.
    const { $schema, ...rest } = schema as Record<string, unknown>;
    void $schema;
    fn = ajv.compile(rest);
  } catch {
    fn = null; // Unusable schema — see validateToolArguments, which fails OPEN.
  }
  compiled.set(key, fn);
  return fn;
}

export type ToolArgumentVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check `argsJson` against `schema`.
 *
 * Fails **open** in every case where we cannot form an opinion: no schema, a
 * schema Ajv will not compile, or arguments that are not JSON at all (the last
 * is someone else's error to report, and tool-args deliberately passes
 * unparseable arguments through untouched). Only a definite schema violation
 * returns a verdict, because the consequence of a verdict is a failover hop.
 */
export function validateToolArguments(
  toolName: string,
  argsJson: string,
  schema: unknown,
): ToolArgumentVerdict {
  if (!schema || typeof schema !== 'object') return { ok: true };

  const validate = compiledFor(schema as object);
  if (!validate) return { ok: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return { ok: true };
  }
  // A tool call's arguments are an object by definition; anything else is a
  // shape problem the schema will report on its own terms if it cares.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true };

  if (validate(parsed)) return { ok: true };

  const detail = (validate.errors ?? [])
    .slice(0, 3)
    .map(e => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
    .join('; ');
  return { ok: false, reason: `${toolName}: ${detail || 'does not match its schema'}` };
}

/**
 * Verdicts for a whole turn's tool calls. Returns the reasons for those that
 * violate their schema; an empty array means the turn is servable.
 */
export function invalidToolCallReasons(
  calls: Array<{ function?: { name?: string; arguments?: string } }> | undefined,
  schemas: Map<string, unknown>,
): string[] {
  if (!calls || calls.length === 0) return [];
  const reasons: string[] = [];
  for (const call of calls) {
    const name = call.function?.name;
    const args = call.function?.arguments;
    if (!name || typeof args !== 'string') continue;
    const schema = schemas.get(name);
    if (schema === undefined) continue; // Tool the caller never declared a schema for.
    const verdict = validateToolArguments(name, args, schema);
    if (!verdict.ok) reasons.push(verdict.reason);
  }
  return reasons;
}
