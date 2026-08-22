// Upstream-error classification shared by the proxy chat path, the responses
// path, and the fusion panel. Pure functions over an error's message/status —
// no I/O — so they live in a neutral lib module that any of those can import
// without forming an import cycle (fusion ↔ proxy in particular).

// ── Transport failures hidden in the cause chain (undici) ────────────────────
// The detailed classifier reads the TOP-LEVEL message, and undici does not always
// put the real failure there. The INITIAL-CONNECT case is covered by luck:
// undici words a connection that never opened "fetch failed", and the substring
// rules in the classifier match that string. A socket that dies MID-request does
// not get the same treatment — it surfaces as a generic wrapper (a bare
// `TypeError: terminated`, or an adapter's own re-throw) whose `.cause` carries
// the actual ECONNRESET / EPIPE / "socket hang up" / "premature close" /
// "other side closed" error, sometimes nested a link or two deeper still.
// Those fell through every rule and classified FATAL: the client got a 502
// while the healthy paid routes queued behind the dead one were never tried.
//
// Everything matched here is a transient network fault that says nothing about
// the request or the model, so the next candidate in the chain can serve it.
// The walk is bounded and cycle-safe: `cause` is attacker-adjacent data (it can
// come from a provider's own error object) and a self-referential chain on this
// hot path would hang the request, not just slow it.
const TRANSPORT_CAUSE_MAX_DEPTH = 5;

const TRANSPORT_ERROR_CODES = new Set([
  // Node socket-level codes. A dead/refused/unreachable host is transient from
  // the chain's point of view either way: the next candidate is a DIFFERENT
  // host, so even a permanently bad one here is worth failing over rather than
  // 502-ing the caller.
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
]);

// undici stamps its own transport failures with a `UND_ERR_*` code
// (UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT, UND_ERR_HEADERS_TIMEOUT,
// UND_ERR_BODY_TIMEOUT, …). Matched by PREFIX rather than enumerated: the list
// grows with undici releases, and every member of it is a transport condition.
const UNDICI_ERROR_CODE_PREFIX = 'UND_ERR_';

const TRANSPORT_MESSAGE_HINTS = [
  'socket hang up',
  'premature close',
  'other side closed',
  // A socket dropped before the TLS handshake finished — undici's full wording
  // is "Client network socket disconnected before secure TLS connection was
  // established". The peer closed the TCP connection mid-handshake; transient.
  'client network socket disconnected',
  // The same codes as above, for the links that carry them in text only (an
  // error stringified across a boundary keeps the code in its message but
  // loses the `code` property).
  'econnreset', 'econnrefused', 'epipe', 'etimedout', 'eai_again',
];

/** Walk an error's `cause` chain, yielding each link's `code` and `message`.
 * Includes the error itself as the first link. Bounded to
 * TRANSPORT_CAUSE_MAX_DEPTH hops and cycle-safe. */
function errorChainLinks(err: unknown): Array<{ code: string; message: string }> {
  const links: Array<{ code: string; message: string }> = [];
  const seen = new Set<unknown>();
  let cur: any = err;
  for (let depth = 0; cur != null && depth <= TRANSPORT_CAUSE_MAX_DEPTH; depth++) {
    if (typeof cur !== 'object' && typeof cur !== 'function') break;
    if (seen.has(cur)) break;
    seen.add(cur);
    links.push({
      code: typeof cur.code === 'string' ? cur.code : '',
      message: typeof cur.message === 'string' ? cur.message : '',
    });
    cur = cur.cause;
  }
  return links;
}

/** True when the error — or anything in its bounded cause chain — is a
 * transient network transport failure: a reset, dropped, refused or timed-out
 * socket, a failed TLS handshake, or an undici transport code. */
export function isTransportError(err: any): boolean {
  if (err == null) return false;
  // A client hang-up and the fallback time-budget hedge BOTH reach undici as an
  // aborted socket, and undici labels that abort UND_ERR_ABORTED — the very
  // same code a genuine mid-flight socket death carries. Neither is provider
  // health, so classifying either retryable would resurrect exactly what the
  // two marked abort errors exist to prevent (no cooldown, no health penalty,
  // no failure stats for a request the GATEWAY canceled). The structured
  // markers are authoritative and win over any transport evidence below.
  if (isClientAbortError(err) || isHedgeAbortError(err)) return false;
  for (const { code, message } of errorChainLinks(err)) {
    if (code && (TRANSPORT_ERROR_CODES.has(code) || code.startsWith(UNDICI_ERROR_CODE_PREFIX))) return true;
    const msg = message.toLowerCase();
    if (!msg) continue;
    if (TRANSPORT_MESSAGE_HINTS.some(hint => msg.includes(hint))) return true;
    // undici's wording for a response body whose socket died mid-read is the
    // bare word "terminated". Matched as the WHOLE message and never as a
    // substring: "your account has been terminated" is a fatal billing/auth
    // condition, and retrying that around the entire chain would burn every
    // candidate on a request that can never succeed.
    if (msg.trim() === 'terminated') return true;
  }
  return false;
}

