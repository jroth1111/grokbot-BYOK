/**
 * Comprehensive server integration tests.
 *
 * These boot the real shim HTTP server (`createServer`) against mock upstream
 * HTTP servers that respond with configurable status codes, SSE streams,
 * delays, and auth-aware behavior. Each test exercises a specific slice of the
 * full request lifecycle: streaming success, tool calls, failover, retry with
 * backoff, error classification, key rotation, session affinity, stream idle
 * timeout, request parsing, and per-provider request timeouts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../src/server.js";
import { createLogger } from "../src/log.js";
import {
  encodeEnvelope,
  parseEnvelopes,
  DATA_FLAGS,
  END_STREAM_FLAGS,
  CONTENT_TYPE,
} from "../src/protocol/connect.js";
import type {
  InferenceStreamRequest,
  InferenceStreamResponse,
  KeyInfo,
  NetworkConfig,
  OpenAISSEChunk,
  ProviderConfig,
  RoutingStrategy,
  SessionAffinityConfig,
  ShimConfig,
} from "../src/types.js";
import { ChatGptTokenStore, type ChatGptAccount } from "../src/providers/chatgpt-oauth.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Each createServer() call registers SIGTERM/SIGINT listeners on `process`
// (for graceful shutdown) that are never removed when the server closes. This
// file boots many shim servers (one per describe block), which exceeds Node's
// default EventEmitter limit of 10 and produces spurious memory-leak warnings.
// Lift the cap for the test process.
process.setMaxListeners(0);

const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";

// ---------------------------------------------------------------------------
// Mock upstream HTTP server
// ---------------------------------------------------------------------------

interface MockUpstreamOpts {
  /** HTTP status to return (default 200). Ignored for `stall`. */
  status?: number;
  /** Per-call status sequence; the Nth call uses statusSequence[N-1]. */
  statusSequence?: number[];
  /** SSE chunk objects to send as `data:` lines (only when status === 200). */
  sseChunks?: object[];
  /** Delay (ms) before responding. */
  delayMs?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Accept the connection, send a 200 head, then never send a body (stall). */
  stall?: boolean;
  /** Map of bearer-token-value -> status override (for key-rotation tests). */
  authKeyStatus?: Record<string, number>;
  /** SSE chunks to send when an auth-key override resolves to status 200. */
  authKeySseChunks?: object[];
  /** JSON body override per bearer token (e.g. usage_limit_reached 429s). */
  authKeyBody?: Record<string, object>;
  /** If set, send SSE comment keepalives (":keepalive\n\n") every N ms before
   *  the real SSE chunks. Used to test that keepalive-only bytes don't reset
   *  the stream idle timeout. */
  keepaliveMs?: number;
  /** How long to send keepalives before delivering real chunks (ms). */
  keepaliveDurationMs?: number;
}

interface MockUpstream {
  server: http.Server;
  port: number;
  url: string;
  /** Mutable call counter. */
  callCount: { value: number };
  /** Authorization headers received, in call order. */
  receivedAuths: string[];
  /** Full header maps received, in call order (chatgpt-account-id checks). */
  receivedHeaderMaps: Record<string, string | string[] | undefined>[];
}

/**
 * Start a mock OpenAI-compatible upstream on a random port.
 *
 * The server responds to POST /chat/completions (and any other method/path)
 * according to `opts`. For SSE responses it writes `data: <json>\n\n` lines
 * for each chunk followed by `data: [DONE]\n\n`.
 */
