/**
 * Real-traffic smoke test for the chatgpt OAuth provider.
 *
 * Sends one Connect-framed inference request for gpt-5.2-codex through the
 * running shim (127.0.0.1:8788) and prints the translated text, reasoning,
 * usage, and any tool call. Requires: `npm run chatgpt:login` completed and
 * the shim restarted (`npm start`).
 *
 * Usage:
 *   node test/live/chatgpt-smoke.mjs                 # text round-trip
 *   node test/live/chatgpt-smoke.mjs --tools         # also exercise a tool call
 *   SHIM_PORT=8788 MODEL=gpt-5.2-codex node test/live/chatgpt-smoke.mjs
 */
import * as http from "node:http";

const SHIM_HOST = process.env.SHIM_HOST ?? "127.0.0.1";
const SHIM_PORT = Number(process.env.SHIM_PORT ?? 8788);
const MODEL = process.env.MODEL ?? "gpt-5.2-codex";
const WITH_TOOLS = process.argv.includes("--tools");

const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";
const CONTENT_TYPE = "application/connect+json";

function encodeEnvelope(flags, data) {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
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

const request = {
  requestedModel: { modelId: MODEL },
  messages: [
    {
      role: 1,
      text: WITH_TOOLS
        ? "What is the weather in New York City? Use the get_weather tool."
        : "Reply with exactly one short sentence: what model are you?",
    },
    ...(WITH_TOOLS
      ? []
      : []),
  ],
  modelConfig: { maxTokens: 200, temperature: 0 },
  ...(WITH_TOOLS
    ? {
        tools: [
          {
            name: "get_weather",
            description: "Get current weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      }
    : {}),
};

const framed = encodeEnvelope(0x00, Buffer.from(JSON.stringify(request), "utf8"));

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
    res.on("end", () => {
      const frames = parseEnvelopes(Buffer.concat(chunks))
        .filter((e) => (e.flags & 0x02) === 0)
        .map((e) => JSON.parse(e.data.toString("utf8")));

      const error = frames.find((f) => "error" in f);
      const info = frames.find((f) => "responseInfo" in f)?.responseInfo;
      const text = frames
        .filter((f) => "textPart" in f && !f.textPart.isFinal)
        .map((f) => f.textPart.text)
        .join("");
      const usage = frames.find((f) => "usage" in f)?.usage;
      const toolCalls = frames
        .filter((f) => "toolCallPart" in f)
        .map((f) => f.toolCallPart);

      console.log(`HTTP ${res.statusCode}  x-failover: ${res.headers["x-failover"] ?? "(none)"}`);
      console.log(`model:  ${info?.model ?? "?"}`);
      if (error) {
        console.log(`ERROR:  ${JSON.stringify(error.error)}`);
        process.exit(1);
      }
      console.log(`text:   ${JSON.stringify(text.slice(0, 400))}`);
      for (const tc of toolCalls) {
        console.log(`tool:   ${tc.toolName}(${tc.args}) complete=${tc.isComplete}`);
      }
      console.log(
        `usage:  prompt=${usage?.promptTokens ?? "?"} completion=${usage?.completionTokens ?? "?"}` +
          ` total=${usage?.totalTokens ?? "?"} reasoning=${usage?.reasoningTokens ?? "-"}`,
      );
      if (!text && toolCalls.length === 0) {
        console.log("FAIL: no visible content");
        process.exit(1);
      }
      console.log("SMOKE OK");
    });
  },
);
req.on("error", (err) => {
  console.error(`request failed: ${err.message} (is the shim running on ${SHIM_HOST}:${SHIM_PORT}?)`);
  process.exit(1);
});
req.write(framed);
req.end();