// A genuine provider QUOTA signal: a structured 429 or rate-limit/quota wording.
// Distinct from the much broader retry classifiers: timeouts, 5xx, transport
// failures and dead-turn classes are retryable but say nothing about quotas.
// The null-limits exhaustion heuristic in getCooldownDecisionForLimit (services/
// ratelimit.ts) keys off this: only an actual quota signal may feed its
// "effectively daily-exhausted" escalation ladder. Before this split, a slow
// local Ollama route timing out twice classified retryable → recorded as a
// null-limit "429" → escalated 2m→10m→1h→24h and 429'd every request while the
// server was merely busy generating (#592).
// Mirrors the other classifiers: trust the structured status when the adapter
// attached one (providerHttpError sets err.status everywhere); fall back to
// message markers only when there is no status.
export function isRateLimitSignal(err: any): boolean {
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status !== 0) return status === 429;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted');
}

// ── Timeout wording ─────────────────────────────────────────────────────────
// The message markers that mean "this attempt ran out of time", in every
// wording the stack produces: the per-attempt HTTP deadline ("The operation was
// aborted (groq, chat, 120s)" — enrichAbort in lib/proxy.ts), the mid-stream
// inactivity watchdog ("… stream stalled: no data for 90000ms (timeout)"), the
// first-byte grace budget, and a raw socket ETIMEDOUT.
//
// A client hang-up is deliberately NOT in here: newClientAbortError's message
// ("client disconnected — upstream request canceled") carries none of these
// markers precisely so a vanished client is never read as provider slowness.
//
// Single source of truth for two consumers: the attempt-trail classifier
// (classifyAttemptError) and the analytics query that folds timeouts into the
// speed score (refreshStatsCache, #619) — so the trail and the score always
// agree about what a timeout is.
export const TIMEOUT_ERROR_MARKERS = ['timeout', 'stalled', 'etimedout', 'aborted'] as const;

/** True when an error message reads as a timeout. Expects raw text; caller need
 * not lowercase it. */
export function isTimeoutErrorText(message: unknown): boolean {
  const msg = (typeof message === 'string' ? message : String(message ?? '')).toLowerCase();
  return TIMEOUT_ERROR_MARKERS.some(marker => msg.includes(marker));
}

// ── Client-caused aborts ─────────────────────────────────────────────────────
// When the gateway's OWN client hangs up, the proxy surfaces abort the composed
// fetch signal with this marked error, and undici rejects the in-flight fetch /
// body read / stream read with the same object (fetch propagates the signal's
// abort reason). It is deliberately NOT an AbortError and its message contains
// neither "aborted" nor "timeout": enrichAbort (lib/proxy.ts) must pass it
// through untouched, and it must never classify as a retryable provider
// timeout — a vanished client says nothing about provider health, so the
// fallback loop stops without a cooldown, health penalty, or failure stats.
export function newClientAbortError(): Error {
  const err = new Error('client disconnected — upstream request canceled');
  (err as Error & { clientAbort?: boolean }).clientAbort = true;
  return err;
}

/** True when an error is (or wraps) the client-disconnect abort above. The
 * structured marker is the primary signal; `cause` is checked because some
 * transports re-wrap the abort reason, and the message substring is the last
 * resort for errors that were stringified across a boundary. */
export function isClientAbortError(err: any): boolean {
  if (err?.clientAbort === true) return true;
  if (err?.cause && (err.cause as { clientAbort?: boolean }).clientAbort === true) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('client disconnected');
}

/** True when an error is (or wraps) a time-budget hedge abort. */
export function isHedgeAbortError(err: any): boolean {
  if (err?.hedgeAbort === true) return true;
  if (err?.cause && (err.cause as { hedgeAbort?: boolean }).hedgeAbort === true) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('fallback time budget expired');
}

/** True for any fetch-abort rejection surfacing out of a body read — the
 * per-attempt timeout ('request'-bounds deadline in fetchWithTimeout), an
 * AbortSignal.timeout, or the client disconnect above. Adapters that wrap
 * res.json() in a diagnostic catch (openai-compat's non-JSON-body split) must
 * rethrow these instead of classifying them as a malformed provider body. */
export function isAbortLikeError(err: any): boolean {
  if (isClientAbortError(err)) return true;
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError' || /\baborted\b/i.test(err?.message ?? '');
}

