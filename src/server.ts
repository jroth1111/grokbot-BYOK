/**
 * HTTP server that bridges Connect-RPC streaming inference requests to
 * OpenAI-compatible chat completion endpoints.
 *
 * The server accepts POST requests on the
 * `aiserver.v1.InferenceService/Stream` Connect streaming path, translates the
 * inbound InferenceStreamRequest into an OpenAI chat completion request, routes
 * it to a provider (with failover + circuit breaking + retry/backoff + key
 * rotation + session affinity), and streams the OpenAI SSE response back as
 * Connect InferenceStreamResponse frames.
 *
 * Nothing is written to the outbound response until an upstream provider has
 * accepted the request, so failover between providers is transparent to the
 * caller.
 */
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ConnectEnvelope,
  InferenceStreamRequest,
  InferenceStreamResponse,
  KeyInfo,
  Logger,
  NetworkConfig,
  OpenAIChatRequest,
  OpenAISSEChunk,
  Provider,
  ShimConfig,
} from "./types.js";
import {
  CONTENT_TYPE,
  DATA_FLAGS,
  END_STREAM_FLAGS,
  encodeEnvelope,
  parseEnvelopes,
} from "./protocol/connect.js";
import { SseParser } from "./protocol/sse.js";
import { ProviderRegistry } from "./providers/registry.js";
import { CircuitBreaker } from "./providers/failover.js";
import type { ErrorType } from "./providers/failover.js";
import { computeBackoff, computeRateLimitBackoff, sleep, shouldRetry } from "./providers/retry.js";
import { createStreamTimeout } from "./providers/stream-timeout.js";
import { SessionAffinity } from "./providers/session-affinity.js";
import { convertRequest } from "./translate/request.js";
import {
  makeErrorFrame,
  makeResponseInfoFrame,
  makeTextFrame,
  makeToolCallFrame,
  makeUsageFrame,
  extractUsage,
} from "./translate/response.js";
import { ToolCallAccumulator } from "./translate/tools.js";
import { applyCompatToRequest } from "./providers/compat.js";
import { detectSupportsImages } from "./providers/compat.js";
import type { ProviderCompat } from "./providers/compat.js";
import type { OAuthCredentialManager } from "./providers/oauth-core.js";
import {
  adaptResponsesStream,
  translateChatToResponses,
} from "./translate/responses-api.js";
import {
  adaptAnthropicStream,
  translateChatToAnthropic,
} from "./translate/anthropic-messages.js";
import {
  adaptGeminiStream,
  translateChatToGemini,
} from "./translate/gemini-v1internal.js";
import { rescueInlineToolCalls, containsDialectMarker, startsWithDialectMarker, couldBecomeDialectMarker } from "./translate/tool-call-rescue.js";
import { ThinkTagStreamFilter } from "./translate/think-tags.js";
import { StreamMarkupHealing, detectHealingPatternFromText } from "./translate/markup-healing.js";
import { isToolArgumentValidationEnabled, invalidToolCallReasons } from "./translate/tool-validate.js";
import { sanitizeProviderErrorMessage } from "./observability/error-redaction.js";
import {
  type AttemptOutcome,
  newRequestTrace,
} from "./observability/attempt-trace.js";
import {
  applyTokenBudget,
  tokenBudgetMessage,
  newBreaker,
  recordBreakerFailure,
  resetBreaker,
} from "./observability/guardrails.js";
import {
  generateRequestId,
  createRequestScopedLogger,
} from "./observability/request-id.js";
import { metrics } from "./observability/metrics.js";
import { performanceTracker } from "./providers/performance.js";
import { captureRequestBody, captureResponseSummary } from "./observability/body-capture.js";

/** Connect streaming path served by the shim. */
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";

/** Force-exit grace period (ms) after a graceful-shutdown signal. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Interval between session-affinity cleanup sweeps (ms). */
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Interval between OAuth access-token refresh sweeps (ms). */
const OAUTH_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** Default stream idle timeout (ms) when a provider doesn't specify one. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Default TTFB timeout (ms): if no first token arrives within this window,
 *  abort the stream and failover to the next provider. Set to 0 to disable. */
const DEFAULT_TTFB_TIMEOUT_MS = 15_000;

/**
 * Adaptive timeout parameters. Large prompts (346k+ tokens / 1.3MB+ JSON) need
 * more time for body upload and prefill. The base timeouts are scaled up by
 * these factors so the shim doesn't abort requests that are still processing
 * a massive context window.
 *
 * Observed in production: opencode-go takes 20-30s to respond for 346k token
 * prompts (body ~1.3MB), and openrouter TTFB can be 10-55s for the same. The
 * fixed 30s requestTimeout / 15s ttfbTimeout caused 56+9 aborts per session.
 */
const ADAPTIVE_TIMEOUT_BYTES_PER_MS = 50_000; // 1s per 50KB of request body
const ADAPTIVE_TIMEOUT_MAX_EXTRA_MS = 60_000; // cap extra at 60s
const ADAPTIVE_TTFB_TOKENS_PER_MS = 2_000;    // 1s per 2k estimated prompt tokens
const ADAPTIVE_TTFB_MAX_EXTRA_MS = 60_000;    // cap extra at 60s

/**
 * Compute an adaptive request timeout that scales with the serialized request
 * body size. Large bodies take longer to upload and trigger longer server-side
 * prefill before response headers are sent. The base timeout is increased by
 * ~1s per 50KB of body, capped at +60s.
 */
function adaptiveRequestTimeoutMs(baseMs: number, body: OpenAIChatRequest): number {
  const bodySize = JSON.stringify(body).length;
  const extra = Math.min(
    Math.floor(bodySize / ADAPTIVE_TIMEOUT_BYTES_PER_MS) * 1000,
    ADAPTIVE_TIMEOUT_MAX_EXTRA_MS,
  );
  return baseMs + extra;
}

/**
 * Compute an adaptive TTFB timeout that scales with the estimated prompt token
 * count. Providers need to process (prefill) the entire prompt before emitting
 * the first token; for 346k tokens this takes 10-55s. The base TTFB timeout is
 * increased by ~1s per 2k estimated tokens, capped at +60s.
 *
 * The estimate is rough (4 chars per token) — it only needs to be in the right
 * ballpark to prevent premature aborts on large-context requests.
 */
function adaptiveTtfbTimeoutMs(baseMs: number, body: OpenAIChatRequest): number {
  let chars = 0;
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") chars += part.text?.length ?? 0;
      }
    }
  }
  const estimatedTokens = Math.ceil(chars / 4);
  const extra = Math.min(
    Math.floor(estimatedTokens / ADAPTIVE_TTFB_TOKENS_PER_MS) * 1000,
    ADAPTIVE_TTFB_MAX_EXTRA_MS,
  );
  return baseMs + extra;
}

/** Shadow probe frequency: every Nth request, send a concurrent probe to
 *  the second-best provider to calibrate performance scores with true
 *  apples-to-apples data (same request, same prompt, direct comparison).
 *  0 disables. Default: every 50th request (~2% cost overhead). */
const SHADOW_PROBE_INTERVAL = 50;

/** Module-level request counter for shadow probe triggering. */
let requestCounter = 0;

/** Default retry backoff settings when a provider doesn't specify them. */
const DEFAULT_RETRY_BACKOFF_INITIAL_MS = 500;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 5_000;

/**
 * In-request rate-limit backoff cap. Upstream quota errors (e.g. Google
 * RESOURCE_EXHAUSTED) recommend half-hour waits; sleeping that long inside a
 * live request would hang the client. Beyond this cap the provider is
 * abandoned for this request (circuit-breaker cooldown still applies) and
 * the failover chain takes over immediately.
 */
const RATE_LIMIT_FAILOVER_CAP_MS = 60_000;

/**
 * Mask an API key for logging, showing only the first and last few characters.
 */
function maskKey(key: string): string {
  if (key.length <= 8) {
    return "***";
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Check if any message in the OpenAI request body contains image or video
 * parts (both are sent as `image_url` type in the OpenAI-compatible API).
 */
function requestHasImages(openaiBody: OpenAIChatRequest): boolean {
  for (const msg of openaiBody.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image_url") return true;
      }
    }
  }
  return false;
}

/**
 * Check if a specific model on a specific provider supports images.
 * Uses the compat detection logic with the actual model id, not the
 * provider's default model.
 */
function detectSupportsImagesForModel(
  provider: { name: string; baseUrl: string; compat: ProviderCompat },
  modelId: string,
): boolean {
  return detectSupportsImages(provider.name, provider.baseUrl, modelId);
}

/** The subset of Provider that the upstream fetch layer needs. */
interface UpstreamTarget {
  name: string;
  baseUrl: string;
  endpointPath: string;
  wireApi:
    | "chat-completions"
    | "responses"
    | "anthropic-messages"
    | "gemini-v1internal";
  authManager?: OAuthCredentialManager;
}

/**
 * Fetch a chat completion stream from a provider.
 *
 * Builds the request per provider dialect: static-key providers POST the
 * OpenAI Chat Completions body to `{baseUrl}/chat/completions`, while OAuth
 * ("Sign in with ChatGPT") providers resolve the account's current access
 * token via the auth manager, add the `chatgpt-account-id` header, translate
 * the body to the Responses API wire format, and adapt the response stream
 * back into standard OpenAI SSE so every downstream consumer is oblivious
 * to the dialect. Sets the request timeout via an AbortController, and
 * returns the Response. Throws on network error or timeout (AbortError).
 * The caller is responsible for checking `resp.ok` and reading the body.
 */