function startMockUpstream(opts: MockUpstreamOpts = {}): Promise<MockUpstream> {
  return new Promise((resolve, reject) => {
    const callCount = { value: 0 };
    const receivedAuths: string[] = [];
    const receivedHeaderMaps: Record<string, string | string[] | undefined>[] = [];

    const server = http.createServer((req, res) => {
      callCount.value++;
      const auth = (req.headers["authorization"] as string | undefined) ?? "";
      receivedAuths.push(auth);
      receivedHeaderMaps.push({ ...req.headers });

      // Swallow errors from aborted client connections so a cancelled fetch
      // (e.g. timeout/stall) never crashes the mock.
      req.on("error", () => {});
      res.on("error", () => {});

      // Resolve the status for this call.
      let status = opts.status ?? 200;
      let sseChunks = opts.sseChunks;
      if (opts.statusSequence && callCount.value - 1 < opts.statusSequence.length) {
        status = opts.statusSequence[callCount.value - 1];
      }
      if (opts.authKeyStatus) {
        const bearer = auth.replace(/^Bearer\s+/, "");
        if (bearer in opts.authKeyStatus) {
          status = opts.authKeyStatus[bearer];
          if (status === 200 && opts.authKeySseChunks) {
            sseChunks = opts.authKeySseChunks;
          }
        }
      }
      let bodyOverride: object | undefined;
      if (opts.authKeyBody) {
        const bearer = auth.replace(/^Bearer\s+/, "");
        if (bearer in opts.authKeyBody) {
          bodyOverride = opts.authKeyBody[bearer];
        }
      }

      const respond = (): void => {
        if (res.destroyed || res.writableEnded) return;

        if (opts.stall) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            ...(opts.headers ?? {}),
          });
          // Force the headers out so the client's fetch resolves on the 200
          // head; we then intentionally never write a body or end the response.
          res.flushHeaders();
          return;
        }

        if (status === 200 && sseChunks) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...(opts.headers ?? {}),
          });
          // If keepalive is configured, send comment lines periodically
          // before the real data. This simulates providers like OpenRouter
          // that send ":keepalive\n\n" to hold the socket open.
          if (opts.keepaliveMs && opts.keepaliveDurationMs) {
            const kaStart = Date.now();
            const kaTimer = setInterval(() => {
              if (Date.now() - kaStart >= opts.keepaliveDurationMs!) {
                clearInterval(kaTimer);
                for (const chunk of sseChunks!) {
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
              } else {
                res.write(":keepalive\n\n");
              }
            }, opts.keepaliveMs);
          } else {
            for (const chunk of sseChunks) {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            res.write("data: [DONE]\n\n");
            res.end();
          }
        } else {
          res.writeHead(status, {
            "Content-Type": "application/json",
            ...(opts.headers ?? {}),
          });
          res.end(JSON.stringify(bodyOverride ?? { error: { message: `mock ${status}` } }));
        }
      };

      if (opts.delayMs && opts.delayMs > 0) {
        setTimeout(respond, opts.delayMs);
      } else {
        respond();
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          server,
          port: addr.port,
          url: `http://127.0.0.1:${addr.port}/v1`,
          callCount,
          receivedAuths,
          receivedHeaderMaps,
        });
      } else {
        reject(new Error("mock upstream did not bind to a port"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Shim server bootstrap
// ---------------------------------------------------------------------------

interface MakeConfigOpts {
  failover?: boolean;
  requestTimeoutMs?: number;
  routingStrategy?: RoutingStrategy;
  sessionAffinity?: SessionAffinityConfig;
  /** Per-provider overrides (network, keys, models, defaultModel, apiKey). */
  providerOverrides?: Record<string, Partial<ProviderConfig>>;
}

/**
 * Build a ShimConfig whose providers point at the given mock upstream URLs.
 */
function makeConfig(
  upstreamUrls: Record<string, string>,
  opts?: MakeConfigOpts,
): ShimConfig {
  const configs: Record<string, ProviderConfig> = {};
  for (const [name, url] of Object.entries(upstreamUrls)) {
    const override = opts?.providerOverrides?.[name] ?? {};
    const config: ProviderConfig = {
      baseUrl: url,
      apiKey: override.apiKey ?? "test-key",
      defaultModel: override.defaultModel ?? "test-model",
      models: override.models ?? {
        "test-model": "test-model",
        "sand-default": "test-model",
      },
    };
    if (override.keys !== undefined) config.keys = override.keys;
    if (override.network !== undefined) config.network = override.network;
    if (override.auth !== undefined) config.auth = override.auth;
    if (override.endpointPath !== undefined) config.endpointPath = override.endpointPath;
    if (override.wireApi !== undefined) config.wireApi = override.wireApi;
    if (override.compat !== undefined) config.compat = override.compat;
    configs[name] = config;
  }
  return {
    port: 0,
    host: "127.0.0.1",
    logDir: "",
    failover: opts?.failover ?? true,
    requestTimeoutMs: opts?.requestTimeoutMs ?? 5000,
    routingStrategy: opts?.routingStrategy ?? "priority",
    sessionAffinity: opts?.sessionAffinity ?? { enabled: false },
    providers: {
      priority: Object.keys(upstreamUrls),
      configs,
    },
    hostConfig: { sandHostDir: "", defaultModel: "test-model" },
  };
}

/** Start the shim server on a random port and resolve with the port. */
function startShim(config: ShimConfig): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(config, createLogger());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("shim server did not bind to a port"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Request / response helpers
// ---------------------------------------------------------------------------

/** POST a Connect-framed InferenceStreamRequest and resolve with the response. */
function sendRequest(
  port: number,
  reqJson: InferenceStreamRequest,
  rawBody?: Buffer,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const framed =
      rawBody ?? encodeEnvelope(DATA_FLAGS, Buffer.from(JSON.stringify(reqJson), "utf8"));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: STREAM_PATH,
        method: "POST",
        headers: {
          "Content-Type": CONTENT_TYPE,
          "Content-Length": String(framed.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(framed);
    req.end();
  });
}

interface ParsedResponse {
  envelopes: ReturnType<typeof parseEnvelopes>;
  trailer: ReturnType<typeof parseEnvelopes>[number];
  frames: InferenceStreamResponse[];
}

/** Parse a Connect response body into data frames + the end-stream trailer. */
function parseResponse(body: Buffer): ParsedResponse {
  const envelopes = parseEnvelopes(body);
  const trailer = envelopes[envelopes.length - 1];
  const dataEnvelopes = envelopes.filter((e) => (e.flags & 0x02) === 0);
  const frames = dataEnvelopes.map(
    (e) => JSON.parse(e.data.toString("utf8")) as InferenceStreamResponse,
  );
  return { envelopes, trailer, frames };
}

/** A basic user request for "test-model". */
function basicRequest(modelId = "test-model"): InferenceStreamRequest {
  return {
    requestedModel: { modelId },
    messages: [{ role: 1, text: "hello" }],
  };
}

/** Build SSE chunks for a simple text completion: "Hello world". */
function textSseChunks(): OpenAISSEChunk[] {
  return [
    { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ];
}

/** Build SSE chunks for a tool-call completion. */
function toolCallSseChunks(): OpenAISSEChunk[] {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"loc' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'ation":"NYC"}' } },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

/**
 * Build SSE chunks mimicking a reasoning model (e.g. opencode-go's
 * ox-alpha-free): reasoning_content deltas followed by content, with
 * extended usage (total_tokens, reasoning_tokens, cached_tokens) and a
 * trailing cost-annotation frame with empty choices.
 */
function reasoningSseChunks(): OpenAISSEChunk[] {
  return [
    {
      id: "test-reasoning",
      object: "chat.completion.chunk",
      created: 1787333165,
      model: "test-model",
      choices: [
        { index: 0, delta: { role: "assistant", reasoning_content: "The user wants" } },
      ],
    },
    {
      id: "test-reasoning",
      choices: [
        { index: 0, delta: { reasoning_content: " me to say hello" } },
      ],
    },
    {
      id: "test-reasoning",
      choices: [
        { index: 0, delta: { content: "Hello!" } },
      ],
    },
    {
      id: "test-reasoning",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 92,
        completion_tokens: 18,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
    // Trailing cost-annotation frame (empty choices) — must be skipped.
    { choices: [] } as unknown as OpenAISSEChunk,
  ];
}

/**
 * Build SSE chunks mimicking glm-5.2 on opencode-go: the usage arrives
 * in a SEPARATE chunk with an empty choices array (not on the finish
 * chunk). The shim must extract usage from this empty-choices chunk
 * rather than skipping it as a cost-annotation frame.
 */
function separateUsageSseChunks(): OpenAISSEChunk[] {
  return [
    {
      id: "test-glm52",
      object: "chat.completion.chunk",
      created: 1787334152,
      model: "test-model",
      choices: [
        { index: 0, delta: { role: "assistant", content: "", reasoning_content: "" } },
      ],
    },
    {
      id: "test-glm52",
      choices: [
        { index: 0, delta: { content: "Hello world!" } },
      ],
    },
    {
      id: "test-glm52",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      // finish chunk has no usage — it arrives in the next chunk
      usage: undefined,
    },
    // Usage arrives in a separate chunk with EMPTY choices — must NOT be skipped.
    {
      id: "test-glm52",
      choices: [],
      usage: {
        prompt_tokens: 14,
        completion_tokens: 719,
        total_tokens: 733,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 698 },
      },
    } as unknown as OpenAISSEChunk,
    // Trailing cost-annotation frame (also empty choices, no usage) — skip.
    { choices: [] } as unknown as OpenAISSEChunk,
  ];
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

/** Close an HTTP server, dropping lingering connections, resolving when done. */
function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    const s = server as unknown as { closeAllConnections?: () => void };
    s.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Close all given servers (shim + mocks) and resolve when fully closed. */
async function cleanup(...servers: http.Server[]): Promise<void> {
  await Promise.all(servers.map(closeHttpServer));
}

// ===========================================================================
// Tests
// ===========================================================================

describe("server integration: successful streaming", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    upstream = await startMockUpstream({ sseChunks: textSseChunks() });
    const config = makeConfig({ primary: upstream.url });
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "streams a text completion with responseInfo, textParts, usage, and a final textPart",
    async () => {
      const { status, headers, body } = await sendRequest(shim.port, basicRequest());

      expect(status).toBe(200);
      expect(headers["content-type"]).toBe(CONTENT_TYPE);

      const { trailer, frames } = parseResponse(body);

      // The last envelope is the end-stream trailer.
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      // responseInfo frame first.
      const responseInfo = frames.find((f) => "responseInfo" in f);
      expect(responseInfo).toBeDefined();
      expect((responseInfo as { responseInfo: { model: string } }).responseInfo.model).toBe(
        "test-model",
      );

      // Non-final text parts carrying the streamed content.
      const textParts = frames.filter(
        (f) => "textPart" in f && !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
      );
      const text = textParts
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");

      // Usage frame with the accumulated token counts.
      const usage = frames.find((f) => "usage" in f) as
        | { usage: { promptTokens: number; completionTokens: number } }
        | undefined;
      expect(usage).toBeDefined();
      expect(usage!.usage.promptTokens).toBe(10);
      expect(usage!.usage.completionTokens).toBe(5);

      // Terminal textPart with isFinal=true.
      const finalText = frames.find(
        (f) =>
          "textPart" in f &&
          (f as { textPart: { isFinal: boolean } }).textPart.isFinal,
      ) as { textPart: { text: string; isFinal: boolean } } | undefined;
      expect(finalText).toBeDefined();
      expect(finalText!.textPart.isFinal).toBe(true);

      // No error frame on a successful stream.
      expect(frames.some((f) => "error" in f)).toBe(false);

      // Only one upstream call was made.
      expect(upstream.callCount.value).toBe(1);
    },
    5000,
  );
});

describe("server integration: reasoning_content and extended usage", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    upstream = await startMockUpstream({ sseChunks: reasoningSseChunks() });
    const config = makeConfig({ primary: upstream.url });
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "forwards reasoning_content as textPart frames and carries extended usage fields",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);

      // All non-final text parts (reasoning + content).
      const textParts = frames.filter(
        (f) => "textPart" in f && !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
      );
      const text = textParts
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");

      // reasoning_content ("The user wants...") arrives before content ("Hello!").
      expect(text).toContain("The user wants");
      expect(text).toContain("Hello!");

      // Usage frame with extended token details.
      const usage = frames.find((f) => "usage" in f) as
        | {
            usage: {
              promptTokens: number;
              completionTokens: number;
              totalTokens?: number;
              reasoningTokens?: number;
              cachedTokens?: number;
            };
          }
        | undefined;
      expect(usage).toBeDefined();
      expect(usage!.usage.promptTokens).toBe(92);
      expect(usage!.usage.completionTokens).toBe(18);
      expect(usage!.usage.totalTokens).toBe(110);
      expect(usage!.usage.reasoningTokens).toBe(5);
      expect(usage!.usage.cachedTokens).toBe(64);

      // The trailing cost frame (empty choices) must not produce any
      // spurious frames — only responseInfo, textParts, usage, final, trailer.
      expect(frames.filter((f) => "error" in f)).toHaveLength(0);
      expect(upstream.callCount.value).toBe(1);
    },
    5000,
  );
});