// A 401 / invalid-API-key error from a provider. KEY-fatal, not request-fatal:
// the same request is fine on the provider's sibling key or on another provider,
// so the fallback loop rotates past the bad key (and triggers an immediate
// health revalidation) instead of 502-ing the whole request. Deliberately NOT
// classified as retryable: a bad key must be skipped and revalidated, not
// blindly re-benched like a rate limit — the loop handles it as its own class.
//
// Status handling: every provider adapter attaches err.status (providerHttpError
// in providers/base.ts), so the structured status is the primary signal.
//   - 401 → always key-auth.
//   - 400 → key-auth ONLY for Google-style key-specific phrasings: Google
//     reports a bad/expired key as HTTP 400 INVALID_ARGUMENT with "API key not
//     valid" / "API key expired" / API_KEY_INVALID (#268, providers/google.ts).
//     Without this a dead Google key classified as a provider bad-request and
//     could exhaust into a client-blaming 400 "rejected the request as invalid".
//     Generic auth wording (unauthorized etc.) stays excluded on a 400 so
//     ordinary payload rejections never classify as key-auth.
//   - any other status → not key-auth (e.g. a 403 stays model-forbidden).
//   - no status at all → key-specific OR generic auth substrings.
export function isKeyAuthError(err: any): boolean {
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status === 401) return true;
  const msg = (err?.message ?? '').toLowerCase();
  const keySpecific = msg.includes('api key not valid')
    || msg.includes('api key expired')
    || msg.includes('api_key_invalid');
  if (status === 400) return keySpecific;
  if (status !== 0) return false;
  return keySpecific
    || msg.includes('401')
    || msg.includes('unauthorized')
    || msg.includes('invalid api key')
    || msg.includes('invalid_api_key')
    || msg.includes('incorrect api key')
    || msg.includes('authentication failed');
}

// A 429 whose body says the provider's DAILY free allocation is spent (observed
// live: Cloudflare "you have used up your daily free allocation of 10,000
// neurons"; OpenRouter "free-models-per-day"). A transient 90s cooldown just
// makes the router re-pick a dead-for-the-day provider all day, so the caller
// benches until the next UTC midnight instead. Requires BOTH a daily marker and
// a quota/allocation marker so an ordinary per-minute 429 never matches.
export function isDailyQuotaExhaustedError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  if (!/daily|per[ -_]?day|\btoday\b/.test(msg)) return false;
  return /allocation|quota|limit|exhaust|used up/.test(msg);
}

// A provider-side "this hosted model is temporarily degraded" condition dressed
// up as a 400. Observed live on NVIDIA NIM (issue #522): a degraded function
// returns `400 {"detail":"Function id '...': DEGRADED function cannot be
// invoked"}` — the request is fine; the deployment is sick. Must NOT classify
// as a provider bad-request: exhausting on it would render a client-blaming
// 400 invalid_request_error for what is capacity/health, not request shape.
export function isProviderDegradedError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('degraded');
}

// Provider-side 400s are retryable because another provider may accept the same
// request shape. If every routed provider rejects it, however, the client should
// see an invalid-request error rather than a misleading rate-limit exhaustion.
export function isProviderBadRequestError(err: any): boolean {
  if (isProviderDegradedError(err)) return false;
  const status = typeof err?.status === 'number' ? err.status : 0;
  const msg = (err?.message ?? '').toLowerCase();
  if (status === 400) return msg.includes('api error 400');
  if (status === 422) return msg.includes('api error 422') || msg.includes('unprocessable entity');
  if (status !== 0) return false;
  return msg.includes('api error 400') || msg.includes('api error 422') || msg.includes('unprocessable entity');
}