async function fetchCompletion(
  upstream: UpstreamTarget,
  body: OpenAIChatRequest,
  key: KeyInfo,
  timeoutMs: number,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // Per-provider OAuth headers (Bearer + companions) and transport shape.
  let dispatcher: unknown;
  if (upstream.authManager) {
    // The KeyInfo value is the account id; the manager resolves a fresh
    // token and adds any provider-specific companion headers.
    Object.assign(headers, await upstream.authManager.buildUpstreamHeaders(key.value));
    dispatcher = upstream.authManager.requestDispatcher?.();
  } else if (key.value && !key.value.startsWith("${")) {
    // Skip the header for empty keys AND unresolved "${VAR}" placeholders
    // (e.g. keyless Kilo whose apiKey was never set) — sending the literal
    // placeholder as a Bearer token gets it 401'd as INVALID_TOKEN.
    headers["Authorization"] = `Bearer ${key.value}`;
  }
  // OpenRouter attribution headers (optional, for app rankings).
  // Only sent when the provider host is openrouter.ai.
  if (upstream.baseUrl.includes("openrouter.ai")) {
    headers["X-Title"] = "grokbot-BYOK-v2";
    headers["HTTP-Referer"] = "https://github.com/jroth1111/grokbot-byok";
  }
  // Wire-dialect request translation. Every dialect consumes the same
  // internal OpenAI Chat Completions body.
  let requestBody: string;
  switch (upstream.wireApi) {
    case "responses":
      requestBody = JSON.stringify(translateChatToResponses(body));
      break;
    case "anthropic-messages":
      requestBody = JSON.stringify(translateChatToAnthropic(body));
      break;
    case "gemini-v1internal":
      requestBody = JSON.stringify(translateChatToGemini(body));
      break;
    default:
      requestBody = JSON.stringify(body);
      break;
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Antigravity: the account's project id rides as a query parameter
    // (endpoint rejects any metadata field in the body; license check needs
    // the project on the PROD cloudcode endpoint).
    let upstreamUrl = `${upstream.baseUrl}${upstream.endpointPath}`;
    if (upstream.wireApi === "gemini-v1internal" && upstream.authManager?.accountContext) {
      const ctx = await upstream.authManager.accountContext(key.value);
      if (typeof ctx.projectId === "string" && ctx.projectId) {
        upstreamUrl += `${upstream.endpointPath.includes("?") ? "&" : "?"}project=${encodeURIComponent(ctx.projectId)}`;
      }
    }
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: unknown });
    clearTimeout(timeoutHandle);
    // Non-OpenAI dialects: wrap the event stream back into OpenAI SSE chunks
    // so the streaming loop, tool accumulator, usage extraction, timeouts,
    // and failover all work unchanged. Only adapt successful bodies — error
    // bodies are read as text by the classification path.
    if (resp.ok && resp.body) {
      if (upstream.wireApi === "responses") {
        return new Response(adaptResponsesStream(resp.body, body.model), {
          status: resp.status,
          headers: resp.headers,
        });
      }
      if (upstream.wireApi === "anthropic-messages") {
        return new Response(adaptAnthropicStream(resp.body, body.model), {
          status: resp.status,
          headers: resp.headers,
        });
      }
      if (upstream.wireApi === "gemini-v1internal") {
        return new Response(adaptGeminiStream(resp.body, body.model), {
          status: resp.status,
          headers: resp.headers,
        });
      }
    }
    return resp;
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw err;
  }
}

/**
 * Write a single Connect data frame (JSON-encoded InferenceStreamResponse) to
 * the outbound response stream.
 */
function writeFrame(res: http.ServerResponse, frame: InferenceStreamResponse): void {
  const json = JSON.stringify(frame);
  res.write(encodeEnvelope(DATA_FLAGS, Buffer.from(json, "utf8")));
}

/** Write the Connect end-stream trailer frame and end the response. */
function endStream(res: http.ServerResponse): void {
  res.write(encodeEnvelope(END_STREAM_FLAGS, Buffer.from("{}", "utf8")));
  res.end();
}

/** Begin a Connect streaming response with the given HTTP status. */
function startConnectResponse(
  res: http.ServerResponse,
  status: number,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": CONTENT_TYPE,
    "Cache-Control": "no-cache",
    ...extraHeaders,
  });
}

/**
 * Shadow probe: fire a concurrent fetch to a second provider and measure
 * its TTFB + token throughput on the SAME request, then abort the stream.
 *
 * This gives true apples-to-apples performance data (same prompt, same
 * completion) to calibrate the latency router's scores. The probe runs
 * in the background — it does NOT affect the client's response, which is
 * served from the primary provider.
 *
 * The probe reads just enough of the stream to measure TTFB (first token)
 * and a few tokens of throughput, then cancels the connection to avoid
 * wasting provider quota on a full generation.
 */
async function shadowProbe(
  provider: Provider,
  model: string,
  body: OpenAIChatRequest,
  logger: Logger,
  requestId: string,
): Promise<void> {
  const key = provider.selectKey();
  const probeTimeoutMs = adaptiveRequestTimeoutMs(
    provider.network.requestTimeoutMs ?? 30000,
    body,
  );
  const ttfbTimeoutMs = adaptiveTtfbTimeoutMs(
    provider.network.ttfbTimeoutMs ?? DEFAULT_TTFB_TIMEOUT_MS,
    body,
  );

  // Deep-clone the body and apply compat for the shadow provider.
  const probeBody = JSON.parse(JSON.stringify(body)) as OpenAIChatRequest;
  probeBody.model = model;
  applyCompatToRequest(probeBody, provider.compat, model, provider.name, provider.baseUrl);

  // Estimate prompt tokens from the request body as a fallback. Many
  // providers only send usage (prompt_tokens) in the final chunk, but
  // the probe aborts after ~20 tokens — before that chunk arrives.
  // Without this fallback, promptTokens would be 0 and the prefill
  // normalization (ttfbMs / promptTokens) wouldn't work. The estimate
  // is rough (~4 chars/token) but sufficient for normalization.
  const estimatePromptTokens = (b: OpenAIChatRequest): number => {
    let chars = 0;
    for (const msg of b.messages) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part.text === "string") chars += part.text.length;
        }
      }
      if (msg.role) chars += msg.role.length;
    }
    return Math.max(1, Math.ceil(chars / 4));
  };
  const estimatedPromptTokens = estimatePromptTokens(probeBody);

  const probeStart = Date.now();
  let ttfbMs: number | undefined;
  let completionTokens = 0;
  let promptTokens = 0;
  let success = false;

  try {
    const resp = await fetchCompletion(provider, probeBody, key, probeTimeoutMs);
    if (!resp.ok || !resp.body) {
      logger.warn("shadow probe: upstream non-2xx", {
        requestId,
        provider: provider.name,
        status: resp.status,
        elapsed: Date.now() - probeStart,
      });
      performanceTracker.record(
        provider.name, false, undefined, 0, 0, Date.now() - probeStart, false,
      );
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const sseParser = new SseParser();
    let tokenCount = 0;
    const MAX_PROBE_TOKENS = 20; // Read ~20 tokens then abort

    // TTFB timer: abort if no first token within timeout.
    const ttfbTimer = setTimeout(() => {
      void reader.cancel().catch(() => { /* ignore */ });
    }, ttfbTimeoutMs);

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        sseParser.feed(text);
        for (const data of sseParser.drain()) {
          if (data === "[DONE]") {
            // Only mark success if we actually read some content.
            // [DONE] with 0 tokens = empty response, not a successful probe.
            if (tokenCount > 0) success = true;
            break;
          }
          try {
            const chunk = JSON.parse(data) as OpenAISSEChunk;
            // Extract usage (prompt tokens).
            const extracted = extractUsage(chunk);
          if (extracted?.promptTokens) promptTokens = extracted.promptTokens;
          if (extracted?.completionTokens) completionTokens = extracted.completionTokens;
            // Check for first content token (TTFB). Tool-call deltas also
            // count as content — without this, a tool-call-only response
            // would never set ttfbMs (same bug as the main stream).
            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta;
              if (delta?.content || delta?.reasoning_content || delta?.reasoning || delta?.reasoning_text || (delta?.tool_calls && delta.tool_calls.length > 0)) {
                if (ttfbMs === undefined) {
                  ttfbMs = Date.now() - probeStart;
                  clearTimeout(ttfbTimer);
                }
                tokenCount++;
              }
              if (choice.finish_reason) {
                // Only mark success if we actually read some content.
                // A finish_reason with 0 tokens means the provider returned
                // an empty response — not a successful probe.
                if (tokenCount > 0) success = true;
              }
            }
          } catch {
            // Skip malformed JSON.
          }
          if (success) break;
        }
        if (success) break;
        // Abort after enough tokens to measure throughput.
        if (tokenCount >= MAX_PROBE_TOKENS) {
          break;
        }
      }
    } finally {
      clearTimeout(ttfbTimer);
      try { reader.cancel(); } catch { /* already closed */ }
    }

    // If we got TTFB but no usage, estimate completion tokens from what we read.
    if (completionTokens === 0 && tokenCount > 0) {
      completionTokens = tokenCount;
    }
    // If the provider didn't send prompt_tokens in the stream (many only
    // send usage in the final chunk, which we aborted before reaching),
    // use the estimated prompt tokens from the request body so the
    // prefill normalization (ttfbMs / promptTokens) works.
    if (promptTokens === 0) {
      promptTokens = estimatedPromptTokens;
    }

    const elapsed = Date.now() - probeStart;
    // A probe that read 0 tokens (e.g. upstream sent [DONE] or a
    // finish_reason with no content) is NOT successful — there's no TTFB
    // or throughput data to record. Require at least one token read.
    success = tokenCount > 0 && (success || ttfbMs !== undefined);

    logger.info("shadow probe complete", {
      requestId,
      provider: provider.name,
      model,
      ttfbMs,
      tokensRead: tokenCount,
      promptTokens,
      completionTokens,
      elapsed,
      success,
    });

    // Record only prefill (TTFB) data from the probe, not throughput.
    // The probe reads only ~20 tokens — too few for a stable tokensPerSec
    // measurement. Including it would contaminate the throughput EWMA
    // with noisy data (e.g. 10 tok/s from 20 tokens in 2s, when the real
    // rate is 50+ tok/s). Pass completionTokens=0 so the throughput EWMA
    // is skipped (per the failed-request guard), while ttfbMs and
    // promptTokens are still recorded to update the prefill EWMA.
    performanceTracker.record(
      provider.name, success, ttfbMs, promptTokens, 0, elapsed, false,
    );
  } catch (err) {
    const elapsed = Date.now() - probeStart;
    logger.warn("shadow probe failed", {
      requestId,
      provider: provider.name,
      error: err instanceof Error ? err.message : String(err),
      elapsed,
    });
    performanceTracker.record(
      provider.name, false, undefined, 0, 0, elapsed, false,
    );
  }
}

/**
 * Create the HTTP server that handles Connect-RPC streaming inference requests.
 *
 * The {@link ProviderRegistry}, {@link CircuitBreaker}, and
 * {@link SessionAffinity} are constructed once and shared across all requests
 * so provider routing state, circuit state, and session bindings persist for
 * the lifetime of the server.
 */