describe("server integration: usage in separate empty-choices chunk (glm-5.2)", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    upstream = await startMockUpstream({ sseChunks: separateUsageSseChunks() });
    const config = makeConfig({ primary: upstream.url });
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "extracts usage from a separate empty-choices chunk without skipping it",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);

      // Text content should be present.
      const textParts = frames.filter(
        (f) => "textPart" in f && !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
      );
      const text = textParts
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toContain("Hello world!");

      // The critical assertion: usage must be extracted from the
      // empty-choices chunk, not lost. Without the fix, this would be
      // { promptTokens: 0, completionTokens: 0 }.
      const usage = frames.find((f) => "usage" in f) as
        | {
            usage: {
              promptTokens: number;
              completionTokens: number;
              totalTokens?: number;
              reasoningTokens?: number;
              cachedTokens?: number;
            };
          }
        | undefined;
      expect(usage).toBeDefined();
      expect(usage!.usage.promptTokens).toBe(14);
      expect(usage!.usage.completionTokens).toBe(719);
      expect(usage!.usage.totalTokens).toBe(733);
      expect(usage!.usage.reasoningTokens).toBe(698);
      expect(usage!.usage.cachedTokens).toBe(0);

      // No errors, one upstream call.
      expect(frames.filter((f) => "error" in f)).toHaveLength(0);
      expect(upstream.callCount.value).toBe(1);
    },
    5000,
  );
});

