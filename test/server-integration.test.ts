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
}

interface MockUpstream {
  server: http.Server;
  port: number;
  url: string;
  /** Mutable call counter. */
  callCount: { value: number };
  /** Authorization headers received, in call order. */
  receivedAuths: string[];
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

    const server = http.createServer((req, res) => {
      callCount.value++;
      const auth = (req.headers["authorization"] as string | undefined) ?? "";
      receivedAuths.push(auth);

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
          for (const chunk of sseChunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(status, {
            "Content-Type": "application/json",
            ...(opts.headers ?? {}),
          });
          res.end(JSON.stringify({ error: { message: `mock ${status}` } }));
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

      const { envelopes, trailer, frames } = parseResponse(body);

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
    "emits a 'request error' frame and does not fail over",
    async () => {
      const { status, body } = await sendRequest(shim.port, basicRequest());
      expect(status).toBe(200);

      const { trailer, frames } = parseResponse(body);
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      const errorFrame = frames.find((f) => "error" in f) as
        | { error: { message: string } }
        | undefined;
      expect(errorFrame).toBeDefined();
      expect(errorFrame!.error.message).toBe("request error");

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
