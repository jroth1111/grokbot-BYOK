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
import { computeBackoff, sleep, shouldRetry } from "./providers/retry.js";
import { createStreamTimeout } from "./providers/stream-timeout.js";
import { SessionAffinity } from "./providers/session-affinity.js";
import { convertRequest } from "./translate/request.js";
import {
  makeErrorFrame,
  makeResponseInfoFrame,
  makeTextFrame,
  makeUsageFrame,
  extractUsage,
} from "./translate/response.js";
import { ToolCallAccumulator } from "./translate/tools.js";
import { applyCompatToRequest } from "./providers/compat.js";

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
export function createServer(config: ShimConfig, logger: Logger): http.Server {
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

  const server = http.createServer(async (req, res) => {
    // Only the streaming inference path is supported.
    if (req.method !== "POST" || req.url !== STREAM_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    const requestStart = Date.now();

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
      logger.error("failed to parse request", { error: err });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame("failed to parse request"));
      endStream(res);
      return;
    }

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
    // 7-8. Try each provider in the failover chain until one accepts,
    //      retrying within a provider with backoff and key rotation.
    // ---------------------------------------------------------------------
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
            break providerLoop;
          }

          // Non-2xx: classify the error and react accordingly.
          const errorType = breaker.classifyError(resp.status);
          let errText = "";
          try {
            errText = await resp.text();
          } catch {
            // ignore body read failure
          }

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
            const backoff = computeBackoff(attempt, backoffInitialMs, backoffMaxMs);
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
            break;
          } else {
            // "stop" — should not occur for non-request errors, but handle it.
            requestError = true;
            break providerLoop;
          }
        } catch (err) {
          clearTimeout(timeoutHandle);
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
            const backoff = computeBackoff(attempt, backoffInitialMs, backoffMaxMs);
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
            break;
          } else {
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
      const decoder = new TextDecoder();

      let sawFinish = false;
      let streamError = false;
      let hasVisibleContent = false;
      let promptTokens = 0;
      let completionTokens = 0;
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
              frames.push(makeTextFrame(reasoningText, false));
              if (reasoningText.length > 0) {
                hasVisibleContent = true;
              }
            }
            if (delta.content) {
              frames.push(makeTextFrame(delta.content, false));
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

        // Flush accumulated tool calls. When the stream errored, emit them as
        // incomplete so the host knows a tool call was attempted but unfinished.
        const toolFrames = toolAcc.flush(!streamError);
        for (const frame of toolFrames) {
          frames.push(frame);
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
          elapsed: Date.now() - requestStart,
        });
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
      const result = await attemptStream(
        emptyAttempt === 0 ? firstResp : undefined,
      );
      lastResult = result;
      if (result.hasVisibleContent || result.streamError) {
        break;
      }
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
    logger.info("server shutting down", {});
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