describe("server integration: streaming with tool calls", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    upstream = await startMockUpstream({ sseChunks: toolCallSseChunks() });
    const config = makeConfig({ primary: upstream.url });
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "emits a toolCallPart with accumulated args and isComplete=true",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);

      const toolFrames = frames.filter((f) => "toolCallPart" in f) as {
        toolCallPart: {
          toolCallId: string;
          toolName: string;
          args: string;
          isComplete: boolean;
        };
      }[];

      expect(toolFrames.length).toBe(1);
      const tc = toolFrames[0].toolCallPart;
      expect(tc.toolCallId).toBe("call_1");
      expect(tc.toolName).toBe("get_weather");
      // Arguments were streamed in two deltas and accumulated.
      expect(tc.args).toBe('{"location":"NYC"}');
      expect(tc.isComplete).toBe(true);
    },
    5000,
  );
});

describe("server integration: TTFB measured for tool-call-only responses", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    // Use tool-call-only SSE chunks with a small delay so TTFB is measurable.
    upstream = await startMockUpstream({ delayMs: 50, sseChunks: toolCallSseChunks() });
    const config = makeConfig({ primary: upstream.url });
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "sets ttfbMs when the first content is a tool call (no text/reasoning delta)",
    async () => {
      // Tool-call-only responses must still set ttfbMs so the TTFB timer
      // is cleared. Without this, a slow tool-call-only response could be
      // incorrectly aborted by the TTFB timeout.
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);
      // Should have a tool call frame (not an error).
      const toolFrames = frames.filter((f) => "toolCallPart" in f);
      expect(toolFrames.length).toBe(1);
      expect(frames.some((f) => "error" in f)).toBe(false);
    },
    5000,
  );
});

describe("server integration: provider failover", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    primary = await startMockUpstream({ status: 500 });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "fails over from a 500 primary to a 200 secondary and streams a response",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);

      // The response came from the secondary (text content present, no error).
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      // Primary was attempted (and failed); secondary served the request.
      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(1);
    },
    5000,
  );
});

describe("server integration: retry with backoff within a provider", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    // 500, 500, then 200 on the third call.
    upstream = await startMockUpstream({
      statusSequence: [500, 500, 200],
      sseChunks: textSseChunks(),
    });
    const network: NetworkConfig = {
      maxRetries: 2,
      retryBackoffInitialMs: 10,
      retryBackoffMaxMs: 20,
    };
    const config = makeConfig(
      { primary: upstream.url },
      { providerOverrides: { primary: { network } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "retries within the provider and succeeds on the third attempt",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      // Exactly three attempts were made against the single provider.
      expect(upstream.callCount.value).toBe(3);
    },
    5000,
  );
});

describe("server integration: 400 request error stops immediately", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    primary = await startMockUpstream({ status: 400 });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "emits a 'request rejected by provider' frame and does not fail over",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { trailer, frames } = parseResponse(body);
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      const errorFrame = frames.find((f) => "error" in f) as
        | { error: { message: string } }
        | undefined;
      expect(errorFrame).toBeDefined();
      expect(errorFrame!.error.message).toBe("request rejected by provider");

      // Only the primary was attempted — no failover to the secondary.
      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(0);
    },
    5000,
  );
});

describe("server integration: 429 triggers failover", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    primary = await startMockUpstream({ status: 429 });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "fails over from a 429 primary to a 200 secondary",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(1);
    },
    5000,
  );
});