// A "this request/prompt is too large" rejection. Providers word it very
// differently and even disagree on the HTTP status:
//   - OpenAI-compat: 400 with code `context_length_exceeded` — "This model's
//     maximum context length is 8192 tokens. However, your messages resulted
//     in 10001 tokens. Please reduce the length of the messages."
//   - Anthropic: 400 invalid_request_error — "prompt is too long: 210000
//     tokens > 200000 maximum" (Bedrock words it "Input is too long for
//     requested model.")
//   - Google/Gemini: 400 INVALID_ARGUMENT — "The input token count (1200000)
//     exceeds the maximum number of tokens allowed (1048576)."
//   - Groq: a literal HTTP 413 — "Request too large for model `x` ... on
//     tokens per minute (TPM): Limit 30000, Requested 33476". Requested >
//     Limit can never fit that candidate's window, so it belongs here (too
//     large for the candidate), not with transient per-minute 429s.
//   - Reverse proxies / gateways: 413 "Payload Too Large" / "request entity
//     too large" / "content too large".
// Structured status first (providerHttpError attaches err.status on every
// adapter), then the code field, then message markers — mirroring how the
// other classifiers in this file work. Retryable (a sibling candidate may have
// a larger window), but when EVERY attempt dies this way the exhaustion ladder
// renders an honest 413 instead of a generic failure.
export function isContextTooLargeError(err: any): boolean {
  if (err?.status === 413) return true;
  if (typeof err?.code === 'string' && err.code.toLowerCase() === 'context_length_exceeded') return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('context_length_exceeded')
    || msg.includes('maximum context length')
    || msg.includes('context length exceeded')
    || /exceeds[^.]*context (length|window|size)/.test(msg)
    || msg.includes('prompt is too long')
    || msg.includes('input is too long')
    || /input token count[^.]*exceeds/.test(msg)
    || msg.includes('exceeds the maximum number of tokens')
    || msg.includes('request too large')
    || msg.includes('payload too large')
    || msg.includes('request entity too large')
    || msg.includes('request body too large')
    || msg.includes('content too large')
    // Zhipu AI (bigmodel.cn) 400, error code 1261: "Prompt exceeds max length"
    // (#873). Its wording matches none of the markers above, so without this it
    // was mis-bucketed as provider_bad_request instead of context_too_large.
    || msg.includes('exceeds max length')
    || msg.includes('api error 413');
}

// A 402 Payment Required / out-of-credits error. Distinct from a transient 429:
// it won't recover on the next window, so the caller benches the model+key with
// PAYMENT_REQUIRED_COOLDOWN_MS (a full day) rather than the 90s transient cooldown.
export function isPaymentRequiredError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('402') || msg.includes('payment required')
    || msg.includes('insufficient_quota') || msg.includes('insufficient credit')
    || msg.includes('insufficient balance');
}

// A 404 "model removed/deprecated upstream" error. It's a MODEL-level failure,
// not a key-level one: every key for the platform will 404 the same way, so the
// retry loop skips the entire model for the rest of the request instead of
// burning one fallback attempt per key on the same dead route.
// (PR #111, credits @barbotkonv.)
export function isModelNotFoundError(err: any): boolean {
  // 404 (removed/deprecated) and 410 (permanently Gone) are both MODEL-level: every
  // key for the platform fails the same way, so skip the whole model for the rest
  // of the request instead of burning one fallback attempt per sibling key. 410
  // added for #339 (Ollama Cloud "Gone"); prefer the structured status when present.
  if (err?.status === 404 || err?.status === 410) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    || msg.includes('410') || msg.includes('gone');
}

// A 403 Forbidden returned for a specific model behind an otherwise-valid key.
// Drives the same whole-model skip as a 404: every key on this platform's tier
// would be forbidden the same model, so rule it out for the rest of the request
// rather than trying it again with a sibling key. Distinct from a dead key —
// validateKey returns false on 401/403, so the health checker disables genuinely
// forbidden keys; a 403 reaching here is model-not-on-this-tier. See issue #256.
export function isModelAccessForbiddenError(err: any): boolean {
  if (err?.status === 403) return true;
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('403') || msg.includes('forbidden')) return true;
  // Not every provider spells "this key may not use this model" as a 403 (issue
  // #618): observed live as a 400 whose body reads "user is not allowed to
  // access model kat-coder-pro-v2.5", and as plan-gate wordings like "action
  // plan limited". Classified transient, those took the 90s bench — and the
  // auto-router re-picked the same permanently-unreachable model the moment it
  // expired, failing and re-benching forever with an ever-growing penalty.
  // Deliberately narrow: only 400/401 (or a status-less error), and only for
  // phrasings that name access/permission to the MODEL. A bare "Bad Request",
  // a generic "Unauthorized" (which isKeyAuthError owns), or a parameter
  // rejection must keep their current classification.
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status !== 0 && status !== 400 && status !== 401) return false;
  return MODEL_ACCESS_DENIED_PHRASES.some(phrase => msg.includes(phrase));
}

const MODEL_ACCESS_DENIED_PHRASES = [
  'not allowed to access',
  'not allowed to use',
  'not authorized to access',
  'not authorized to use',
  'unauthorized to access',
  'not permitted to access',
  'not permitted to use',
  'do not have access to',
  'does not have access to',
  'no access to model',
  'no access to this model',
  'model access denied',
  'access to this model is restricted',
  // Plan/subscription gates the provider words as a limit rather than a denial.
  'action plan limited',
];

// ── Content-filter / malformed-function-call detection (oh-my-pi flags) ──────
const CONTENT_FILTER_PATTERN = /\b(?:incomplete:\s*)?content_filter\b/i;

export function isContentBlockedText(text: string): boolean {
  return CONTENT_FILTER_PATTERN.test(text);
}
