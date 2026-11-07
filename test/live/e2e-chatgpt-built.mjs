/**
 * Black-box end-to-end test of the BUILT artifact (dist/shim.js) with the
 * ChatGPT OAuth provider — no vitest, no tsx: this spawns the real shim
 * binary as a child process against mock upstreams and drives it over
 * real HTTP with real Connect envelopes.
 *
 * Covered, end to end through the shipped bundle:
 *   A. Happy path — Responses SSE (reasoning + text + function_call +
 *      usage) translated to Connect frames, with OAuth bearer +
 *      chatgpt-account-id headers on the upstream call, zero token-endpoint
 *      traffic while the access token is comfortably valid.
 *   B. Quota exhaustion — 429 usage_limit_reached classifies as an account
 *      error: forced refresh fails (invalid_grant), the account rotates,
 *      and the sibling account serves the request.
 *
 * Run: node test/live/e2e-chatgpt-built.mjs   (exit 0 = pass)
 */
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHIM_BIN = path.join(ROOT, "dist", "shim.js");
const SHIM_PORT = 18790;
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";
const CONTENT_TYPE = "application/connect+json";

const log = (...args) => console.log(...args);
const fail = (msg) => {
  console.error(`\n❌ E2E FAILED: ${msg}`);
  dumpShimLog();
  process.exit(1);
};
function assert(cond, msg) {
  if (!cond) fail(msg);
}

// ---------------------------------------------------------------------------
// Connect envelope codec (5-byte header: 1 flag byte + 4 BE length bytes)
// ---------------------------------------------------------------------------

function encodeEnvelope(payload) {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(0x00, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function parseEnvelopes(buf) {
  const out = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const len = buf.readUInt32BE(offset + 1);
    if (offset + 5 + len > buf.length) break;
    out.push({ flags, data: buf.subarray(offset + 5, offset + 5 + len) });
    offset += 5 + len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mock upstreams
// ---------------------------------------------------------------------------

function sse(res, events) {
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Mock chatgpt.com/backend-api/codex: POST /backend-api/codex/responses. */
function startMockBackend() {
  const state = {
    calls: [], // {bearer, accountId, body}
  };
  // Behavior hooks swapped per scenario.
  let handler = () => ({ status: 500, body: { error: { message: "no scenario" } } });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bearer = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/, "");
      const accountId = req.headers["chatgpt-account-id"] ?? "";
      let requestBody = {};
      try {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        requestBody = { parseError: true };
      }
      state.calls.push({ bearer, accountId, body: requestBody });
      const result = handler(bearer, accountId, requestBody);
      if (result.status === 200) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, result.events);
      } else {
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        setHandler: (fn) => {
          handler = fn;
        },
      });
    });
  });
}