describe("server integration: 401 triggers key rotation", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    // The first key gets 401; the second key gets 200 with SSE.
    upstream = await startMockUpstream({
      authKeyStatus: { "key-bad": 401, "key-good": 200 },
      authKeySseChunks: textSseChunks(),
    });
    const keys: KeyInfo[] = [
      { value: "key-bad", weight: 1, enabled: true },
      { value: "key-good", weight: 1, enabled: true },
    ];
    const config = makeConfig(
      { primary: upstream.url },
      { providerOverrides: { primary: { keys, apiKey: "key-bad" } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "rotates from a 401 key to a working key and succeeds",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      // Two calls: the bad key (401) then the good key (200).
      expect(upstream.callCount.value).toBe(2);
      expect(upstream.receivedAuths).toContain("Bearer key-bad");
      expect(upstream.receivedAuths).toContain("Bearer key-good");
    },
    5000,
  );
});

describe("server integration: session affinity", () => {
  let shim: { server: http.Server; port: number };
  let providerA: MockUpstream;
  let providerB: MockUpstream;

  beforeAll(async () => {
    providerA = await startMockUpstream({ sseChunks: textSseChunks() });
    providerB = await startMockUpstream({ sseChunks: textSseChunks() });
    const sessionAffinity: SessionAffinityConfig = { enabled: true, ttlMs: 60_000 };
    // Both providers handle "test-model" but resolve it to different canonical
    // names so we can tell which provider served a request from responseInfo.
    const config = makeConfig(
      { "provider-a": providerA.url, "provider-b": providerB.url },
      {
        routingStrategy: "round-robin",
        sessionAffinity,
        providerOverrides: {
          "provider-a": { models: { "test-model": "model-a" } },
          "provider-b": { models: { "test-model": "model-b" } },
        },
      },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, providerA.server, providerB.server));

  it(
    "binds a session to one provider and reuses it on the next request",
    async () => {
      const req: InferenceStreamRequest = {
        ...basicRequest(),
        invocationId: "sess-1",
      };

      // First request: round-robin picks provider-a (cursor 0) and binds.
      const r1 = await sendRequest(shim.port, req);
      expect(r1.status).toBe(200);
      const f1 = parseResponse(r1.body).frames;
      const info1 = f1.find((f) => "responseInfo" in f) as
        | { responseInfo: { model: string } }
        | undefined;
      expect(info1).toBeDefined();
      const firstModel = info1!.responseInfo.model;
      expect(["model-a", "model-b"]).toContain(firstModel);

      // Second request with the same invocationId: session affinity should
      // route to the same provider (same model), even though round-robin would
      // otherwise alternate to the other provider.
      const r2 = await sendRequest(shim.port, req);
      expect(r2.status).toBe(200);
      const f2 = parseResponse(r2.body).frames;
      const info2 = f2.find((f) => "responseInfo" in f) as
        | { responseInfo: { model: string } }
        | undefined;
      expect(info2).toBeDefined();
      expect(info2!.responseInfo.model).toBe(firstModel);

      // Both responses succeeded with text content.
      expect(f1.some((f) => "error" in f)).toBe(false);
      expect(f2.some((f) => "error" in f)).toBe(false);
    },
    5000,
  );
});

describe("server integration: stream idle timeout", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    // The upstream accepts the connection and sends a 200 head but never
    // produces any body data, simulating a stalled stream.
    upstream = await startMockUpstream({ stall: true });
    const network: NetworkConfig = { streamIdleTimeoutMs: 100 };
    const config = makeConfig(
      { primary: upstream.url },
      { providerOverrides: { primary: { network } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "emits a stream error frame instead of hanging when the upstream stalls",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { trailer, frames } = parseResponse(body);
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      // A responseInfo is emitted once the upstream "connects" (200 head).
      expect(frames.some((f) => "responseInfo" in f)).toBe(true);

      // The stream error frame is emitted by the idle-timeout guard.
      const errorFrame = frames.find((f) => "error" in f) as
        | { error: { message: string } }
        | undefined;
      expect(errorFrame).toBeDefined();
      expect(errorFrame!.error.message).toBe("stream error");
    },
    5000,
  );
});

describe("server integration: all providers fail", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    primary = await startMockUpstream({ status: 500 });
    secondary = await startMockUpstream({ status: 500 });
    // No retries so each provider fails fast and we fall through the chain.
    const network: NetworkConfig = { maxRetries: 0 };
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true, providerOverrides: { primary: { network }, secondary: { network } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "emits an 'all providers failed' error frame",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { trailer, frames } = parseResponse(body);
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      const errorFrame = frames.find((f) => "error" in f) as
        | { error: { message: string } }
        | undefined;
      expect(errorFrame).toBeDefined();
      expect(errorFrame!.error.message).toBe("all providers failed");

      // Both providers were attempted.
      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(1);
    },
    5000,
  );
});

