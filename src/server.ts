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
import type {
  ConnectEnvelope,
  InferenceStreamRequest,
  InferenceStreamResponse,
  KeyInfo,
  Logger,
  NetworkConfig,
  OpenAIChatRequest,
  OpenAISSEChunk,
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
import { rescueInlineToolCalls, containsDialectMarker, startsWithDialectMarker, couldBecomeDialectMarker } from "./translate/tool-call-rescue.js";
import { ThinkTagStreamFilter } from "./translate/think-tags.js";
import { stripSchemaKeys } from "./translate/tool-args.js";
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
import { captureRequestBody, captureResponseSummary } from "./observability/body-capture.js";

/** Connect streaming path served by the shim. */
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";

/** Force-exit grace period (ms) after a graceful-shutdown signal. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Interval between session-affinity cleanup sweeps (ms). */
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Default stream idle timeout (ms) when a provider doesn't specify one. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Default retry backoff settings when a provider doesn't specify them. */
const DEFAULT_RETRY_BACKOFF_INITIAL_MS = 500;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 5_000;

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
function startConnectResponse(res: http.ServerResponse, status: number): void {
  res.writeHead(status, {
    "Content-Type": CONTENT_TYPE,
    "Cache-Control": "no-cache",
  });
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

  // Periodically log per-provider metrics (requests, error rate, latency
  // histogram, TTFB). Uses the same interval as session cleanup.
  const metricsHandle = setInterval(
    () => metrics.logSummary(baseLogger),
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
      logger.error("failed to read request body", { error: err });
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
    } catch (err) {
      logger.error("failed to parse request", { error: err, requestBody: body.toString().slice(0, 500) });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame("failed to parse request"));
      endStream(res);
      return;
    }

    // Capture the request body for debugging (opt-in via CAPTURE_BODIES=true).
    captureRequestBody(logger, requestId, openaiBody);

    // ---------------------------------------------------------------------
    // 5-6. Resolve provider (honoring session affinity) and build the
    //      failover chain.
    // ---------------------------------------------------------------------
    const { provider: resolvedPrimary, normalizedId } =
      registry.resolveProvider(rawModelId);
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
    const estimatedInputTokens = Math.ceil(
      JSON.stringify(openaiBody.messages ?? []).length / 4,
    );
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

    function recordAttempt(
      providerName: string,
      modelId: string,
      outcome: AttemptOutcome,
      startMs: number,
      err?: unknown,
    ): void {
      trace.records.push({
        ordinal: attemptOrdinal++,
        platform: providerName,
        modelId,
        keyOrdinal: 0,
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
        }
      | undefined;
    let requestError = false;

    providerLoop: for (const provider of failoverChain) {
      if (!breaker.shouldTry(provider.name)) {
        logger.warn("provider circuit open, skipping", {
          provider: provider.name,
          model: rawModelId,
        });
        continue;
      }

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
      const model = provider.resolveModel(normalizedId, rawModelId);
      openaiBody.model = model;

      // Apply provider-specific compat flags to the request body (e.g.
      // coalescing multiple system messages, setting the right max_tokens
      // field name, adding "." for empty assistant tool-call content).
      applyCompatToRequest(openaiBody, provider.compat);

      const maxRetries = provider.network.maxRetries ?? 0;
      const backoffInitialMs =
        provider.network.retryBackoffInitialMs ?? DEFAULT_RETRY_BACKOFF_INITIAL_MS;
      const backoffMaxMs =
        provider.network.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;
      const requestTimeoutMs =
        provider.network.requestTimeoutMs ?? config.requestTimeoutMs;

      let authRotations = 0;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const key = provider.selectKey();

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        };
        if (key.value) {
          headers["Authorization"] = `Bearer ${key.value}`;
        }

        const controller = new AbortController();
        const timeoutHandle = setTimeout(
          () => controller.abort(),
          requestTimeoutMs,
        );

        const attemptStart = Date.now();
        try {
          const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(openaiBody),
            signal: controller.signal,
          });
          clearTimeout(timeoutHandle);

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
            };
            recordAttempt(provider.name, model, "ok", attemptStart);
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
              recordAttempt(provider.name, model, "auth", attemptStart, "all keys exhausted with auth errors");
              metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
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
            recordAttempt(provider.name, model, "provider_bad_request", attemptStart, errText);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            requestError = true;
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
            recordAttempt(provider.name, model, errorType === "rate-limit" ? "rate_limited" : "upstream_error", attemptStart, errText);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            if (recordBreakerFailure(consecBreaker)) {
              logger.warn("consecutive failure breaker tripped", {
                model: rawModelId,
                consecutive: consecBreaker.consecutive,
                limit: consecBreaker.limit,
              });
              requestError = true;
              break providerLoop;
            }
            break;
          } else {
            // "stop" — should not occur for non-request errors, but handle it.
            recordAttempt(provider.name, model, "upstream_error", attemptStart, errText);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            requestError = true;
            break providerLoop;
          }
        } catch (err) {
          clearTimeout(timeoutHandle);
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
            recordAttempt(provider.name, model, isAbort ? "timeout" : "upstream_error", attemptStart, err);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            if (recordBreakerFailure(consecBreaker)) {
              logger.warn("consecutive failure breaker tripped", {
                model: rawModelId,
                consecutive: consecBreaker.consecutive,
                limit: consecBreaker.limit,
              });
              requestError = true;
              break providerLoop;
            }
            break;
          } else {
            recordAttempt(provider.name, model, isAbort ? "timeout" : "upstream_error", attemptStart, err);
            metrics.recordRequest(provider.name, false, Date.now() - attemptStart);
            requestError = true;
            break providerLoop;
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // Request-level error: the request is malformed, emit an error and stop.
    // ---------------------------------------------------------------------
    if (requestError) {
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
      logger.error("request error, aborting", {
        model: rawModelId,
        elapsed: Date.now() - requestStart,
      });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame("request error"));
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
    // ---------------------------------------------------------------------
    const { resp: firstResp, providerName, model, key, network, baseUrl } =
      connected;
    const requestTimeoutMs =
      network.requestTimeoutMs ?? config.requestTimeoutMs;

    const MAX_EMPTY_COMPLETION_RETRIES = 2;
    const EMPTY_COMPLETION_BASE_DELAY_MS = 500;
    const POST_FINISH_GRACE_MS = 2000;
    const MAX_TOOL_CALLS_PER_RESPONSE = 20;

    interface AttemptResult {
      frames: InferenceStreamResponse[];
      hasVisibleContent: boolean;
      sawFinish: boolean;
      streamError: boolean;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number | undefined;
      reasoningTokens: number | undefined;
      cachedTokens: number | undefined;
      toolCallCount: number;
    }

    const attemptStream = async (
      existingResp: Response | undefined,
    ): Promise<AttemptResult> => {
      const frames: InferenceStreamResponse[] = [];
      const responseId = `chatcmpl-shim-${Date.now().toString(36)}`;
      frames.push(makeResponseInfoFrame(responseId, model));

      const sseParser = new SseParser();
      const toolAcc = new ToolCallAccumulator();
      toolAcc.setTools(openaiBody.tools);
      const thinkFilter = new ThinkTagStreamFilter();
      const decoder = new TextDecoder();

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
      let totalTokens: number | undefined;
      let reasoningTokens: number | undefined;
      let cachedTokens: number | undefined;
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
        streamError = true;
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
          promptTokens = extracted.promptTokens || promptTokens;
          completionTokens = extracted.completionTokens || completionTokens;
          totalTokens = extracted.totalTokens || totalTokens;
          reasoningTokens = extracted.reasoningTokens || reasoningTokens;
          cachedTokens = extracted.cachedTokens ?? cachedTokens;
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
              if (ttfbMs === undefined) ttfbMs = Date.now() - requestStart;
              frames.push(makeTextFrame(reasoningText, false));
              if (reasoningText.length > 0) {
                hasVisibleContent = true;
              }
            }
            if (delta.content) {
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
                if (ttfbMs === undefined) ttfbMs = Date.now() - requestStart;
                if (dialectMode === "passthrough") {
                  frames.push(makeTextFrame(textToEmit, false));
                } else {
                  heldText += textToEmit;
                  const probe = heldText.trimStart();
                  if (startsWithDialectMarker(probe)) {
                    dialectMode = "dialect";
                  } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
                    dialectMode = "passthrough";
                    frames.push(makeTextFrame(heldText, false));
                    heldText = "";
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
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        };
        if (key.value) {
          headers["Authorization"] = `Bearer ${key.value}`;
        }
        const controller = new AbortController();
        const timeoutHandle = setTimeout(
          () => controller.abort(),
          requestTimeoutMs,
        );
        try {
          resp = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(openaiBody),
            signal: controller.signal,
          });
          clearTimeout(timeoutHandle);
          if (!resp.ok || !resp.body) {
            logger.warn("empty-completion retry fetch failed", {
              model,
              provider: providerName,
              status: resp.status,
              key: maskKey(key.value),
              elapsed: Date.now() - requestStart,
            });
            frames.push(makeErrorFrame("upstream retry failed"));
            return {
              frames,
              hasVisibleContent: false,
              sawFinish: false,
              streamError: true,
              promptTokens,
              completionTokens,
              totalTokens,
              reasoningTokens,
              cachedTokens,
              toolCallCount: toolAcc.size,
            };
          }
        } catch (err) {
          clearTimeout(timeoutHandle);
          logger.warn("empty-completion retry fetch error", {
            model,
            provider: providerName,
            key: maskKey(key.value),
            error: err,
            elapsed: Date.now() - requestStart,
          });
          frames.push(makeErrorFrame("upstream retry failed"));
          return {
            frames,
            hasVisibleContent: false,
            sawFinish: false,
            streamError: true,
            promptTokens,
            completionTokens,
            totalTokens,
            reasoningTokens,
            cachedTokens,
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
        streamTimeout.reset();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await r.read();
          if (done) {
            break;
          }
          streamTimeout.reset();
          const text = decoder.decode(value, { stream: true });
          sseParser.feed(text);
          for (const data of sseParser.drain()) {
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
        // reported them: total tokens, reasoning tokens, cached tokens).
        frames.push(
          makeUsageFrame(promptTokens, completionTokens, totalTokens, reasoningTokens, cachedTokens),
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
          toolCalls: toolAcc.size,
          streamError,
          ttfbMs,
          elapsed: Date.now() - requestStart,
        });
        metrics.recordRequest(
          providerName,
          !streamError,
          Date.now() - requestStart,
          ttfbMs,
        );
        // Capture the response summary for debugging (opt-in via
        // CAPTURE_BODIES=true). Logs first N text frames + tool call names.
        captureResponseSummary(logger, requestId, frames);
      }

      return {
        frames,
        hasVisibleContent,
        sawFinish,
        streamError,
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        cachedTokens,
        toolCallCount: toolAcc.size,
      };
    };

    let lastResult: AttemptResult | undefined;
    for (
      let emptyAttempt = 0;
      emptyAttempt <= MAX_EMPTY_COMPLETION_RETRIES;
      emptyAttempt++
    ) {
      if (emptyAttempt > 0) {
        await sleep(EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** (emptyAttempt - 1));
      }
      const emptyAttemptStart = Date.now();
      const result = await attemptStream(
        emptyAttempt === 0 ? firstResp : undefined,
      );
      lastResult = result;
      if (result.hasVisibleContent || result.streamError) {
        break;
      }
      // Record the empty-completion attempt in the trace so the failover
      // trail shows the retries (not just the final outcome).
      recordAttempt(providerName, model, "empty_completion", emptyAttemptStart, "empty completion");
      if (emptyAttempt < MAX_EMPTY_COMPLETION_RETRIES) {
        logger.info("empty completion, retrying", {
          model,
          provider: providerName,
          attempt: emptyAttempt,
          completionTokens: result.completionTokens,
          toolCalls: result.toolCallCount,
          elapsed: Date.now() - requestStart,
        });
      }
    }

    startConnectResponse(res, 200);
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
  });

  return server;
}
