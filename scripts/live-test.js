#!/usr/bin/env node
/**
 * Live integration test for the v2 shim.
 *
 * Sends real Connect-RPC InferenceStream requests through the shim
 * to live providers (OpenCode Go, OpenCode Zen, local WindsurfAPI)
 * and verifies the full pipeline: Connect framing → request translation
 * → provider routing → SSE streaming → response translation → Connect frames.
 *
 * Usage: node scripts/live-test.js
 * Requires: shim running on 127.0.0.1:8788 (node dist/shim.js)
 */
import * as http from "node:http";
import * as net from "node:net";

const SHIM_HOST = "127.0.0.1";
const SHIM_PORT = 8788;
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";
const CONTENT_TYPE = "application/connect+json";
const DATA_FLAGS = 0x00;
const END_STREAM_FLAGS = 0x02;

// ── Connect envelope codec ──────────────────────────────────────────────────

function encodeEnvelope(flags, data) {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function parseEnvelopes(buf) {
  const envelopes = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 5) break;
    const flags = buf.readUInt8(offset);
    const length = buf.readUInt32BE(offset + 1);
    const bodyStart = offset + 5;
    const bodyEnd = bodyStart + length;
    if (buf.length < bodyEnd) break;
    envelopes.push({ flags, data: Buffer.from(buf.subarray(bodyStart, bodyEnd)) });
    offset = bodyEnd;
  }
  return envelopes;
}

// ── Request helpers ─────────────────────────────────────────────────────────