describe("server integration: malformed request body", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;

  beforeAll(async () => {
    upstream = await startMockUpstream({ sseChunks: textSseChunks() });
    const config = makeConfig({ primary: upstream.url });
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server));

  it(
    "emits a 'failed to parse request' error frame for bad Connect framing",
    async () => {
      // Send bytes that are not valid Connect envelope framing.
      const garbage = Buffer.from("not-a-valid-connect-envelope", "utf8");
      const { status, body } = await sendRequest(shim.port, basicRequest(), garbage);
      expect(status).toBe(200);

      const { trailer, frames } = parseResponse(body);
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      const errorFrame = frames.find((f) => "error" in f) as
        | { error: { message: string } }
        | undefined;
      expect(errorFrame).toBeDefined();
      expect(errorFrame!.error.message).toBe("failed to parse request");

      // The upstream was never contacted.
      expect(upstream.callCount.value).toBe(0);
    },
    5000,
  );

  it(
    "rejects binary protobuf Content-Type with a clear error",
    async () => {
      // Send a valid Connect envelope but with application/connect+proto
      // Content-Type. The shim should reject it early with a helpful message
      // instead of trying to JSON.parse the binary payload.
      const body = encodeEnvelope(DATA_FLAGS, Buffer.from("binary-payload", "utf8"));
      const res = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: shim.port,
            path: STREAM_PATH,
            method: "POST",
            headers: {
              "Content-Type": "application/connect+proto",
              "Content-Length": String(body.length),
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () =>
              resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks) }),
            );
            r.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });

      expect(res.status).toBe(200);
      const { frames } = parseResponse(res.body);
      const errorFrame = frames.find((f) => "error" in f) as
        | { error: { message: string } }
        | undefined;
      expect(errorFrame).toBeDefined();
      expect(errorFrame!.error.message).toContain("binary protobuf not supported");

      // The upstream was never contacted.
      expect(upstream.callCount.value).toBe(0);
    },
    5000,
  );
});

describe("server integration: unknown model routes to default provider", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    primary = await startMockUpstream({ sseChunks: textSseChunks() });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    const config = makeConfig({ primary: primary.url, secondary: secondary.url });
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "routes an unrecognized model to the first (default) provider",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest("does-not-exist"));
      expect(status).toBe(200);

      const { frames } = parseResponse(body);

      // The default provider resolved the unknown model to its defaultModel.
      const info = frames.find((f) => "responseInfo" in f) as
        | { responseInfo: { model: string } }
        | undefined;
      expect(info).toBeDefined();
      expect(info!.responseInfo.model).toBe("test-model");

      // Text content was streamed and no error occurred.
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      // Only the default (primary) provider was contacted.
      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(0);
    },
    5000,
  );
});

describe("server integration: per-provider request timeout", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    // Primary delays well beyond its timeout; secondary responds immediately.
    primary = await startMockUpstream({ delayMs: 200, sseChunks: textSseChunks() });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    const network: NetworkConfig = { requestTimeoutMs: 50, maxRetries: 0 };
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true, providerOverrides: { primary: { network } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "times out on a slow primary and fails over to the secondary",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      // The primary was attempted (and timed out); the secondary served it.
      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(1);
    },
    5000,
  );
});

describe("server integration: client disconnect stops failover", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    // Primary stalls (accepts connection, sends 200 head, never sends body).
    // This causes the shim to wait for TTFB/content. When the client
    // disconnects during this wait, the failover loop must NOT try the
    // secondary — there's no one listening.
    primary = await startMockUpstream({ stall: true });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    const network: NetworkConfig = { streamIdleTimeoutMs: 30000 };
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true, providerOverrides: { primary: { network }, secondary: { network } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "does not failover to the secondary when the client disconnects mid-stream",
    async () => {
      // Send a request but abort it immediately after the request body is
      // written — simulating a client that disconnects while the primary
      // is still producing its first token (stall).
      const framed = encodeEnvelope(DATA_FLAGS, Buffer.from(JSON.stringify(basicRequest()), "utf8"));
      const req = http.request({
        hostname: "127.0.0.1",
        port: shim.port,
        path: STREAM_PATH,
        method: "POST",
        headers: {
          "Content-Type": CONTENT_TYPE,
          "Content-Length": String(framed.length),
        },
      });

      // Abort the request as soon as it's sent.
      const abortPromise = new Promise<void>((resolve) => {
        req.on("error", () => {
          // ECONNRESET expected when we abort — resolve silently.
          resolve();
        });
        req.write(framed);
        req.end();
        // Give the shim a moment to receive the request and start the
        // upstream connection, then abort the client side.
        setTimeout(() => req.destroy(), 50);
      });

      // Wait for the abort to complete (or timeout after 5s).
      await Promise.race([
        abortPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("abort timeout")), 5000)),
      ]).catch(() => {
        // If the abort promise times out, that's fine — the key assertion
        // is on the call counts below.
      });

      // Give the shim a moment to process the disconnect and potentially
      // (incorrectly) failover. The stall timeout is 30s, so without the
      // fix the shim would still be waiting on the primary at this point.
      // Wait long enough for the disconnect to be detected and the
      // failover loop to (not) run.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The primary was contacted (the stall connection was made).
      expect(primary.callCount.value).toBe(1);
      // The secondary must NOT have been contacted — the client
      // disconnected, so there's no point failing over.
      expect(secondary.callCount.value).toBe(0);
    },
    10000,
  );
});

describe("server integration: adaptive request timeout scales with body size", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    // Primary delays 80ms (beyond the 50ms base timeout, but within the
    // adaptive timeout for a large body). Secondary responds immediately.
    primary = await startMockUpstream({ delayMs: 80, sseChunks: textSseChunks() });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    // Base timeout is 50ms. With a large body (>50KB), the adaptive timeout
    // adds ~1s, bringing the total to ~1050ms — well above the 80ms delay.
    const network: NetworkConfig = { requestTimeoutMs: 50, maxRetries: 0 };
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true, providerOverrides: { primary: { network } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "does not time out when the request body is large enough to extend the timeout",
    async () => {
      // Build a request with a large system message (>50KB) so the adaptive
      // timeout adds ~1s to the 50ms base. Role 4 = system.
      const req = basicRequest();
      const largeText = "x".repeat(60_000);
      req.messages = [
        { role: 4, text: largeText },
        { role: 1, text: "hello" },
      ];

      const { status, body } = await sendRequest(shim.port, req);
      expect(status).toBe(200);

      const { frames } = parseResponse(body);
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      // The primary served the request (didn't time out).
      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(0);
    },
    5000,
  );
});