export function createServer(config: ShimConfig, baseLogger: Logger): http.Server {
  const registry = new ProviderRegistry(
    config.providers.configs,
    config.providers.priority,
    config.routingStrategy,
  );
  const breaker = new CircuitBreaker();
  const sessionAffinity = new SessionAffinity(config.sessionAffinity);

  // Configure per-provider network settings on the circuit breaker so
  // cooldowns and failure thresholds can be tuned independently.
  for (const name of registry.getProviderNames()) {
    const provider = registry.getProvider(name);
    if (provider) {
      breaker.setProviderConfig(name, provider.network);
    }
  }

  // Periodically purge expired session-affinity bindings so the map doesn't
  // grow unboundedly over a long-running server.
  const cleanupHandle = setInterval(
    () => sessionAffinity.cleanup(),
    SESSION_CLEANUP_INTERVAL_MS,
  );
  cleanupHandle.unref();

  // Keep OAuth ("Sign in with ChatGPT") access tokens fresh with a periodic
  // background sweep so request-time refreshes are rare. Refresh failures
  // are logged inside the manager; a failing account gets disabled there.
  const oauthManagers = registry.getAuthManagers();
  let oauthRefreshHandle: ReturnType<typeof setInterval> | undefined;
  if (oauthManagers.length > 0) {
    const sweep = (): void => {
      for (const manager of oauthManagers) {
        void manager.refreshDueAccounts().catch(() => {
          // Errors already surfaced by the manager's logger (if any).
        });
      }
    };
    oauthRefreshHandle = setInterval(sweep, OAUTH_REFRESH_INTERVAL_MS);
    oauthRefreshHandle.unref();
    sweep();
  }

  // Periodically log per-provider metrics (requests, error rate, latency
  // histogram, TTFB). Uses the same interval as session cleanup.
  const metricsHandle = setInterval(
    () => {
      metrics.logSummary(baseLogger);
      // Log performance scores for latency-based routing.
      const perf = performanceTracker.snapshot();
      for (const [provider, p] of Object.entries(perf)) {
        baseLogger.info("provider performance", { provider, ...p });
      }
    },
    SESSION_CLEANUP_INTERVAL_MS,
  );
  metricsHandle.unref();

  const server = http.createServer(async (req, res) => {
    // Only the streaming inference path is supported.
    if (req.method !== "POST" || req.url !== STREAM_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    const requestStart = Date.now();

    // Generate a request ID and create a scoped logger that injects it into
    // every log line. Shadowing the outer `logger` means all existing call
    // sites automatically include the request ID without any changes.
    const requestId = generateRequestId();
    const logger = createRequestScopedLogger(baseLogger, requestId);

    // Reject binary protobuf Connect requests early. The shim only speaks
    // Connect+JSON (useBinaryFormat: false in the patched host). If the client
    // sends application/connect+proto, the envelope parses but JSON.parse on
    // the protobuf payload fails with a cryptic "Unexpected token" error.
    // Detecting the Content-Type here lets us return a clear error instead.
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("proto") && !contentType.includes("json")) {
      logger.warn("rejected binary protobuf request", { contentType });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame(
        "binary protobuf not supported; ensure useBinaryFormat: false in the Connect transport",
      ));
      endStream(res);
      return;
    }

    // Track client disconnects so the upstream stream can be aborted early
    // (instead of continuing to fetch and process chunks that will never be
    // delivered). `res.on('close')` fires when the response connection is
    // closed — including mid-stream client disconnects. The flag is checked
    // in the SSE read loop and the abort function is called to cancel the
    // upstream reader, freeing provider quota that would otherwise be wasted.
    let clientDisconnected = false;
    let abortUpstream: (() => void) | null = null;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        if (abortUpstream) {
          try { abortUpstream(); } catch { /* already closed */ }
        }
        logger.info("client disconnected", {
          requestId,
          elapsed: Date.now() - requestStart,
        });
      }
    });

    // ---------------------------------------------------------------------
    // 1. Read the full request body.
    // ---------------------------------------------------------------------
    let body: Buffer;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      body = Buffer.concat(chunks);
    } catch (err) {
      // Client-side issue (network error reading the request body) — not a
      // provider health problem. Logged at warn (not error) so the health
      // check doesn't count it as a provider failure and trigger a false
      // CRITICAL / auto-deploy.
      logger.warn("failed to read request body", { error: err });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame("failed to read request body"));
      endStream(res);
      return;
    }

    // ---------------------------------------------------------------------
    // 2-4. Parse Connect envelopes, extract the data frame, convert to OpenAI.
    // ---------------------------------------------------------------------
    let openaiBody: OpenAIChatRequest;
    let rawModelId: string;
    let sessionId: string | null = null;
    let estimatedInputTokens = 0;
    try {
      const envelopes: ConnectEnvelope[] = parseEnvelopes(body);
      const dataEnvelope = envelopes.find((env) => (env.flags & 0x02) === 0);
      if (!dataEnvelope) {
        throw new Error("no data envelope in Connect request");
      }
      const reqJson = JSON.parse(
        dataEnvelope.data.toString("utf8"),
      ) as InferenceStreamRequest;

      rawModelId =
        reqJson.requestedModel?.modelId ??
        reqJson.requestedModel?.model_id ??
        reqJson.modelId ??
        reqJson.model_id ??
        "";

      sessionId = sessionAffinity.extractSessionId(reqJson);

      openaiBody = convertRequest(reqJson);

      // Estimate input tokens for provider routing. The exact count depends
      // on the model's tokenizer, but this rough estimate (4 chars/token) is
      // good enough for comparing prefill costs across providers.
      estimatedInputTokens = Math.ceil(
        JSON.stringify(openaiBody.messages ?? []).length / 4,
      );
    } catch (err) {
      // Client-side issue (malformed Connect envelope, wrong content type
      // like protobuf, or invalid JSON) — not a provider health problem.
      // Logged at warn (not error) so the health check doesn't count it as
      // a provider failure and trigger a false CRITICAL / auto-deploy.
      //
      // Log a hex preview of the first 32 bytes instead of the raw body:
      // the raw body may contain the full system prompt / user message
      // (privacy concern), and for binary payloads (e.g. protobuf) the
      // UTF-8 dump is garbled and unhelpful. The hex preview is enough to
      // diagnose content-type mismatches (e.g. protobuf vs JSON).
      logger.warn("failed to parse request", {
        error: err,
        bodyLength: body.length,
        bodyPreview: body.subarray(0, 32).toString("hex"),
      });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame("failed to parse request"));
      endStream(res);
      return;
    }

    // Capture the request body for debugging (opt-in via CAPTURE_BODIES=true).
    captureRequestBody(logger, requestId, openaiBody);

    // Dump tool schemas to disk when logDir is set — useful for debugging
    // schema mapping issues before translation.
    if (config.logDir && (openaiBody.tools ?? []).length > 0) {
      fs.writeFile(
        path.join(config.logDir, `shim-tools-${Date.now()}.json`),
        JSON.stringify(openaiBody.tools, null, 2),
      ).catch(() => {
        // best-effort — don't fail the request if the dump fails
      });
    }

    // ---------------------------------------------------------------------
    // 5-6. Resolve provider (honoring session affinity) and build the
    //      failover chain.
    // ---------------------------------------------------------------------
    let { provider: resolvedPrimary, normalizedId } =
      registry.resolveProvider(rawModelId, {
        promptTokens: estimatedInputTokens,
        completionTokens: openaiBody.max_tokens,
      });

    // Vision fallback: if the request contains images and the resolved
    // model doesn't support vision, re-route to VISION_FALLBACK_MODEL
    // (if configured) instead of stripping the images.
    if (config.visionFallbackModel && requestHasImages(openaiBody)) {
      const resolvedModel = resolvedPrimary.resolveModel(normalizedId);
      if (!detectSupportsImagesForModel(resolvedPrimary, resolvedModel)) {
        logger.info("vision fallback: re-routing to vision model", {
          originalModel: rawModelId,
          originalProvider: resolvedPrimary.name,
          visionFallbackModel: config.visionFallbackModel,
        });
        const visionResolved = registry.resolveProvider(config.visionFallbackModel, {
          promptTokens: estimatedInputTokens,
          completionTokens: openaiBody.max_tokens,
        });
        rawModelId = config.visionFallbackModel;
        normalizedId = visionResolved.normalizedId;
        resolvedPrimary = visionResolved.provider;
      }
    }

    let primary = resolvedPrimary;

    if (sessionAffinity.isEnabled() && sessionId) {
      const boundName = sessionAffinity.getBinding(sessionId);
      if (boundName) {
        const bound = registry.getProvider(boundName);
        if (bound && bound.canHandle(normalizedId) && breaker.shouldTry(bound.name)) {
          primary = bound;
          logger.info("session affinity hit", {
            sessionId,
            provider: bound.name,
          });
        } else if (bound) {
          // Binding exists but the bound provider can't be used — either it
          // can't handle this model (model changed mid-conversation) or its
          // circuit is open. Fall back to the resolved primary; the binding
          // will be refreshed on the next successful request.
          logger.info("session affinity skipped", {
            sessionId,
            boundProvider: bound.name,
            resolvedProvider: resolvedPrimary.name,
            model: rawModelId,
            reason: !bound.canHandle(normalizedId)
              ? "model-mismatch"
              : "circuit-open",
          });
        }
      } else {
        logger.info("session affinity miss", { sessionId });
      }
    }

    const failoverChain = registry.getFailoverChain(
      primary,
      config.failover,
      normalizedId,
    );

    logger.info("routing request", {
      model: rawModelId,
      provider: primary.name,
      routingStrategy: config.routingStrategy,
      failoverChain: failoverChain.map((p) => p.name),
      sessionId: sessionId ?? undefined,
    });

    // ---------------------------------------------------------------------
    // 6b. Token budget guardrail: pre-flight check that estimated input +
    //     requested output fits within REQUEST_MAX_TOKENS_BUDGET (env, 0=off).
    //     Rejects oversized requests before any provider is tried, and caps
    //     max_tokens when the client didn't specify one.
    // ---------------------------------------------------------------------
    const budgetResult = applyTokenBudget(estimatedInputTokens, openaiBody.max_tokens);
    if (budgetResult.rejection) {
      logger.warn("token budget exceeded", {
        model: rawModelId,
        budget: budgetResult.rejection.budget,
        estimatedTotal: budgetResult.rejection.estimatedTotal,
      });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame(tokenBudgetMessage(budgetResult.rejection)));
      endStream(res);
      return;
    }
    if (budgetResult.maxTokens !== openaiBody.max_tokens) {
      openaiBody.max_tokens = budgetResult.maxTokens;
    }

    // Snapshot the request body AFTER the token budget cap but BEFORE the
    // provider loop. applyCompatToRequest mutates openaiBody in place
    // (coalescing system messages, converting max_tokens ↔ max_completion_tokens,
    // stripping images for non-vision providers). Without a snapshot, the
    // mutations from one provider bleed into the next on failover — e.g.
    // images stripped for a non-vision provider 1 are lost forever even if
    // provider 2 supports vision. The snapshot is restored at the top of
    // each provider iteration so every provider sees the same clean request.
    const openaiBodySnapshot = JSON.parse(JSON.stringify(openaiBody)) as typeof openaiBody;

    // Per-request consecutive-failure breaker: bounds the total wasted
    // attempts across the whole chain (env: MAX_CONSECUTIVE_UPSTREAM_FAILS,
    // 0 = disabled). When the Nth consecutive fail happens, stop with 503
    // instead of grinding through every remaining provider.
    const consecBreaker = newBreaker();

    // ---------------------------------------------------------------------
    // 7-8. Try each provider in the failover chain until one accepts,
    //      retrying within a provider with backoff and key rotation.
    //      Each attempt is traced for observability (provider, model, outcome,
    //      duration, error summary) so the failover trail is durable.
    // ---------------------------------------------------------------------
    const trace = newRequestTrace();
    let attemptOrdinal = 0;
    const requestStartTime = Date.now();

    // Track every provider that was tried during the connection phase so
    // the empty-completion failover loop (section 10b) doesn't re-try
    // providers that already failed with auth/rate-limit/server errors.
    const connectionTriedProviders = new Set<string>();

    function recordAttempt(
      providerName: string,
      modelId: string,
      outcome: AttemptOutcome,
      startMs: number,
      err?: unknown,
      keyOrdinal: number = 0,
    ): void {
      trace.records.push({
        ordinal: attemptOrdinal++,
        platform: providerName,
        modelId,
        keyOrdinal,
        outcome,
        startOffsetMs: startMs - requestStartTime,
        durationMs: Date.now() - startMs,
        errorSummary: err ? sanitizeProviderErrorMessage(err) : null,
      });
    }
    let connected:
      | {
          resp: Response;
          providerName: string;
          model: string;
          key: KeyInfo;
          network: NetworkConfig;
          baseUrl: string;
          compat: ProviderCompat;
          connectionStartMs: number;
          providerRef: Provider;
        }
      | undefined;
    let requestErrorMessage: string | null = null;

    providerLoop: for (const provider of failoverChain) {
      // If the client disconnected during a previous provider's attempt
      // (or while reading the request body), stop immediately — there's
      // no point trying more providers since no one is listening.
      if (clientDisconnected) {
        logger.info("client disconnected before provider attempt, stopping", {
          provider: provider.name,
          elapsed: Date.now() - requestStart,
        });
        break;
      }
      if (!breaker.shouldTry(provider.name)) {
        logger.warn("provider circuit open, skipping", {
          provider: provider.name,
          model: rawModelId,
        });
        continue;
      }

      // Record this provider as tried in the connection phase so the
      // empty-completion failover loop doesn't re-try it.
      connectionTriedProviders.add(provider.name);

      // Reset per-request key-failure state so a 401 on a key in a
      // previous request doesn't permanently remove it from rotation.
      provider.resetKeyFailures();

      // Restore the request body snapshot so compat mutations from the
      // previous provider (image stripping, system message coalescing,
      // max_tokens field conversion) don't bleed into this provider.
      // Deep-clone the snapshot so the snapshot itself stays pristine for
      // the next failover iteration.
      openaiBody = JSON.parse(JSON.stringify(openaiBodySnapshot)) as typeof openaiBody;

      // Re-resolve the model for this specific provider.
      const model = provider.resolveModel(normalizedId);
      openaiBody.model = model;

      // Apply provider-specific compat flags to the request body (e.g.
      // coalescing multiple system messages, setting the right max_tokens
      // field name, adding "." for empty assistant tool-call content).
      // Pass the actual model id so vision support is checked per-model,
      // not just per-provider-default-model.
      applyCompatToRequest(openaiBody, provider.compat, model, provider.name, provider.baseUrl);

      const maxRetries = provider.network.maxRetries ?? 0;
      const backoffInitialMs =
        provider.network.retryBackoffInitialMs ?? DEFAULT_RETRY_BACKOFF_INITIAL_MS;
      const backoffMaxMs =
        provider.network.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;
      const requestTimeoutMs = adaptiveRequestTimeoutMs(
        provider.network.requestTimeoutMs ?? config.requestTimeoutMs,
        openaiBody,
      );

      let authRotations = 0;
      // Accounts already force-refreshed during this request (OAuth 401
      // recovery — one refresh attempt per account, then rotate away).
      const oauthRefreshedAccounts = new Set<string>();
      // Sticky key: set when an OAuth refresh succeeded so the immediate
      // retry reuses the SAME account with its fresh token instead of the
      // round-robin cursor rotating to the next one.
      let stickyKey: KeyInfo | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const key = stickyKey ?? provider.selectKey();
        stickyKey = undefined;
        const keyOrdinal = provider.keys.indexOf(key);

        const attemptStart = Date.now();
        try {
          const resp = await fetchCompletion(provider, openaiBody, key, requestTimeoutMs);

          if (resp.ok && resp.body) {
            breaker.recordSuccess(provider.name);
            if (sessionAffinity.isEnabled() && sessionId) {
              sessionAffinity.bind(sessionId, provider.name);
            }
            logger.info("upstream connected", {
              model,
              provider: provider.name,
              status: resp.status,
              key: maskKey(key.value),
              attempt,
              elapsed: Date.now() - attemptStart,
            });
            connected = {
              resp,
              providerName: provider.name,
              model,
              key,
              network: provider.network,
              baseUrl: provider.baseUrl,
              compat: provider.compat,
              connectionStartMs: attemptStart,
              providerRef: provider,
            };
            recordAttempt(provider.name, model, "ok", attemptStart, undefined, keyOrdinal);
            resetBreaker(consecBreaker);
            break providerLoop;
          }

          // Non-2xx: read the body first, then classify using both the
          // status code AND the body text for richer sub-category detection
          // (context-too-large, content-blocked, model-not-found, etc.).
          let errText = "";
          try {
            errText = await resp.text();
          } catch {
            // ignore body read failure
          }
          const errorType = breaker.classifyErrorFromResponse(resp.status, errText);

          // Auth error: rotate to the next key and retry within this provider.
          // Key rotation does NOT consume a retry attempt — retries are for
          // transient errors (429/5xx). We track auth rotations separately
          // and bail out when every key has been tried with an auth error.
          if (errorType === "auth-error") {
            // OAuth providers: a 401 usually means the cached access token
            // was revoked or expired server-side ahead of schedule. Try one
            // forced token refresh for this account before rotating away;
            // on success retry the SAME account with its fresh token.
            if (
              provider.authManager &&
              key.value &&
              !oauthRefreshedAccounts.has(key.value)
            ) {
              oauthRefreshedAccounts.add(key.value);
              const refreshed = await provider.authManager
                .forceRefresh(key.value)
                .catch(() => false);
              if (refreshed) {
                logger.info("oauth token refreshed after auth error, retrying account", {
                  model,
                  provider: provider.name,
                  account: maskKey(key.value),
                  elapsed: Date.now() - attemptStart,
                });
                stickyKey = key;
                // Don't consume a retry attempt for the refresh retry.
                attempt--;
                continue;
              }
            }
            provider.markKeyFailed(key);
            authRotations++;
            logger.warn("auth error, rotating key", {
              model,
              provider: provider.name,
              status: resp.status,
              key: maskKey(key.value),
              attempt,
              authRotations,
              elapsed: Date.now() - attemptStart,
              error: errText.slice(0, 500),
            });
            if (authRotations >= provider.keys.length) {
              // All keys tried with auth errors — failover to next provider.
              logger.warn("all keys exhausted with auth errors", {
                model,
                provider: provider.name,
                keyCount: provider.keys.length,
              });
              recordAttempt(provider.name, model, "auth", attemptStart, "all keys exhausted with auth errors", keyOrdinal);
              metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
              breaker.recordAuthExhaustion(provider.name);
              break;
            }
            // Don't consume a retry attempt for key rotation.
            attempt--;
            continue;
          }

          // Request error (400/404): the request is malformed and will fail
          // on every provider — stop immediately.
          if (errorType === "request-error") {
            logger.warn("request error, stopping", {
              model,
              provider: provider.name,
              status: resp.status,
              elapsed: Date.now() - attemptStart,
              error: errText.slice(0, 500),
            });
            recordAttempt(provider.name, model, "provider_bad_request", attemptStart, errText, keyOrdinal);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            requestErrorMessage = "request rejected by provider";
            break providerLoop;
          }

          // Rate-limit / server-error / network-error: record against the
          // circuit and decide whether to retry or fail over.
          breaker.recordFailure(provider.name, errorType);
          logger.warn("upstream non-2xx", {
            model,
            provider: provider.name,
            status: resp.status,
            errorType,
            attempt,
            elapsed: Date.now() - attemptStart,
            error: errText.slice(0, 500),
          });

          const decision = shouldRetry(errorType, attempt, maxRetries);
          if (decision === "retry") {
            const backoff = computeRateLimitBackoff(errorType, errText) ??
              computeBackoff(attempt, backoffInitialMs, backoffMaxMs);
            if (backoff > RATE_LIMIT_FAILOVER_CAP_MS) {
              // Quota-class backoffs (30min) are longer than any client should
              // wait inside one request — fail over now; the breaker cooldown
              // keeps this provider out of rotation for a while.
              logger.warn("rate-limit backoff exceeds failover cap, moving to next provider", {
                model,
                provider: provider.name,
                recommendedBackoffMs: backoff,
                capMs: RATE_LIMIT_FAILOVER_CAP_MS,
                attempt,
              });
              recordAttempt(provider.name, model, "rate_limited", attemptStart, errText, keyOrdinal);
              metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
              break;
            }
            logger.info("retrying after backoff", {
              model,
              provider: provider.name,
              attempt,
              backoff,
              errorType,
            });
            await sleep(backoff);
            continue;
          } else if (decision === "failover") {
            recordAttempt(provider.name, model, errorType === "rate-limit" ? "rate_limited" : "upstream_error", attemptStart, errText, keyOrdinal);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            if (recordBreakerFailure(consecBreaker)) {
              logger.warn("consecutive failure breaker tripped", {
                model: rawModelId,
                consecutive: consecBreaker.consecutive,
                limit: consecBreaker.limit,
              });
              requestErrorMessage = "too many consecutive failures";
              break providerLoop;
            }
            break;
          } else {
            // "stop" — should not occur for non-request errors, but handle it.
            recordAttempt(provider.name, model, "upstream_error", attemptStart, errText, keyOrdinal);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            requestErrorMessage = "upstream error";
            break providerLoop;
          }
        } catch (err) {
          const isAbort = err instanceof Error && err.name === "AbortError";
          const errorType: ErrorType = "network-error";
          breaker.recordFailure(provider.name, errorType);
          logger.warn("upstream fetch failed", {
            model,
            provider: provider.name,
            attempt,
            elapsed: Date.now() - attemptStart,
            error: err,
          });

          const decision = shouldRetry(errorType, attempt, maxRetries);
          if (decision === "retry") {
            const backoff = computeRateLimitBackoff(errorType, err instanceof Error ? err.message : String(err)) ??
              computeBackoff(attempt, backoffInitialMs, backoffMaxMs);
            logger.info("retrying after backoff", {
              model,
              provider: provider.name,
              attempt,
              backoff,
              errorType,
            });
            await sleep(backoff);
            continue;
          } else if (decision === "failover") {
            recordAttempt(provider.name, model, isAbort ? "timeout" : "upstream_error", attemptStart, err, keyOrdinal);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            if (recordBreakerFailure(consecBreaker)) {
              logger.warn("consecutive failure breaker tripped", {
                model: rawModelId,
                consecutive: consecBreaker.consecutive,
                limit: consecBreaker.limit,
              });
              requestErrorMessage = "too many consecutive failures";
              break providerLoop;
            }
            break;
          } else {
            recordAttempt(provider.name, model, isAbort ? "timeout" : "upstream_error", attemptStart, err, keyOrdinal);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            requestErrorMessage = isAbort ? "request timeout" : "upstream error";
            break providerLoop;
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // Request-level error: the provider rejected the request or the
    // consecutive-failure breaker tripped. Emit the specific error and stop.
    // ---------------------------------------------------------------------
    if (requestErrorMessage) {
      // Log the attempt trail even on request errors — the consecutive
      // breaker may have tripped after multiple provider failures.
      if (trace.records.length > 0) {
        logger.warn("failover trail", {
          model: rawModelId,
          trail: trace.records.map((r) => ({
            ordinal: r.ordinal,
            provider: r.platform,
            model: r.modelId,
            outcome: r.outcome,
            durationMs: r.durationMs,
            error: r.errorSummary,
          })),
        });
      }
      logger.error("request failed", {
        model: rawModelId,
        message: requestErrorMessage,
        elapsed: Date.now() - requestStart,
      });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame(requestErrorMessage));
      endStream(res);
      return;
    }

    // ---------------------------------------------------------------------
    // 9. All providers failed: emit an error and end the stream.
    // ---------------------------------------------------------------------
    if (!connected) {
      // Log the attempt trail for observability: which providers were tried,
      // what errors they returned, and how long each took.
      if (trace.records.length > 0) {
        logger.warn("failover trail", {
          model: rawModelId,
          trail: trace.records.map((r) => ({
            ordinal: r.ordinal,
            provider: r.platform,
            model: r.modelId,
            outcome: r.outcome,
            durationMs: r.durationMs,
            error: r.errorSummary,
          })),
        });
      }
      logger.error("all providers failed", {
        model: rawModelId,
        failoverChain: failoverChain.map((p) => p.name),
        elapsed: Date.now() - requestStart,
      });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame("all providers failed"));
      endStream(res);
      return;
    }

    // ---------------------------------------------------------------------
    // 10. A provider accepted: attempt the stream with empty-completion
    //     retry. Frames are buffered per attempt; only a non-empty attempt
    //     (or the last attempt if all are empty) is flushed to the response.
    //
    //     These variables are mutable so the cross-provider failover loop
    //     (section 10b) can reassign them when switching to a different
    //     provider on empty completion or TTFB timeout. The attemptStream
    //     closure references them by name, so reassignment here is visible
    //     inside attemptStream on the next call.
    // ---------------------------------------------------------------------
    let { resp: firstResp, providerName, model, key, network, baseUrl, compat, connectionStartMs, providerRef } =
      connected;
    // The provider object the current attempt targets (mutable across the
    // cross-provider failover loop below so the retry fetch picks up the
    // right dialect/auth for whichever provider is serving the attempt).
    let currentProvider = providerRef;
    let requestTimeoutMs = adaptiveRequestTimeoutMs(
      network.requestTimeoutMs ?? config.requestTimeoutMs,
      openaiBody,
    );

    // -----------------------------------------------------------------
    // 10a. Shadow probe: every Nth request, fire a concurrent fetch to
    //      the second-best provider to calibrate performance scores with
    //      true apples-to-apples data (same request, same prompt). The
    //      probe runs in the background and does NOT affect the client's
    //      response. It reads ~20 tokens then aborts to minimize wasted
    //      provider quota.
    // -----------------------------------------------------------------
    if (SHADOW_PROBE_INTERVAL > 0 && (++requestCounter % SHADOW_PROBE_INTERVAL === 0)) {
      // Find the second-best provider (next in failover chain that isn't
      // the primary and hasn't been tried yet in the connection phase).
      const shadowProvider = failoverChain.find(
        (p) => p.name !== providerName && breaker.shouldTry(p.name),
      );
      if (shadowProvider) {
        const shadowModel = shadowProvider.resolveModel(normalizedId);
        // Fire-and-forget: the probe runs concurrently with the primary
        // stream. Errors are logged but never affect the client response.
        shadowProbe(shadowProvider, shadowModel, openaiBodySnapshot, logger, requestId).catch(
          (err) => logger.warn("shadow probe unhandled rejection", { requestId, error: err }),
        );
      }
    }

    const EMPTY_COMPLETION_BASE_DELAY_MS = 500;
    const POST_FINISH_GRACE_MS = 2000;
    const MAX_TOOL_CALLS_PER_RESPONSE = 20;

    interface AttemptResult {
      frames: InferenceStreamResponse[];
      hasVisibleContent: boolean;
      sawFinish: boolean;
      streamError: boolean;
      ttfbTimedOut: boolean;
      idleTimedOut: boolean;
      fetchFailed: boolean;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number | undefined;
      reasoningTokens: number | undefined;
      cachedTokens: number | undefined;
      cacheWriteTokens: number | undefined;
      toolCallCount: number;
    }

    const attemptStream = async (
      existingResp: Response | undefined,
      existingConnectionStartMs?: number,
    ): Promise<AttemptResult> => {
      // Stream-local start time: measures only this attempt's duration,
      // excluding time spent on previous providers' failed attempts and
      // the backoff sleep between retries. Used for TTFB and stream
      // duration measurements so the performance tracker gets accurate
      // per-provider latency, not inflated by prior attempt overhead.
      //
      // When existingResp is provided (first attempt), the fetch already
      // completed in the connection phase. Using Date.now() here would
      // exclude the connection/prefill time from TTFB, making providers
      // that do prefill before sending headers (e.g. opencode-go with
      // ttfb=0-2ms) look artificially fast. Instead, use the connection
      // attempt start time so TTFB includes the full prefill duration.
      // For retry attempts (no existingResp), the fetch happens inside
      // attemptStream, so Date.now() is the correct baseline.
      const streamStartMs = existingConnectionStartMs ?? Date.now();
      const frames: InferenceStreamResponse[] = [];
      const responseId = `chatcmpl-shim-${Date.now().toString(36)}`;
      frames.push(makeResponseInfoFrame(responseId, model));

      const sseParser = new SseParser();
      const toolAcc = new ToolCallAccumulator();
      toolAcc.setTools(openaiBody.tools);
      const thinkFilter = new ThinkTagStreamFilter();
      const decoder = new TextDecoder();

      // Streaming markup healer for providers that leak chat-template
      // tool-call markup (Kimi <|tool_call_begin|>, DeepSeek DSML envelopes,
      // Qwen <tool_calls> XML) into visible `content`. When active it
      // replaces both the think-tags filter and the dialect hold-window for
      // content processing, because it handles thinking extraction AND
      // tool-call reconstruction in one streaming pass. When undefined the
      // existing thinkFilter + dialect hold-window path is used.
      const healingPattern = compat.streamMarkupHealingPattern;
      // Mutable: may be auto-created mid-stream when a dialect marker is
      // detected in the content (automatic tool-call healing). When the
      // compat flag pre-configures a pattern, the healer starts active;
      // otherwise it starts undefined and is created on-the-fly if a
      // marker appears.
      let markupHealer = healingPattern
        ? new StreamMarkupHealing({ pattern: healingPattern })
        : undefined;

      // Streaming hold-window for inline tool-call dialect detection. When
      // the request declares tools, text deltas are buffered while they could
      // still be a dialect marker (Kimi/DeepSeek tokens, Llama <function=>,
      // Qwen XML). Once the buffer diverges from all markers (or exceeds 256
      // bytes), it's flushed as content. At stream end, a dialect buffer is
      // rescued into structured tool calls.
      const wantsTools = (openaiBody.tools ?? []).length > 0;
      let heldText = "";
      let dialectMode: "hold" | "dialect" | "passthrough" = wantsTools ? "hold" : "passthrough";

      let sawFinish = false;
      let streamError = false;
      let hasVisibleContent = false;
      let promptTokens = 0;
      let completionTokens = 0;
      // Time to first token (TTFB): timestamp of the first content/reasoning
      // delta. Key latency metric — measures provider prefill + network.
      let ttfbMs: number | undefined;
      // TTFB timeout: if no first token arrives within this window, abort the
      // stream so the caller can failover to the next provider. Unlike the
      // idle timeout (which fires between tokens), this fires only once —
      // before the first token is seen.
      let ttfbTimedOut = false;
      let idleTimedOut = false;
      let fetchFailed = false;
      let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
      const ttfbTimeoutMs = adaptiveTtfbTimeoutMs(
        network.ttfbTimeoutMs ?? DEFAULT_TTFB_TIMEOUT_MS,
        openaiBody,
      );
      let totalTokens: number | undefined;
      let reasoningTokens: number | undefined;
      let cachedTokens: number | undefined;
      let cacheWriteTokens: number | undefined;
      // Set to true once the stream has ended (normally or on error) so a
      // late-firing idle-timeout callback doesn't flip streamError after the
      // finally block has already committed the success path. The stream-timeout
      // guard's clear() cancels a pending timer, but a timer that has already
      // fired (callback queued behind the finally block) would still run; this
      // flag makes the callback a no-op in that race window.
      let streamClosed = false;
      let graceStarted = false;

      // The reader is assigned inside the try block; the timeout callback
      // references it via this outer variable so it can cancel a stalled stream.
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      const onTimeout = (): void => {
        // Ignore a timeout that fires after the stream has already closed
        // (e.g. the timer fired but its callback was queued behind the
        // finally block's streamClosed/clear()).
        if (streamClosed) {
          return;
        }
        // Post-finish grace timeout: the stream already completed
        // successfully (sawFinish) and we were just waiting for any
        // trailing usage-only chunks. Firing here is expected cleanup,
        // not an error, so don't flip streamError/idleTimedOut (which
        // would trigger failover) — just cancel the reader and log at
        // info level.
        if (graceStarted) {
          logger.info("stream grace timeout", {
            model,
            provider: providerName,
            elapsed: Date.now() - requestStart,
          });
          void reader?.cancel().catch(() => {
            // ignore cancel rejection
          });
          return;
        }
        streamError = true;
        idleTimedOut = true;
        logger.error("stream idle timeout", {
          model,
          provider: providerName,
          elapsed: Date.now() - requestStart,
        });
        void reader?.cancel().catch(() => {
          // ignore cancel rejection
        });
      };

      let streamTimeout = createStreamTimeout(
        network.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        onTimeout,
      );

      const processData = (data: string): void => {
        if (data === "[DONE]") {
          sawFinish = true;
          return;
        }

        let chunk: OpenAISSEChunk;
        try {
          chunk = JSON.parse(data) as OpenAISSEChunk;
        } catch {
          // Skip malformed JSON payloads.
          return;
        }

        // Extract usage data BEFORE the empty-choices skip below: some
        // providers (e.g. opencode-go's glm-5.2) send the usage in a
        // separate chunk with an empty choices array, and we must not
        // lose those token counts.
        const extracted = extractUsage(chunk);
        if (extracted) {
          // Use || for prompt/completion tokens: extractUsage always returns
          // numbers (via safeTokenCount), so ?? never falls through. A
          // provider that sends multiple usage chunks may omit prompt_tokens
          // or completion_tokens in a later chunk; extractUsage defaults the
          // missing field to 0, which would overwrite a previously correct
          // non-zero value. || keeps the prior value when the new one is 0
          // (i.e. not reported by this chunk). 0 prompt tokens is never
          // valid (there is always a prompt), and a 0 in a later completion
          // count means "not reported", not "0 completion".
          //
          // The optional detail fields (totalTokens, reasoningTokens,
          // cachedTokens, cacheWriteTokens) keep ??: 0 is a valid value for
          // them (no reasoning, no cache hit, etc.), and ?? preserves the
          // existing behavior of including them in the usage frame as 0
          // when the provider reports a usage block without them.
          promptTokens = extracted.promptTokens || promptTokens;
          completionTokens = extracted.completionTokens || completionTokens;
          totalTokens = extracted.totalTokens ?? totalTokens;
          reasoningTokens = extracted.reasoningTokens ?? reasoningTokens;
          cachedTokens = extracted.cachedTokens ?? cachedTokens;
          cacheWriteTokens = extracted.cacheWriteTokens ?? cacheWriteTokens;
        }

        // Some providers (e.g. opencode-go) send a trailing cost-annotation
        // frame after [DONE] with an empty choices array: {"choices":[],"cost":"0"}.
        // There's nothing to translate from it; skip early to avoid no-op work.
        // (Usage was already extracted above, so a usage-only empty-choices
        // chunk is safely handled before this point.)
        if (chunk.choices && chunk.choices.length === 0) {
          return;
        }

        // Feed the whole chunk; the accumulator skips choices without tool_calls.
        toolAcc.feed(chunk);

        // Tool calls count as first-token content for TTFB purposes. Without
        // this, a tool-call-only response (no text/reasoning deltas) would
        // never set ttfbMs, leaving the TTFB timer running for the entire
        // stream. If the stream exceeded the TTFB timeout, it would be
        // incorrectly aborted even though the provider was actively sending
        // tool-call deltas. Observed in production: 25/30 requests had
        // ttfb=undefined because they were tool-call-only responses.
        if (ttfbMs === undefined && toolAcc.size > 0) {
          ttfbMs = Date.now() - streamStartMs;
          if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = undefined; }
        }

        for (const choice of chunk.choices ?? []) {
          // Forward reasoning content (chain-of-thought) as text frames so the
          // host sees the model's reasoning alongside the final answer. Some
          // OpenAI-compatible providers stream reasoning under different field
          // names: reasoning_content (llama.cpp/Z.AI), reasoning (OpenRouter),
          // reasoning_text (other compat endpoints). Pick the first non-empty
          // alias to avoid duplication when a chunk carries multiple.
          const delta = choice.delta;
          if (delta) {
            const reasoningText =
              delta.reasoning_content ||
              delta.reasoning ||
              delta.reasoning_text ||
              "";
            if (reasoningText) {
              if (ttfbMs === undefined) {
                ttfbMs = Date.now() - streamStartMs;
                if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = undefined; }
              }
              frames.push(makeTextFrame(reasoningText, false));
              if (reasoningText.length > 0) {
                hasVisibleContent = true;
              }
            }
            if (delta.content) {
              if (ttfbMs === undefined) {
                ttfbMs = Date.now() - streamStartMs;
                if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = undefined; }
              }
              if (markupHealer) {
                // Provider leaks chat-template markup into content — route
                // through the streaming markup healer, which strips tool-call
                // dialect (Kimi/DeepSeek/Qwen) and thinking tags in one pass,
                // reconstructing structured tool calls from the markup.
                const events = delta.tool_calls && delta.tool_calls.length > 0
                  ? markupHealer.feedEventsWithoutCalls(delta.content)
                  : markupHealer.feedEvents(delta.content);
                for (const event of events) {
                  if (event.type === "text") {
                    if (event.text.length > 0) {
                      frames.push(makeTextFrame(event.text, false));
                    }
                  } else if (event.type === "thinking") {
                    if (event.thinking.length > 0) {
                      frames.push(makeTextFrame(event.thinking, false));
                    }
                  } else if (event.type === "toolCall") {
                    frames.push(
                      makeToolCallFrame(event.call.id, event.call.name, event.call.arguments, false),
                    );
                  }
                }
              } else {
                // DeepSeek-style models serialize reasoning INTO content as
                // ​​ blocks. Split them back out into reasoning
                // vs content via the stateful stream filter (handles tag splits
                // across chunk boundaries without buffering the whole stream).
                const split = thinkFilter.push(delta.content);
                if (split.reasoning) {
                  frames.push(makeTextFrame(split.reasoning, false));
                }
                // Feed the content split through the dialect hold-window: if
                // the request has tools, buffer text while it could still be
                // an inline tool-call dialect marker. Once it diverges, flush.
                const textToEmit = split.content;
                if (textToEmit.length > 0) {
                  if (dialectMode === "passthrough") {
                    frames.push(makeTextFrame(textToEmit, false));
                  } else {
                    heldText += textToEmit;
                    const probe = heldText.trimStart();
                    if (startsWithDialectMarker(probe)) {
                      // Automatic tool-call healing: the held text starts with
                      // a known dialect marker. If it matches a pattern the
                      // StreamMarkupHealing supports (Kimi/DeepSeek/Qwen),
                      // create a healer on-the-fly and feed the held text
                      // through it. This gives streaming tool-call
                      // reconstruction for ANY provider, not just pre-
                      // configured ones. Llama <function=> tags (no matching
                      // pattern) fall through to the post-hoc rescue path.
                      const autoPattern = detectHealingPatternFromText(heldText);
                      if (autoPattern) {
                        markupHealer = new StreamMarkupHealing({ pattern: autoPattern });
                        const hasStructuredToolCalls = delta.tool_calls && delta.tool_calls.length > 0;
                        const events = hasStructuredToolCalls
                          ? markupHealer.feedEventsWithoutCalls(heldText)
                          : markupHealer.feedEvents(heldText);
                        for (const event of events) {
                          if (event.type === "text" && event.text.length > 0) {
                            frames.push(makeTextFrame(event.text, false));
                          } else if (event.type === "thinking" && event.thinking.length > 0) {
                            frames.push(makeTextFrame(event.thinking, false));
                          } else if (event.type === "toolCall") {
                            frames.push(
                              makeToolCallFrame(event.call.id, event.call.name, event.call.arguments, false),
                            );
                          }
                        }
                        heldText = "";
                        dialectMode = "passthrough";
                      } else {
                        dialectMode = "dialect";
                      }
                    } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
                      dialectMode = "passthrough";
                      frames.push(makeTextFrame(heldText, false));
                      heldText = "";
                    }
                  }
                }
              }
              if (delta.content.length > 0) {
                hasVisibleContent = true;
              }
            }
          }
          if (choice.finish_reason) {
            sawFinish = true;
          }
        }

        // A tool call with non-empty parsed arguments is meaningful content.
        if (toolAcc.size > 0 && toolAcc.hasVisibleContent()) {
          hasVisibleContent = true;
        }

        // Tool-call loop defense: if the model produces more than
        // MAX_TOOL_CALLS_PER_RESPONSE tool calls with no text content
        // between them, abort the stream to prevent context ballooning.
        if (toolAcc.size > MAX_TOOL_CALLS_PER_RESPONSE && !hasVisibleContent) {
          streamError = true;
          logger.error("tool-call loop detected, aborting stream", {
            model,
            provider: providerName,
            toolCallCount: toolAcc.size,
            elapsed: Date.now() - requestStart,
          });
          void reader?.cancel().catch(() => {
            // ignore cancel rejection
          });
          return;
        }
      };

      let resp = existingResp;
      if (!resp) {
        const retryStartMs = Date.now();
        try {
          resp = await fetchCompletion(currentProvider, openaiBody, key, requestTimeoutMs);
          if (!resp.ok || !resp.body) {
            // If the retry fetch hits an auth error (401/402/403), the
            // provider's credentials are exhausted — open the circuit so
            // the provider isn't tried again on subsequent requests.
            if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
              breaker.recordAuthExhaustion(providerName);
            }
            logger.warn("empty-completion retry fetch failed", {
              model,
              provider: providerName,
              status: resp.status,
              key: maskKey(key.value),
              elapsed: Date.now() - retryStartMs,
              totalElapsed: Date.now() - requestStart,
            });
            frames.push(makeErrorFrame("upstream retry failed"));
            return {
              frames,
              hasVisibleContent: false,
              sawFinish: false,
              streamError: true,
              ttfbTimedOut: false,
              idleTimedOut: false,
              fetchFailed: true,
              promptTokens,
              completionTokens,
              totalTokens,
              reasoningTokens,
              cachedTokens,
              cacheWriteTokens,
              toolCallCount: toolAcc.size,
            };
          }
        } catch (err) {
          logger.warn("empty-completion retry fetch error", {
            model,
            provider: providerName,
            key: maskKey(key.value),
            error: err,
            elapsed: Date.now() - retryStartMs,
            totalElapsed: Date.now() - requestStart,
          });
          frames.push(makeErrorFrame("upstream retry failed"));
          return {
            frames,
            hasVisibleContent: false,
            sawFinish: false,
            streamError: true,
            ttfbTimedOut: false,
            idleTimedOut: false,
            fetchFailed: true,
            promptTokens,
            completionTokens,
            totalTokens,
            reasoningTokens,
            cachedTokens,
            cacheWriteTokens,
            toolCallCount: toolAcc.size,
          };
        }
      }

      try {
        if (!resp.body) {
          throw new Error("upstream response has no body");
        }
        const r = resp.body.getReader();
        reader = r;
        // Wire up the client-disconnect abort: cancel the upstream reader
        // so the provider stream is closed and provider quota is freed.
        abortUpstream = () => {
          try { r.cancel(); } catch { /* already closed */ }
        };
        // If the client already disconnected before we got here, abort now.
        if (clientDisconnected) {
          try { r.cancel(); } catch { /* already closed */ }
        }
        streamTimeout.reset();
        // Start the TTFB timer: if no first token arrives within the
        // timeout, abort the stream so the caller can failover to the
        // next provider instead of waiting indefinitely.
        if (ttfbTimeoutMs > 0 && ttfbMs === undefined) {
          // The adaptive TTFB timeout is meant to cover the full prefill
          // (including connection time). ttfbMs is measured from
          // streamStartMs, so the timer must fire when ttfbMs reaches
          // ttfbTimeoutMs — not ttfbTimeoutMs after the timer is set.
          // Subtract the time already elapsed since streamStartMs (which
          // includes connection time for the first attempt) so the
          // effective timeout is exactly ttfbTimeoutMs. If the connection
          // already exceeded the budget, remainingTimeout is 0 and the
          // timer fires on the next tick to abort immediately.
          const elapsedSinceStart = Date.now() - streamStartMs;
          const remainingTimeout = Math.max(0, ttfbTimeoutMs - elapsedSinceStart);
          ttfbTimer = setTimeout(() => {
            if (streamClosed || ttfbMs !== undefined) return;
            ttfbTimedOut = true;
            streamError = true;
            logger.warn("ttfb timeout, aborting stream for failover", {
              model,
              provider: providerName,
              ttfbTimeoutMs,
              elapsed: Date.now() - requestStart,
            });
            void reader?.cancel().catch(() => { /* ignore */ });
          }, remainingTimeout);
        }
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (clientDisconnected) {
            break;
          }
          const { done, value } = await r.read();
          if (done) {
            break;
          }
          const text = decoder.decode(value, { stream: true });
          sseParser.feed(text);
          const drained = sseParser.drain();
          // Only reset the idle timer when actual SSE `data:` payloads are
          // received, not on every raw byte. Providers (e.g. OpenRouter) send
          // periodic keepalive comments (`:keepalive\n\n`) or empty `data:\n\n`
          // lines to hold the socket open; the SseParser drops those, so
          // `drain()` returns nothing for them. Resetting on raw bytes would
          // keep an otherwise-stalled stream alive indefinitely — the stream
          // appears "active" (timer keeps resetting) but never produces
          // content. By resetting only when real data payloads arrive, a
          // keepalive-only stall trips the idle timeout as intended.
          if (drained.length > 0) {
            streamTimeout.reset();
          }
          for (const data of drained) {
            processData(data);
            if (streamError) break;
          }
          if (streamError) break;
          // Post-finish grace window: after finish_reason is seen, switch
          // to a shorter idle timeout so trailing usage-only chunks are
          // still drained but a stalled provider is force-closed.
          if (sawFinish && !graceStarted) {
            graceStarted = true;
            streamTimeout.clear();
            streamTimeout = createStreamTimeout(POST_FINISH_GRACE_MS, onTimeout);
            streamTimeout.reset();
          }
        }

        // Flush any trailing bytes / partial event left in the decoder + parser.
        const tail = decoder.decode();
        if (tail.length > 0) {
          sseParser.feed(tail);
        }
        for (const data of sseParser.drain()) {
          processData(data);
        }
      } catch (err) {
        // Don't overwrite a streamError already set by the idle timeout.
        if (!streamError) {
          streamError = true;
          logger.error("stream error", {
            model,
            provider: providerName,
            error: err,
          });
        }
      } finally {
        // Mark the stream closed before clearing the timeout so a
        // late-firing idle-timeout callback is ignored (see streamClosed).
        streamClosed = true;
        streamTimeout.clear();
        // Clear the TTFB timer if it's still pending (first token arrived
        // or stream ended before it fired).
        if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = undefined; }
        // Clear the abort handler so the client-disconnect listener can't
        // call cancel() on an already-closed reader.
        abortUpstream = null;

        // Flush stream-end state from the content processing filters.
        if (markupHealer) {
          // Markup healer flush: emit any remaining text/thinking/tool-call
          // events from held-back partial tag buffers.
          const healEvents = markupHealer.flushEvents();
          for (const event of healEvents) {
            if (event.type === "text" && event.text.length > 0) {
              frames.push(makeTextFrame(event.text, false));
            } else if (event.type === "thinking" && event.thinking.length > 0) {
              frames.push(makeTextFrame(event.thinking, false));
            } else if (event.type === "toolCall") {
              frames.push(
                makeToolCallFrame(event.call.id, event.call.name, event.call.arguments, false),
              );
            }
          }
          // Drain any tool calls accumulated via the feed() compatibility path.
          const healedCalls = markupHealer.drainCompleted();
          for (const call of healedCalls) {
            frames.push(
              makeToolCallFrame(call.id, call.name, call.arguments, false),
            );
          }
          if (healEvents.length > 0 || healedCalls.length > 0) {
            hasVisibleContent = true;
          }
        } else {
          // Flush any remaining think-tags filter state (an unclosed  tag
          // at stream end flushes the held bytes as reasoning).
          const thinkTail = thinkFilter.flush();
          if (thinkTail.reasoning) {
            frames.push(makeTextFrame(thinkTail.reasoning, false));
          }
          // Route think-tags flush content through the dialect hold-window,
          // not directly to frames — the held-back content could contain a
          // dialect marker that should be rescued as tool calls.
          if (thinkTail.content) {
            if (dialectMode === "passthrough") {
              frames.push(makeTextFrame(thinkTail.content, false));
            } else {
              heldText += thinkTail.content;
            }
          }

          // Flush the dialect hold-window. If we buffered text that turned out
          // to be an inline tool-call dialect (Kimi/DeepSeek tokens, Llama
          // <function=>, Qwen XML), rescue it into structured tool calls.
          // Detected-but-unparseable = dead turn (the model emitted gibberish).
          if (heldText.length > 0) {
            // Check for dialect markers in the held text. This covers both the
            // case where dialectMode was set to "dialect" during streaming (the
            // text starts with a known marker) and the case where dialectMode
            // is still "hold" (stream ended before the hold-window could decide).
            if (containsDialectMarker(heldText)) {
              const toolNames = new Set(
                (openaiBody.tools ?? []).map((t) => t.function.name),
              );
              const rescue = rescueInlineToolCalls(heldText, toolNames);
              if (rescue.detected && !rescue.calls) {
                logger.warn("unparseable inline tool-call dialect", {
                  model,
                  provider: providerName,
                });
                streamError = true;
              } else if (rescue.detected && rescue.calls && rescue.calls.length > 0) {
                if (rescue.cleanText.length > 0) {
                  frames.push(makeTextFrame(rescue.cleanText, false));
                }
                for (const call of rescue.calls) {
                  frames.push(
                    makeToolCallFrame("", call.name, call.arguments, true),
                  );
                }
                hasVisibleContent = true;
                logger.info("rescued inline tool calls", {
                  model,
                  provider: providerName,
                  count: rescue.calls.length,
                });
              } else {
                frames.push(makeTextFrame(heldText, false));
              }
            } else {
              frames.push(makeTextFrame(heldText, false));
            }
            heldText = "";
          }
        }

        // Flush accumulated tool calls. When the stream errored, emit them as
        // incomplete so the host knows a tool call was attempted but unfinished.
        const toolFrames = toolAcc.flush(!streamError);
        for (const frame of toolFrames) {
          frames.push(frame);
        }

        // Tool argument validation (OFF by default, env: VALIDATE_TOOL_ARGUMENTS).
        // When enabled, validate flushed tool calls against their schemas. A
        // definite schema violation marks the turn as errored so the failover
        // loop can try the next provider — the provider is healthy, the model
        // misbehaved. Fails open: no schema, unparseable args, or un-compilable
        // schema all pass through untouched.
        if (!streamError && isToolArgumentValidationEnabled() && toolAcc.size > 0) {
          const schemas = toolAcc.getSchemaMap();
          // Map Connect tool-call frames to the { function: { name, arguments } }
          // shape that invalidToolCallReasons expects. The frame shape is
          // { toolCallPart: { toolName, args, isComplete } }.
          const calls = toolFrames.map((f): { function?: { name?: string; arguments?: string } } | undefined => {
            const tc = (f as { toolCallPart?: { toolName?: string; args?: string } }).toolCallPart;
            return tc?.toolName ? { function: { name: tc.toolName, arguments: tc.args ?? "" } } : undefined;
          }).filter((c): c is { function?: { name?: string; arguments?: string } } => c !== undefined);
          const reasons = invalidToolCallReasons(calls, schemas);
          if (reasons.length > 0) {
            logger.warn("invalid tool arguments", {
              model,
              provider: providerName,
              reasons,
            });
            streamError = true;
          }
        }

        // Emit usage totals (including extended token details if the provider
        // reported them: total tokens, reasoning tokens, cached tokens,
        // cache-write tokens).
        frames.push(
          makeUsageFrame(promptTokens, completionTokens, totalTokens, reasoningTokens, cachedTokens, cacheWriteTokens),
        );

        // Final frame: a terminal textPart on success, or an error on failure.
        if (streamError) {
          frames.push(makeErrorFrame("stream error"));
        } else {
          frames.push(makeTextFrame("", true));
        }

        logger.info("request complete", {
          model,
          provider: providerName,
          key: maskKey(key.value),
          sawFinish,
          promptTokens,
          completionTokens,
          totalTokens,
          reasoningTokens,
          cachedTokens,
          cacheWriteTokens,
          toolCalls: toolAcc.size,
          streamError,
          ttfbMs,
          elapsed: Date.now() - requestStart,
        });
        metrics.recordRequest(
          providerName,
          !streamError,
          Date.now() - streamStartMs,
          ttfbMs,
        );
        // Record performance data for latency-based routing. Both TTFB
        // and throughput are normalized by work (prompt tokens / completion
        // tokens) so providers are compared apples-to-apples regardless
        // of the request sizes they happened to serve.
        // Success = produced visible content AND no stream error. An empty
        // completion (no content, no error) is a failure for routing
        // purposes — the provider returned nothing useful and the retry
        // loop will fail over. Recording it as success would hide the
        // failure from the error rate, making the provider look more
        // reliable than it really is.
        //
        // Skip recording when the client disconnected: a client-side abort
        // is not a provider failure. The provider may have been responding
        // fine (just slowly), and recording the empty completion as a
        // failure would inflate the error rate with non-provider errors,
        // contaminating latency routing. This was the root cause of the
        // sentinel-blending bug: client disconnects → 0 tokens → recorded
        // as failure → sentinel stored → next real request blends with
        // sentinel → negative prefill rate → provider always wins routing.
        if (!clientDisconnected) {
          performanceTracker.record(
            providerName,
            hasVisibleContent && !streamError,
            ttfbMs,
            promptTokens,
            completionTokens,
            Date.now() - streamStartMs,
          );
        }
        // Capture the response summary for debugging (opt-in via
        // CAPTURE_BODIES=true). Logs first N text frames + tool call names.
        captureResponseSummary(logger, requestId, frames);
      }

      return {
        frames,
        hasVisibleContent,
        sawFinish,
        streamError,
        ttfbTimedOut,
        idleTimedOut,
        fetchFailed,
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        cachedTokens,
        cacheWriteTokens,
        toolCallCount: toolAcc.size,
      };
    };

    // ---------------------------------------------------------------------
    // 10b. Stream with cross-provider failover on empty completion or TTFB
    //      timeout. The first attempt uses the already-connected provider.
    //      On empty completion or TTFB timeout, instead of retrying the same
    //      provider, we try the NEXT provider in the failover chain. This
    //      avoids getting stuck on a slow provider when a faster one is
    //      available. The client is unaware of the provider switch — the
    //      shim silently fails over and returns whichever provider responds.
    // ---------------------------------------------------------------------
    let lastResult: AttemptResult | undefined;

    // Build the list of providers to try: the connected provider first,
    // then the remaining providers in the failover chain (excluding the
    // ones already tried during the connection phase).
    const triedProviderNames = new Set<string>([providerName]);
    for (const name of connectionTriedProviders) {
      triedProviderNames.add(name);
    }
    const remainingProviders = failoverChain.filter(
      (p) => !triedProviderNames.has(p.name),
    );
    // Try the connected provider plus every remaining provider in the chain.
    // Using the chain size as the attempt cap means we don't give up early
    // when providers are overloaded and more fallbacks are available, while
    // still capping at a reasonable number to avoid unbounded attempts.
    const maxFailoverAttempts = Math.max(
      0,
      remainingProviders.length,
    );

    for (
      let emptyAttempt = 0;
      emptyAttempt <= maxFailoverAttempts;
      emptyAttempt++
    ) {
      // If the client disconnected (closed the response connection before
      // the stream completed), stop immediately — there's no point retrying
      // with the next provider since no one is listening. Without this
      // check, a client that disconnects during the first attempt's TTFB
      // wait would cause the shim to burn through every provider in the
      // failover chain, wasting upstream quota on a response that will
      // never be delivered.
      if (clientDisconnected) {
        logger.info("client disconnected before failover attempt, stopping", {
          attempt: emptyAttempt,
          elapsed: Date.now() - requestStart,
        });
        break;
      }
      if (emptyAttempt > 0) {
        // Short fixed delay between provider failovers. Each provider is
        // independent, so exponential backoff for the same provider doesn't
        // apply here. A 500ms breather is enough to avoid hammering the
        // next fallback right after the previous one, without making the
        // user wait through long backoffs when multiple providers are
        // overloaded at once.
        await sleep(EMPTY_COMPLETION_BASE_DELAY_MS);
      }
      const emptyAttemptStart = Date.now();
      const result = await attemptStream(
        emptyAttempt === 0 ? firstResp : undefined,
        emptyAttempt === 0 ? connectionStartMs : undefined,
      );
      lastResult = result;

      // Success or non-retryable error: stop.
      // TTFB timeout, stream idle timeout, and fetch failure ARE retryable —
      // the provider stalled or was unreachable, so we try the next provider
      // in the failover chain. A mid-stream error (not fetch, not timeout) is
      // non-retryable: the provider started responding then broke, so the
      // client should get the error rather than burning more providers.
      //
      // When the stream idle timeout fires after some content was produced,
      // the content is incomplete (the provider stalled mid-generation).
      // Discard the partial content and try the next provider — the client
      // gets a complete response from a fallback instead of a truncated one
      // with an error frame. This is safe because frames are buffered and
      // not yet flushed to the client.
      if (
        (result.hasVisibleContent && !result.idleTimedOut) ||
        (result.streamError && !result.ttfbTimedOut && !result.idleTimedOut && !result.fetchFailed)
      ) {
        break;
      }

      // TTFB timeout, idle timeout, fetch failure, or empty completion: try
      // the next provider.
      const failoverReason = result.ttfbTimedOut
        ? "ttfb_timeout"
        : result.idleTimedOut
          ? "idle_timeout"
          : result.fetchFailed
            ? "fetch_failed"
            : "empty_completion";
      recordAttempt(providerName, model, failoverReason as AttemptOutcome, emptyAttemptStart, failoverReason);

      // Find the next provider to try. On the first failover, switch to
      // the next in the chain. On subsequent failovers, continue down.
      const nextProvider = remainingProviders.shift();
      if (!nextProvider) {
        // No more providers to try — log and stop.
        if (remainingProviders.length === 0) {
          logger.info(`${failoverReason}, no more providers to try`, {
            model,
            provider: providerName,
            attempt: emptyAttempt,
            elapsed: Date.now() - requestStart,
          });
        }
        break;
      }

      // Switch to the next provider for the next attempt. These
      // assignments update the mutable variables that attemptStream
      // references via closure, so the next attemptStream call will
      // fetch from the new provider with the correct key, compat, and
      // network settings.
      logger.warn(`${failoverReason}, failing over to next provider`, {
        model,
        from: providerName,
        to: nextProvider.name,
        attempt: emptyAttempt,
        elapsed: Date.now() - requestStart,
      });

      // Re-resolve model + apply compat for the new provider.
      openaiBody = JSON.parse(JSON.stringify(openaiBodySnapshot)) as typeof openaiBody;
      providerName = nextProvider.name;
      model = nextProvider.resolveModel(normalizedId);
      openaiBody.model = model;
      key = nextProvider.selectKey();
      baseUrl = nextProvider.baseUrl;
      currentProvider = nextProvider;
      compat = nextProvider.compat;
      network = nextProvider.network;
      requestTimeoutMs = adaptiveRequestTimeoutMs(
        network.requestTimeoutMs ?? config.requestTimeoutMs,
        openaiBody,
      );
      applyCompatToRequest(openaiBody, compat, model, nextProvider.name, nextProvider.baseUrl);
      triedProviderNames.add(nextProvider.name);
    }

    // Surface failover to the caller: if the provider that served the request
    // differs from the primary (the one the routing strategy selected), add an
    // x-failover header so clients that care can detect they got a fallback.
    const failoverHeaders: Record<string, string> = {};
    if (providerName !== primary.name) {
      failoverHeaders["x-failover"] = `${primary.name}->${providerName}`;
    }

    startConnectResponse(res, 200, failoverHeaders);
    if (lastResult) {
      for (const frame of lastResult.frames) {
        writeFrame(res, frame);
      }
    }
    endStream(res);
  });

  // Graceful shutdown: stop accepting new connections, then force-exit.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(cleanupHandle);
    clearInterval(metricsHandle);
    if (oauthRefreshHandle) clearInterval(oauthRefreshHandle);
    baseLogger.info("server shutting down", {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // When the server is closed — either by the graceful-shutdown path above
  // or by an external server.close() call (e.g. in tests) — remove the
  // signal handlers from the global process and clear the cleanup interval.
  // Without this, repeated createServer() calls accumulate SIGTERM/SIGINT
  // listeners on process (a handler leak) and leave orphaned intervals
  // running after the server they belong to is gone.
  server.on("close", () => {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    clearInterval(cleanupHandle);
    if (oauthRefreshHandle) clearInterval(oauthRefreshHandle);
  });

  return server;
}