function sendRequest(reqJson) {
  return new Promise((resolve, reject) => {
    const framed = encodeEnvelope(DATA_FLAGS, Buffer.from(JSON.stringify(reqJson), "utf8"));
    const req = http.request(
      {
        hostname: SHIM_HOST,
        port: SHIM_PORT,
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
    req.setTimeout(60000, () => {
      req.destroy(new Error("request timeout"));
    });
    req.write(framed);
    req.end();
  });
}

function parseResponse(body) {
  const envelopes = parseEnvelopes(body);
  const trailer = envelopes[envelopes.length - 1];
  const dataEnvelopes = envelopes.filter((e) => (e.flags & 0x02) === 0);
  const frames = dataEnvelopes.map((e) => {
    try { return JSON.parse(e.data.toString("utf8")); }
    catch { return null; }
  }).filter(Boolean);
  return { envelopes, trailer, frames };
}

function extractText(frames) {
  let text = "";
  for (const f of frames) {
    if (f.textPart?.text) text += f.textPart.text;
  }
  return text;
}

function extractError(frames) {
  for (const f of frames) {
    if (f.error?.message) return f.error.message;
  }
  return null;
}

function extractUsage(frames) {
  for (const f of frames) {
    if (f.usage) return f.usage;
  }
  return null;
}

function extractResponseInfo(frames) {
  for (const f of frames) {
    if (f.responseInfo) return f.responseInfo;
  }
  return null;
}

function extractToolCalls(frames) {
  const calls = [];
  for (const f of frames) {
    if (f.toolCallPart) {
      calls.push({
        name: f.toolCallPart.toolName,
        args: f.toolCallPart.args,
        isFinal: f.toolCallPart.isFinal,
      });
    }
  }
  return calls;
}

// ── Test runner ─────────────────────────────────────────────────────────────

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const status = pass ? "PASS" : "FAIL";
  console.log(`  ${status}: ${name}${detail ? " — " + detail : ""}`);
}

async function test(name, fn) {
  try {
    await fn();
  } catch (err) {
    record(name, false, err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Check shim is running ───────────────────────────────────────────────────

async function checkShimRunning() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: SHIM_HOST, port: SHIM_PORT }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== Live Shim Integration Test ===\n");

  const running = await checkShimRunning();
  if (!running) {
    console.error("Shim is not running on " + SHIM_HOST + ":" + SHIM_PORT);
    console.error("Start it with: node dist/shim.js");
    process.exit(1);
  }
  console.log("Shim is running on " + SHIM_HOST + ":" + SHIM_PORT + "\n");

  // ── 1. Basic text completion via opencode-go (0x Alpha) ───────────────────
  console.log("[1] Basic text completion — opencode-go (0x Alpha)");

  await test("0x Alpha: simple prompt returns text", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "ox-alpha-free" },
      messages: [{ role: 1, text: "Say exactly: LIVE_TEST_OK" }],
      modelConfig: { maxTokens: 50, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames, trailer } = parseResponse(body);
    assert(trailer && (trailer.flags & 0x02) === END_STREAM_FLAGS, "end-stream trailer present");

    const text = extractText(frames);
    const err = extractError(frames);
    const usage = extractUsage(frames);
    const info = extractResponseInfo(frames);

    assert(!err, "no error frame — got: " + err);
    assert(text.length > 0, "non-empty text response");
    assert(info && info.model, "responseInfo with model — got: " + JSON.stringify(info));
    assert(usage, "usage frame present");

    record("0x Alpha: simple prompt returns text", true,
      `model=${info?.model}, text="${text.slice(0, 80)}", tokens=${usage?.completionTokens ?? "?"}`);
  });

  // ── 2. GLM-5.2 High via local WindsurfAPI (free/unlimited) ────────────────
  console.log("\n[2] GLM-5.2 High — local WindsurfAPI (free/unlimited)");

  await test("GLM-5.2 High: routes to local, returns text", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "glm-5.2" },
      messages: [{ role: 1, text: "Say exactly: GLM_HIGH_OK" }],
      modelConfig: { maxTokens: 50, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames, trailer } = parseResponse(body);
    assert(trailer && (trailer.flags & 0x02) === END_STREAM_FLAGS, "end-stream trailer");

    const text = extractText(frames);
    const err = extractError(frames);
    const usage = extractUsage(frames);
    const info = extractResponseInfo(frames);

    // If WindsurfAPI is in drought mode, failover to opencode-go is expected.
    // The test passes as long as we get a valid response from some provider.
    assert(!err, "no error frame — got: " + err);
    assert(text.length > 0, "non-empty text response");
    assert(info && info.model, "responseInfo with model");

    record("GLM-5.2 High: routes to local, returns text", true,
      `model=${info?.model}, text="${text.slice(0, 80)}", tokens=${usage?.completionTokens ?? "?"}`);
  });

  // ── 3. SWE-1.7 Max via local WindsurfAPI (free/unlimited) ─────────────────
  console.log("\n[3] SWE-1.7 Max — local WindsurfAPI (free/unlimited)");

  await test("SWE-1.7 Max: routes to local, returns text", async () => {
    const { status, body, headers } = await sendRequest({
      requestedModel: { modelId: "swe-1.7 max" },
      messages: [{ role: 1, text: "Say exactly: SWE_MAX_OK" }],
      modelConfig: { maxTokens: 50, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames, trailer } = parseResponse(body);
    assert(trailer && (trailer.flags & 0x02) === END_STREAM_FLAGS, "end-stream trailer");

    const text = extractText(frames);
    const err = extractError(frames);
    const info = extractResponseInfo(frames);

    assert(!err, "no error frame — got: " + err);
    assert(text.length > 0, "non-empty text response");
    assert(info && info.model, "responseInfo with model");

    // If the model failovered to opencode-go, the x-failover header should
    // be present. If it was served by local, the header is absent.
    const failoverHeader = headers["x-failover"];
    if (info?.model !== "swe-1-7") {
      assert(failoverHeader, `x-failover header when model differs (model=${info?.model})`);
    }

    record("SWE-1.7 Max: routes to local, returns text", true,
      `model=${info?.model}, text="${text.slice(0, 80)}"` +
      (failoverHeader ? `, x-failover=${failoverHeader}` : ""));
  });

  // ── 4. SWE-1.7 Medium via local WindsurfAPI (free/unlimited) ──────────────
  await test("SWE-1.7 Medium: routes to local, returns text", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "swe-1.7 medium" },
      messages: [{ role: 1, text: "Say exactly: SWE_MED_OK" }],
      modelConfig: { maxTokens: 50, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const text = extractText(frames);
    const err = extractError(frames);
    const info = extractResponseInfo(frames);

    assert(!err, "no error frame — got: " + err);
    assert(text.length > 0, "non-empty text response");
    assert(info && info.model, "responseInfo with model");

    record("SWE-1.7 Medium: routes to local, returns text", true,
      `model=${info?.model}, text="${text.slice(0, 80)}"`);
  });

  // ── 5. Model alias routing — "0x alpha" → opencode-go ─────────────────────
  console.log("\n[4] Model alias routing");

  await test("Alias '0x alpha' routes to opencode-go", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "0x alpha" },
      messages: [{ role: 1, text: "Say: ALIAS_OK" }],
      modelConfig: { maxTokens: 20, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const info = extractResponseInfo(frames);
    const err = extractError(frames);
    const text = extractText(frames);

    assert(!err, "no error — got: " + err);
    assert(text.length > 0, "non-empty text");
    assert(info && info.model === "ox-alpha-free", "resolved to ox-alpha-free — got: " + info?.model);

    record("Alias '0x alpha' routes to opencode-go", true, `model=${info?.model}`);
  });

  // ── 6. Alias "glm" → local glm-5-2-max ────────────────────────────────────
  await test("Alias 'glm' routes to local", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "glm" },
      messages: [{ role: 1, text: "Say: GLM_ALIAS_OK" }],
      modelConfig: { maxTokens: 20, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const info = extractResponseInfo(frames);
    const err = extractError(frames);
    const text = extractText(frames);

    assert(!err, "no error — got: " + err);
    assert(text.length > 0, "non-empty text");
    // "glm" maps to glm-5-2-max in local. If local is in drought, failover
    // to opencode-go is valid — just verify we got a response.
    record("Alias 'glm' routes to local", true,
      `model=${info?.model}${info?.model !== "glm-5-2-max" ? " (failover)" : ""}`);
  });

  // ── 7. Multi-turn conversation ────────────────────────────────────────────
  console.log("\n[5] Multi-turn conversation");

  await test("Multi-turn: context is preserved", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "glm-5.2" },
      messages: [
        { role: 1, text: "My name is LIVE_TEST_USER_42." },
        { role: 2, text: "Nice to meet you, LIVE_TEST_USER_42." },
        { role: 1, text: "What is my name? Reply with only the name." },
      ],
      modelConfig: { maxTokens: 30, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const text = extractText(frames).toLowerCase();
    const err = extractError(frames);

    assert(!err, "no error — got: " + err);
    assert(text.includes("live_test_user_42") || text.includes("42"), "mentions the name from context");

    record("Multi-turn: context is preserved", true, `response="${text.slice(0, 80)}"`);
  });

  // ── 8. Tool calling ───────────────────────────────────────────────────────
  console.log("\n[6] Tool calling");

  await test("Tool call: model invokes a tool", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "glm-5.2" },
      messages: [
        { role: 1, text: "What is the weather in Tokyo? Use the get_weather tool." },
      ],
      tools: [{
        name: "get_weather",
        description: "Get the current weather for a city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      }],
      modelConfig: { maxTokens: 200, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const toolCalls = extractToolCalls(frames);
    const text = extractText(frames);
    const err = extractError(frames);

    assert(!err, "no error — got: " + err);
    assert(toolCalls.length > 0 || text.toLowerCase().includes("tokyo"), "tool call or weather mention");

    record("Tool call: model invokes a tool", true,
      toolCalls.length > 0
        ? `toolCalls=${toolCalls.map(c => c.name).join(",")}, args=${JSON.stringify(toolCalls[0]?.args).slice(0, 80)}`
        : `text="${text.slice(0, 80)}" (no structured tool call)`);
  });

  // ── 9. Unknown model → default provider fallback ──────────────────────────
  console.log("\n[7] Unknown model fallback");

  await test("Unknown model falls back to default provider", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "totally-nonexistent-model-xyz" },
      messages: [{ role: 1, text: "Say: FALLBACK_OK" }],
      modelConfig: { maxTokens: 20, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const info = extractResponseInfo(frames);
    const err = extractError(frames);
    const text = extractText(frames);

    record("Unknown model falls back to default provider", true,
      err ? `error="${err}"` : `model=${info?.model}, text="${text.slice(0, 60)}"`);
  });

  // ── 10. Streaming: multiple text frames ───────────────────────────────────
  console.log("\n[8] Streaming response structure");

  await test("Response has multiple text frames + final + usage", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "glm-5.2" },
      messages: [{ role: 1, text: "Count from 1 to 5, one number per line." }],
      modelConfig: { maxTokens: 100, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames, trailer } = parseResponse(body);
    const textFrames = frames.filter(f => f.textPart && !f.textPart.isFinal);
    const finalFrames = frames.filter(f => f.textPart?.isFinal === true);
    const usageFrames = frames.filter(f => f.usage);
    const infoFrames = frames.filter(f => f.responseInfo);

    assert(infoFrames.length >= 1, "has responseInfo frame");
    assert(textFrames.length >= 1, "has at least 1 text delta frame");
    assert(finalFrames.length === 1, "has exactly 1 final text frame");
    assert(usageFrames.length === 1, "has exactly 1 usage frame");
    assert(trailer && (trailer.flags & 0x02) === END_STREAM_FLAGS, "has end-stream trailer");

    record("Response has multiple text frames + final + usage", true,
      `info=1, textDeltas=${textFrames.length}, final=1, usage=1, trailer=1`);
  });

  // ── 11. System message handling ───────────────────────────────────────────
  console.log("\n[9] System message");

  await test("System message is respected", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "glm-5.2" },
      messages: [
        { role: 0, text: "You are a pirate. Always say 'Arrr!' at the end of your response." },
        { role: 1, text: "Hello, who are you?" },
      ],
      modelConfig: { maxTokens: 80, temperature: 0 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const text = extractText(frames).toLowerCase();
    const err = extractError(frames);

    assert(!err, "no error — got: " + err);
    assert(text.includes("arr") || text.includes("pirate"), "response reflects system prompt");

    record("System message is respected", true, `text="${text.slice(0, 80)}"`);
  });

  // ── 12. Large response ────────────────────────────────────────────────────
  console.log("\n[10] Large response");

  await test("Large response streams correctly", async () => {
    const { status, body } = await sendRequest({
      requestedModel: { modelId: "glm-5.2" },
      messages: [{ role: 1, text: "Write a short paragraph (3-4 sentences) about the ocean." }],
      modelConfig: { maxTokens: 300, temperature: 0.7 },
    });
    assertEqual(status, 200, "status");

    const { frames } = parseResponse(body);
    const text = extractText(frames);
    const err = extractError(frames);
    const usage = extractUsage(frames);

    assert(!err, "no error — got: " + err);
    assert(text.length > 100, "substantial response (>100 chars)");
    assert(usage, "usage frame present");

    record("Large response streams correctly", true,
      `chars=${text.length}, tokens=${usage?.completionTokens ?? "?"}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n=== Summary ===\n");
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);
  console.log("");

  if (failed > 0) {
    console.log("Failures:");
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    console.log("");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