describe("server integration: keepalive bytes don't reset stream idle timeout", () => {
  let shim: { server: http.Server; port: number };
  let primary: MockUpstream;
  let secondary: MockUpstream;

  beforeAll(async () => {
    // Primary sends keepalive comments for 200ms (longer than the 100ms
    // idle timeout) before delivering real content. Without the fix, the
    // keepalive bytes would reset the idle timer and the stream would
    // eventually succeed. With the fix, the idle timeout fires because
    // no actual SSE data payloads arrive within the timeout window.
    primary = await startMockUpstream({
      sseChunks: textSseChunks(),
      keepaliveMs: 20,
      keepaliveDurationMs: 200,
    });
    secondary = await startMockUpstream({ sseChunks: textSseChunks() });
    const network: NetworkConfig = { streamIdleTimeoutMs: 100 };
    const config = makeConfig(
      { primary: primary.url, secondary: secondary.url },
      { failover: true, providerOverrides: { primary: { network }, secondary: { network } } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, primary.server, secondary.server));

  it(
    "times out on keepalive-only primary and fails over to secondary",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { frames } = parseResponse(body);
      const text = frames
        .filter(
          (f) =>
            "textPart" in f &&
            !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
        )
        .map((f) => (f as { textPart: { text: string } }).textPart.text)
        .join("");
      expect(text).toBe("Hello world");
      expect(frames.some((f) => "error" in f)).toBe(false);

      // Primary was attempted (and timed out due to keepalive-only); secondary served.
      expect(primary.callCount.value).toBe(1);
      expect(secondary.callCount.value).toBe(1);
    },
    10000,
  );
});

// ===========================================================================
// ChatGPT OAuth provider ("Sign in with ChatGPT", Responses wire API)
// ===========================================================================

/** Minimal unsigned JWT carrying the OpenAI auth claim. */
function fakeAccessJwt(accountId: string): string {
  const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return [
    b64url({ alg: "none", typ: "JWT" }),
    b64url({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "sig",
  ].join(".");
}

function chatgptAccount(
  accountId: string,
  overrides: Partial<ChatGptAccount> = {},
): ChatGptAccount {
  return {
    accountId,
    accessToken: fakeAccessJwt(accountId),
    refreshToken: `rt-${accountId}`,
    expiresAtMs: Date.now() + 55 * 60 * 1000,
    obtainedAtMs: Date.now(),
    enabled: true,
    ...overrides,
  };
}

/** Write a token store to a temp file and return its path. */
function writeChatgptTokenFile(accounts: ChatGptAccount[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "byok-shim-oauth-"));
  const file = path.join(dir, "chatgpt-tokens.json");
  new ChatGptTokenStore(file).save(accounts);
  return file;
}

/** Mock auth.openai.com token endpoint (form POST, refresh grant). */
function startOAuthTokenMock(): Promise<{
  server: http.Server;
  url: string;
  refreshCalls: string[];
}> {
  return new Promise((resolve, reject) => {
    const refreshCalls: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const refreshToken = params.get("refresh_token") ?? "";
        refreshCalls.push(refreshToken);
        if (refreshToken.includes("revoked")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const accountId = refreshToken.replace(/^rt-/, "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            // Plain (non-JWT) string tokens keep the account-mismatch check inert.
            access_token: `tok-fresh-${accountId}`,
            refresh_token: `${refreshToken}-2`,
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, url: `http://127.0.0.1:${addr.port}/oauth/token`, refreshCalls });
      } else {
        reject(new Error("oauth token mock did not bind"));
      }
    });
  });
}

/** A Responses-API SSE event sequence: reasoning + text + usage. */
function responsesTextChunks(): object[] {
  return [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } },
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_text.delta", delta: "Hello" },
    { type: "response.output_text.delta", delta: " world" },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } },
    },
  ];
}

/** Options every chatgpt provider entry in these tests shares. */
function chatgptOverride(tokenFile: string, tokenUrl: string): Partial<ProviderConfig> {
  return {
    apiKey: "",
    auth: { type: "chatgpt-oauth", tokenFile, tokenUrl },
    endpointPath: "/responses",
    wireApi: "responses",
    defaultModel: "gpt-5.2-codex",
    models: { "test-model": "gpt-5.2-codex", "sand-default": "gpt-5.2-codex" },
    compat: { supportsImages: false, supportsReasoningEffort: true },
  };
}

/** Collect the visible (non-final) text of a parsed response. */
function responseText(frames: InferenceStreamResponse[]): string {
  return frames
    .filter(
      (f) =>
        "textPart" in f && !(f as { textPart: { isFinal: boolean } }).textPart.isFinal,
    )
    .map((f) => (f as { textPart: { text: string } }).textPart.text)
    .join("");
}

