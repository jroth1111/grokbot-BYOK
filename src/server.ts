/**
 * HTTP server that bridges Connect-RPC streaming inference requests to
 * OpenAI-compatible chat completion endpoints.
 *
 * The server accepts POST requests on the
 * `aiserver.v1.InferenceService/Stream` Connect streaming path, translates the
 * inbound InferenceStreamRequest into an OpenAI chat completion request, routes
 * it to a provider (with failover + circuit breaking), and streams the OpenAI
 * SSE response back as Connect InferenceStreamResponse frames.
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
  Logger,
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
import { convertRequest } from "./translate/request.js";
import {
  makeErrorFrame,
  makeResponseInfoFrame,
  makeTextFrame,
  makeUsageFrame,
} from "./translate/response.js";
import { ToolCallAccumulator } from "./translate/tools.js";

/** Connect streaming path served by the shim. */
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";

/** Force-exit grace period (ms) after a graceful-shutdown signal. */
const SHUTDOWN_GRACE_MS = 10_000;

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
 * The {@link ProviderRegistry} and {@link CircuitBreaker} are constructed once
 * and shared across all requests so provider routing state and circuit state
 * persist for the lifetime of the server.
 */
export function createServer(config: ShimConfig, logger: Logger): http.Server {
  const registry = new ProviderRegistry(
    config.providers.configs,
    config.providers.priority,
  );
  const breaker = new CircuitBreaker();

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

      openaiBody = convertRequest(reqJson);
    } catch (err) {
      logger.error("failed to parse request", { error: err });
      startConnectResponse(res, 200);
      writeFrame(res, makeErrorFrame("failed to parse request"));
      endStream(res);
      return;
    }

    // ---------------------------------------------------------------------
    // 5-6. Resolve provider and build the failover chain.
    // ---------------------------------------------------------------------
    const { provider: primary, normalizedId } = registry.resolveProvider(rawModelId);
    const failoverChain = registry.getFailoverChain(primary, config.failover);

    logger.info("routing request", {
      model: rawModelId,
      provider: primary.name,
      failoverChain: failoverChain.map((p) => p.name),
    });

    // ---------------------------------------------------------------------
    // 7. Try each provider in the failover chain until one accepts.
    // ---------------------------------------------------------------------
    let connected:
      | { resp: Response; providerName: string; model: string }
      | undefined;

    for (const provider of failoverChain) {
      if (!breaker.shouldTry(provider.name)) {
        logger.warn("provider circuit open, skipping", {
          provider: provider.name,
          model: rawModelId,
        });
        continue;
      }

      // Re-resolve the model for this specific provider.
      const model = provider.resolveModel(normalizedId, rawModelId);
      openaiBody.model = model;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (provider.apiKey) {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }

      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        config.requestTimeoutMs,
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
          logger.info("upstream connected", {
            model,
            provider: provider.name,
            status: resp.status,
            elapsed: Date.now() - attemptStart,
          });
          connected = { resp, providerName: provider.name, model };
          break;
        }

        // Non-2xx: record failure and try the next provider.
        breaker.recordFailure(provider.name);
        let errText = "";
        try {
          errText = await resp.text();
        } catch {
          // ignore body read failure
        }
        logger.warn("upstream non-2xx", {
          model,
          provider: provider.name,
          status: resp.status,
          elapsed: Date.now() - attemptStart,
          error: errText.slice(0, 500),
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        breaker.recordFailure(provider.name);
        logger.warn("upstream fetch failed", {
          model,
          provider: provider.name,
          elapsed: Date.now() - attemptStart,
          error: err,
        });
      }
    }

    // ---------------------------------------------------------------------
    // 8. All providers failed: emit an error and end the stream.
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
    // 9. A provider accepted: commit the response and emit responseInfo.
    // ---------------------------------------------------------------------
    const { resp, providerName, model } = connected;
    startConnectResponse(res, 200);
    const responseId = `chatcmpl-shim-${Date.now().toString(36)}`;
    writeFrame(res, makeResponseInfoFrame(responseId, model));

    // ---------------------------------------------------------------------
    // 10-12. Stream the SSE response back as Connect frames.
    // ---------------------------------------------------------------------
    const sseParser = new SseParser();
    const toolAcc = new ToolCallAccumulator();
    const decoder = new TextDecoder();

    let sawFinish = false;
    let streamError = false;
    let promptTokens = 0;
    let completionTokens = 0;

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

      if (chunk.usage) {
        promptTokens =
          chunk.usage.prompt_tokens ?? chunk.usage.promptTokens ?? promptTokens;
        completionTokens =
          chunk.usage.completion_tokens ??
          chunk.usage.completionTokens ??
          completionTokens;
      }

      // Feed the whole chunk; the accumulator skips choices without tool_calls.
      toolAcc.feed(chunk);

      for (const choice of chunk.choices ?? []) {
        if (choice.delta?.content) {
          writeFrame(res, makeTextFrame(choice.delta.content, false));
        }
        if (choice.finish_reason) {
          sawFinish = true;
        }
      }
    };

    try {
      if (!resp.body) {
        throw new Error("upstream response has no body");
      }
      const reader = resp.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = decoder.decode(value, { stream: true });
        sseParser.feed(text);
        for (const data of sseParser.drain()) {
          processData(data);
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
      streamError = true;
      logger.error("stream error", {
        model,
        provider: providerName,
        error: err,
      });
    } finally {
      // Flush accumulated tool calls. When the stream errored, emit them as
      // incomplete so the host knows a tool call was attempted but unfinished.
      const toolFrames = toolAcc.flush(!streamError);
      for (const frame of toolFrames) {
        writeFrame(res, frame);
      }

      // Emit usage totals.
      writeFrame(res, makeUsageFrame(promptTokens, completionTokens));

      // Final frame: a terminal textPart on success, or an error on failure.
      if (streamError) {
        writeFrame(res, makeErrorFrame("stream error"));
      } else {
        writeFrame(res, makeTextFrame("", true));
      }

      endStream(res);

      logger.info("request complete", {
        model,
        provider: providerName,
        sawFinish,
        promptTokens,
        completionTokens,
        toolCalls: toolAcc.size,
        streamError,
        elapsed: Date.now() - requestStart,
      });
    }
  });

  // Graceful shutdown: stop accepting new connections, then force-exit.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("server shutting down", {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}