/** Mock auth.openai.com/oauth/token (refresh grant, rotation). */
function startMockTokenEndpoint() {
  const state = { refreshCalls: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const refreshToken = params.get("refresh_token") ?? "";
      state.refreshCalls.push(refreshToken);
      if (refreshToken.includes("revoked")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const accountId = (refreshToken.match(/acct-\d+/) ?? [, "acct-1"])[1];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: `tok-refreshed-${accountId}`,
          refresh_token: `${refreshToken}-2`,
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/oauth/token`,
        state,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Scenario payloads
// ---------------------------------------------------------------------------

const happyPathEvents = (model) => [
  { type: "response.created", response: { id: "resp_e2e" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } },
  { type: "response.reasoning_summary_text.delta", delta: "thinking" },
  { type: "response.output_text.delta", delta: "Hello" },
  { type: "response.output_text.delta", delta: " world" },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", id: "fc_e2e", call_id: "call_e2e", name: "get_weather" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_e2e", delta: '{"city":"NYC"}' },
  {
    type: "response.output_item.done",
    item: { type: "function_call", id: "fc_e2e", call_id: "call_e2e", name: "get_weather", arguments: '{"city":"NYC"}' },
  },
  {
    type: "response.completed",
    response: {
      usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
      model,
    },
  },
];

const quotaFallbackEvents = [
  { type: "response.created", response: {} },
  { type: "response.output_text.delta", delta: "from account two" },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } },
  },
];

function inferenceRequest() {
  return {
    requestedModel: { modelId: "gpt-5.2-codex" },
    messages: [{ role: 1, text: "hello" }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
  };
}

function postConnect(port, payload) {
  return new Promise((resolve, reject) => {
    const framed = encodeEnvelope(JSON.stringify(payload));
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
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(framed);
    req.end();
  });
}

function framesOf(body) {
  return parseEnvelopes(body)
    .filter((e) => (e.flags & 0x02) === 0)
    .map((e) => JSON.parse(e.data.toString("utf8")));
}

const textOf = (frames) =>
  frames
    .filter((f) => "textPart" in f && !f.textPart.isFinal)
    .map((f) => f.textPart.text)
    .join("");

// ---------------------------------------------------------------------------
// Shim child process
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "byok-e2e-built-"));
const shimLogFile = path.join(tmpDir, "shim.log");

function dumpShimLog() {
  try {
    console.error("--- shim.log (tail) ---");
    console.error(fs.readFileSync(shimLogFile, "utf8").split("\n").slice(-25).join("\n"));
  } catch {
    /* ignore */
  }
}

async function startShim(backendUrl, tokenUrl) {
  const tokenFile = path.join(tmpDir, "chatgpt-tokens.json");
  const now = Date.now();
  fs.writeFileSync(
    tokenFile,
    JSON.stringify(
      {
        version: 1,
        accounts: [
          {
            accountId: "acct-1",
            accessToken: "tok-acct-1",
            refreshToken: "rt-revoked-acct-1",
            expiresAtMs: now + 55 * 60 * 1000,
            obtainedAtMs: now,
            enabled: true,
          },
          {
            accountId: "acct-2",
            accessToken: "tok-acct-2",
            refreshToken: "rt-acct-2",
            expiresAtMs: now + 55 * 60 * 1000,
            obtainedAtMs: now,
            enabled: true,
          },
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        port: SHIM_PORT,
        host: "127.0.0.1",
        logDir: "",
        failover: true,
        requestTimeoutMs: 10000,
        routingStrategy: "priority",
        sessionAffinity: { enabled: false },
        providers: {
          priority: ["chatgpt"],
          configs: {
            chatgpt: {
              baseUrl: backendUrl,
              apiKey: "",
              auth: { type: "chatgpt-oauth", tokenFile, tokenUrl },
              endpointPath: "/responses",
              wireApi: "responses",
              defaultModel: "gpt-5.2-codex",
              models: { "gpt-5.2-codex": "gpt-5.2-codex" },
              network: { maxRetries: 1 },
            },
          },
        },
        hostConfig: { sandHostDir: "", defaultModel: "gpt-5.2-codex" },
      },
      null,
      2,
    ),
  );

  assert(fs.existsSync(SHIM_BIN), `dist/shim.js not found — run npm run build first`);
  const logStream = fs.openSync(shimLogFile, "a");
  const child = spawn(process.execPath, [SHIM_BIN], {
    env: { ...process.env, SHIM_CONFIG: configPath },
    stdio: ["ignore", logStream, logStream],
  });
  child.on("exit", (code) => {
    if (!shimStopped && code !== null && code !== 0) {
      fail(`shim child exited early with code ${code}`);
    }
  });

  // Wait until the shim answers HTTP (any status) on the stream port.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const probe = http.request(
          { hostname: "127.0.0.1", port: SHIM_PORT, path: "/", method: "GET", timeout: 500 },
          (res) => {
            res.resume();
            resolve();
          },
        );
        probe.on("timeout", () => {
          probe.destroy();
          reject(new Error("probe timeout"));
        });
        probe.on("error", reject);
        probe.end();
      });
      break;
    } catch {
      if (Date.now() > deadline) fail("shim did not come up within 15s");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { child, tokenFile };
}

let shimStopped = false;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const backend = await startMockBackend();
const tokenEndpoint = await startMockTokenEndpoint();
const { child, tokenFile } = await startShim(backend.url, tokenEndpoint.url);

try {
  // ---- Scenario A: happy path through the built bundle -------------------
  log("→ Scenario A: responses stream (reasoning + text + tool call + usage)");
  backend.setHandler((bearer) =>
    bearer === "tok-acct-1"
      ? { status: 200, events: happyPathEvents("gpt-5.2-codex") }
      : { status: 500, body: { error: { message: "unexpected bearer" } } },
  );

  const a = await postConnect(SHIM_PORT, inferenceRequest());
  assert(a.status === 200, `scenario A: expected HTTP 200, got ${a.status}`);
  const framesA = framesOf(a.body);
  assert(!framesA.some((f) => "error" in f), `scenario A: unexpected error frame: ${JSON.stringify(framesA.find((f) => "error" in f))}`);
  assert(textOf(framesA) === "thinkingHello world", `scenario A: text was "${textOf(framesA)}"`);
  const toolFrame = framesA.find((f) => "toolCallPart" in f);
  assert(!!toolFrame, "scenario A: no toolCallPart frame");
  assert(toolFrame.toolCallPart.toolName === "get_weather", "scenario A: wrong tool name");
  assert(toolFrame.toolCallPart.args === '{"city":"NYC"}', `scenario A: tool args were "${toolFrame.toolCallPart.args}"`);
  assert(toolFrame.toolCallPart.isComplete === true, "scenario A: tool call not marked complete");
  const usageA = framesA.find((f) => "usage" in f);
  assert(usageA?.usage.promptTokens === 12 && usageA?.usage.completionTokens === 6, "scenario A: usage mismatch");
  assert(backend.state.calls.length === 1, `scenario A: expected 1 upstream call, got ${backend.state.calls.length}`);
  assert(backend.state.calls[0].bearer === "tok-acct-1", "scenario A: wrong bearer");
  assert(backend.state.calls[0].accountId === "acct-1", "scenario A: chatgpt-account-id header missing/wrong");
  // Responses wire format actually reached the upstream:
  assert(!("messages" in backend.state.calls[0].body), "scenario A: upstream body still Chat Completions shaped");
  assert(Array.isArray(backend.state.calls[0].body.input), "scenario A: upstream body missing Responses input array");
  assert(backend.state.calls[0].body.store === false && backend.state.calls[0].body.stream === true, "scenario A: store/stream flags wrong");
  assert(tokenEndpoint.state.refreshCalls.length === 0, "scenario A: unexpected token refresh");
  log("  ✅ text + reasoning + tool call + usage + account headers + responses wire format");

  // ---- Scenario B: 429 usage_limit_reached rotates account ---------------
  log("→ Scenario B: usage_limit_reached 429 → forced refresh fails → rotate");
  backend.setHandler((bearer) => {
    if (bearer === "tok-acct-1") {
      return {
        status: 429,
        body: { error: { code: "usage_limit_reached", message: "You've hit your usage limit" } },
      };
    }
    return { status: 200, events: quotaFallbackEvents };
  });

  const callsBefore = backend.state.calls.length;
  const refreshesBefore = tokenEndpoint.state.refreshCalls.length;
  const b = await postConnect(SHIM_PORT, inferenceRequest());
  assert(b.status === 200, `scenario B: expected HTTP 200, got ${b.status}`);
  const framesB = framesOf(b.body);
  assert(!framesB.some((f) => "error" in f), `scenario B: unexpected error frame: ${JSON.stringify(framesB.find((f) => "error" in f))}`);
  assert(textOf(framesB) === "from account two", `scenario B: text was "${textOf(framesB)}"`);
  const newCalls = backend.state.calls.slice(callsBefore);
  assert(newCalls.length === 2, `scenario B: expected 2 upstream calls, got ${newCalls.length}`);
  assert(newCalls[0].bearer === "tok-acct-1" && newCalls[1].bearer === "tok-acct-2", `scenario B: rotation order wrong: ${newCalls.map((c) => c.bearer).join(" → ")}`);
  assert(tokenEndpoint.state.refreshCalls.length === refreshesBefore + 1, "scenario B: expected exactly one forced refresh");
  assert(tokenEndpoint.state.refreshCalls[tokenEndpoint.state.refreshCalls.length - 1] === "rt-revoked-acct-1", "scenario B: wrong account refreshed");
  // The quota-exhausted account is disabled in the persisted store.
  const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  assert(persisted.accounts.find((x) => x.accountId === "acct-1")?.enabled === false, "scenario B: acct-1 not disabled after invalid_grant");
  assert(persisted.accounts.find((x) => x.accountId === "acct-2")?.enabled === true, "scenario B: acct-2 should stay enabled");
  log("  ✅ account rotated, forced refresh attempted once, store persisted with disabled account");

  log("\n🎉 E2E PASSED — built shim + chatgpt OAuth provider verified end to end");
  process.exitCode = 0;
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  shimStopped = true;
  child.kill("SIGTERM");
  backend.server.close();
  tokenEndpoint.server.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