describe("server integration: chatgpt oauth provider (responses wire api)", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;
  let tokenMock: { server: http.Server; url: string; refreshCalls: string[] };
  let tokenFile: string;

  beforeAll(async () => {
    tokenMock = await startOAuthTokenMock();
    tokenFile = writeChatgptTokenFile([
      chatgptAccount("acct-1", { accessToken: "tok-acct-1" }),
    ]);
    upstream = await startMockUpstream({
      sseChunks: responsesTextChunks(),
      authKeyStatus: { "tok-acct-1": 200 },
    });
    const config = makeConfig(
      { chatgpt: upstream.url },
      { providerOverrides: { chatgpt: chatgptOverride(tokenFile, tokenMock.url) } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server, tokenMock.server));

  it("streams responses-api events through translation with account headers", async () => {
    const { status, body } = await sendRequest(shim.port, basicRequest());
    expect(status).toBe(200);

    const { frames } = parseResponse(body);
    expect(frames.some((f) => "error" in f)).toBe(false);
    // Reasoning deltas + content deltas both surface as text frames.
    expect(responseText(frames)).toBe("thinkingHello world");
    const usage = frames.find((f) => "usage" in f) as
      | { usage: { promptTokens: number; completionTokens: number; totalTokens?: number } }
      | undefined;
    expect(usage?.usage.promptTokens).toBe(12);
    expect(usage?.usage.completionTokens).toBe(6);
    expect(usage?.usage.totalTokens).toBe(18);

    // The upstream saw the OAuth bearer + account header, and only one call
    // (token comfortably valid → no refresh round-trip).
    expect(upstream.receivedAuths).toEqual([`Bearer tok-acct-1`]);
    expect(upstream.receivedHeaderMaps[0]["chatgpt-account-id"]).toBe("acct-1");
    expect(upstream.callCount.value).toBe(1);
    expect(tokenMock.refreshCalls).toHaveLength(0);
  });
});

describe("server integration: chatgpt usage_limit_reached rotates account", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;
  let tokenMock: { server: http.Server; url: string; refreshCalls: string[] };

  beforeAll(async () => {
    tokenMock = await startOAuthTokenMock();
    // acct-1's refresh token is revoked: the forced refresh after the 429
    // fails fast (invalid_grant) and the request rotates to acct-2.
    const tokenFile = writeChatgptTokenFile([
      chatgptAccount("acct-1", {
        accessToken: "tok-acct-1",
        refreshToken: "rt-revoked-acct-1",
      }),
      chatgptAccount("acct-2", { accessToken: "tok-acct-2" }),
    ]);
    upstream = await startMockUpstream({
      authKeyStatus: { "tok-acct-1": 429, "tok-acct-2": 200 },
      authKeyBody: {
        "tok-acct-1": {
          error: { code: "usage_limit_reached", message: "usage limit reached" },
        },
      },
      authKeySseChunks: responsesTextChunks(),
    });
    const config = makeConfig(
      { chatgpt: upstream.url },
      { providerOverrides: { chatgpt: chatgptOverride(tokenFile, tokenMock.url) } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server, tokenMock.server));

  it("treats the 429 quota error as account-level and rotates keys", async () => {
    const { status, body } = await sendRequest(shim.port, basicRequest());
    expect(status).toBe(200);

    const { frames } = parseResponse(body);
    expect(frames.some((f) => "error" in f)).toBe(false);
    expect(responseText(frames)).toBe("thinkingHello world");
    expect(upstream.receivedAuths).toEqual(["Bearer tok-acct-1", "Bearer tok-acct-2"]);
    expect(upstream.callCount.value).toBe(2);
    // One forced refresh was attempted for the quota-exhausted account.
    expect(tokenMock.refreshCalls).toEqual(["rt-revoked-acct-1"]);
  });
});

describe("server integration: chatgpt 401 triggers token refresh then retry", () => {
  let shim: { server: http.Server; port: number };
  let upstream: MockUpstream;
  let tokenMock: { server: http.Server; url: string; refreshCalls: string[] };
  let tokenFile: string;

  beforeAll(async () => {
    tokenMock = await startOAuthTokenMock();
    // "tok-stale" is revoked server-side but not near expiry, so the first
    // call uses it as-is; the 401 hook force-refreshes and retries the same
    // account with "tok-fresh-acct-1".
    tokenFile = writeChatgptTokenFile([
      chatgptAccount("acct-1", { accessToken: "tok-stale" }),
    ]);
    upstream = await startMockUpstream({
      authKeyStatus: { "tok-stale": 401, "tok-fresh-acct-1": 200 },
      authKeySseChunks: responsesTextChunks(),
    });
    const config = makeConfig(
      { chatgpt: upstream.url },
      { providerOverrides: { chatgpt: chatgptOverride(tokenFile, tokenMock.url) } },
    );
    shim = await startShim(config);
  });

  afterAll(() => cleanup(shim.server, upstream.server, tokenMock.server));

  it("refreshes the access token once and retries the same account", async () => {
    const { status, body } = await sendRequest(shim.port, basicRequest());
    expect(status).toBe(200);

    const { frames } = parseResponse(body);
    expect(frames.some((f) => "error" in f)).toBe(false);
    expect(responseText(frames)).toBe("thinkingHello world");
    expect(upstream.receivedAuths).toEqual(["Bearer tok-stale", "Bearer tok-fresh-acct-1"]);
    expect(tokenMock.refreshCalls).toEqual(["rt-acct-1"]);

    // The refreshed tokens (incl. the rotated refresh token) were persisted.
    const persisted = new ChatGptTokenStore(tokenFile).load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].accessToken).toBe("tok-fresh-acct-1");
    expect(persisted[0].refreshToken).toBe("rt-acct-1-2");
  });
});
