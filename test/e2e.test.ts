/**
 * End-to-end test that boots the shim server and sends a real Connect-framed
 * request over HTTP. With no real upstream available (providers pointed at a
 * closed localhost port), every provider fails and the server must emit an
 * error frame followed by an end-stream trailer rather than hanging.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import {
  encodeEnvelope,
  parseEnvelopes,
  DATA_FLAGS,
  END_STREAM_FLAGS,
  CONTENT_TYPE,
} from "../src/protocol/connect.js";
import type { InferenceStreamRequest, ShimConfig } from "../src/types.js";

const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";

/** A config where every provider points at a closed localhost port. */
function closedUpstreamConfig(): ShimConfig {
  const base = loadConfig();
  const closedUrl = "http://127.0.0.1:1/v1";
  const configs: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(base.providers.configs)) {
    configs[name] = {
      ...cfg,
      baseUrl: closedUrl,
      apiKey: "",
    };
  }
  return {
    ...base,
    port: 0,
    host: "127.0.0.1",
    requestTimeoutMs: 1000,
    failover: true,
    providers: {
      priority: base.providers.priority,
      configs: configs as ShimConfig["providers"]["configs"],
    },
  };
}

/** POST a Connect-framed request and resolve with the full response buffer. */
function sendRequest(
  port: number,
  reqJson: InferenceStreamRequest,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(reqJson), "utf8");
    const framed = encodeEnvelope(DATA_FLAGS, data);
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
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(framed);
    req.end();
  });
}

describe("e2e: shim server with no upstream", () => {
  let server: http.Server;
  let port: number;

  beforeAll(() => {
    const config = closedUpstreamConfig();
    server = createServer(config, createLogger());
    return new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
          resolve();
        } else {
          reject(new Error("server did not bind to a port"));
        }
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it(
    "returns an error frame and end-stream trailer for sand-default",
    async () => {
      const reqJson: InferenceStreamRequest = {
        requestedModel: { modelId: "sand-default" },
        messages: [{ role: 1, text: "hello" }],
      };

      const { status, headers, body } = await sendRequest(port, reqJson);

      // Connect streaming always responds with HTTP 200; errors are in frames.
      expect(status).toBe(200);
      expect(headers["content-type"]).toBe(CONTENT_TYPE);

      const envelopes = parseEnvelopes(body);
      expect(envelopes.length).toBeGreaterThanOrEqual(2);

      // The last envelope must be the end-stream trailer.
      const trailer = envelopes[envelopes.length - 1];
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      // At least one data frame must be an error frame.
      const dataFrames = envelopes.filter((e) => (e.flags & 0x02) === 0);
      const parsed = dataFrames.map((e) =>
        JSON.parse(e.data.toString("utf8")) as Record<string, unknown>,
      );
      const errorFrame = parsed.find((f) => "error" in f);
      expect(errorFrame).toBeDefined();
      expect((errorFrame!.error as Record<string, unknown>).message).toEqual(
        expect.any(String),
      );
    },
    5000,
  );

  it(
    "routes an unknown model to the default provider and still fails gracefully",
    async () => {
      const reqJson: InferenceStreamRequest = {
        requestedModel: { modelId: "does-not-exist" },
        messages: [{ role: 1, text: "hi" }],
      };

      const { status, body } = await sendRequest(port, reqJson);
      expect(status).toBe(200);

      const envelopes = parseEnvelopes(body);
      const trailer = envelopes[envelopes.length - 1];
      expect(trailer.flags & 0x02).toBe(END_STREAM_FLAGS);

      const dataFrames = envelopes.filter((e) => (e.flags & 0x02) === 0);
      const parsed = dataFrames.map((e) =>
        JSON.parse(e.data.toString("utf8")) as Record<string, unknown>,
      );
      expect(parsed.some((f) => "error" in f)).toBe(true);
    },
    5000,
  );
});
