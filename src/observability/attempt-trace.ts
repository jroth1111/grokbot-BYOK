// Per-request attempt trace: the durable record of the failover ladder one
// proxied request walked (groq 429 → google timeout → cerebras ok). The
// fallback loop collects one AttemptTraceRecord per dispatched attempt —
// including the SUCCESSFUL final one — and the trail is logged when all
// providers fail or the request errors out.
//
// The trace is passed manually through the request closure (not via
// AsyncLocalStorage) because the shim's single request handler makes
// threading trivial and the ALS context propagation adds complexity without
// benefit in this architecture.

export type AttemptErrorClass =
  | 'auth'
  | 'out_of_credits'
  | 'daily_quota_exhausted'
  | 'model_not_found'
  | 'forbidden'
  | 'context_too_large'
  | 'provider_bad_request'
  | 'empty_completion'
  | 'format_ignored'
  | 'invalid_tool_arguments'
  | 'timeout'
  | 'rate_limited'
  | 'upstream_error'
  | 'error';

// 'ok'           — the attempt produced the client's response ('done').
// 'committed'    — a stream flushed real bytes, then ended without a clean
//                  finish (mid-stream error the surface rendered honestly, or
//                  a pre-commit client disconnect the surface swallowed); the
//                  parent requests row carries the specifics.
// 'client_abort' — the client hung up mid-attempt; the upstream call was
//                  canceled and no failure bookkeeping ran.
// AttemptErrorClass — the failure class of a failed-and-failed-over attempt.
export type AttemptOutcome = 'ok' | 'committed' | 'client_abort' | AttemptErrorClass;

export interface AttemptTraceRecord {
  // 0-based position in the ladder; the persistence order key.
  ordinal: number;
  platform: string;
  modelId: string;
  // Per-request key ordinal (key1, key2…), same anonymization as the
  // X-Fallback-Trail header — never the internal key id.
  keyOrdinal: number;
  outcome: AttemptOutcome;
  // Milliseconds from the ladder's start to this attempt's dispatch.
  startOffsetMs: number;
  // Milliseconds this attempt ran (for 'ok' streams: until the response
  // finished, i.e. including streaming time).
  durationMs: number;
  // Short, REDACTED summary of the error that ended this attempt (see
  // lib/error-redaction.ts summarizeAttemptError — secrets scrubbed, capped at
  // 200 chars). Null for successful hops ('ok'/'committed').
  errorSummary: string | null;
}

export interface RequestTrace {
  records: AttemptTraceRecord[];
}

export function newRequestTrace(): RequestTrace {
  return { records: [] };
}
