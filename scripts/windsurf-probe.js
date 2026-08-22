#!/usr/bin/env node
/**
 * Empirically probe every model exposed by WindsurfAPI.
 *
 * Sends a minimal non-streaming chat completion to each model and records
 * whether it works, is blocked by drought mode, is blocked by quota, or
 * returns some other error. Outputs a full report at the end.
 *
 * Usage: node scripts/windsurf-probe.js
 */
import * as http from "node:http";

const HOST = "127.0.0.1";
const PORT = 3003;
const API_KEY = "sk-local-test";
const TIMEOUT_MS = 30000;

function fetchModels() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: "/v1/models",
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const d = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(d.data?.map((m) => m.id) ?? []);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function testModel(modelId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 10,
      stream: false,
    });
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const d = JSON.parse(raw);
            if (d.choices && d.choices.length > 0) {
              const content = d.choices[0].message?.content ?? "";
              resolve({ status: "ok", httpStatus: res.statusCode, content: content.slice(0, 60), usage: d.usage });
            } else if (d.error) {
              const msg = d.error.message ?? "?";
              if (msg.includes("drought") || msg.includes("配额低水位")) {
                resolve({ status: "drought", httpStatus: res.statusCode, msg: msg.slice(0, 100) });
              } else if (msg.includes("quota") || msg.includes("exhausted") || msg.includes("usage")) {
                resolve({ status: "quota", httpStatus: res.statusCode, msg: msg.slice(0, 100) });
              } else if (msg.includes("not found") || msg.includes("model_not_found") || msg.includes("不可用")) {
                resolve({ status: "notfound", httpStatus: res.statusCode, msg: msg.slice(0, 100) });
              } else if (msg.includes("permission") || msg.includes("denied")) {
                resolve({ status: "denied", httpStatus: res.statusCode, msg: msg.slice(0, 100) });
              } else {
                resolve({ status: "error", httpStatus: res.statusCode, msg: msg.slice(0, 120) });
              }
            } else {
              resolve({ status: "unknown", httpStatus: res.statusCode, raw: raw.slice(0, 120) });
            }
          } catch {
            resolve({ status: "parseerror", httpStatus: res.statusCode, raw: raw.slice(0, 120) });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ status: "network", msg: e.message }));
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve({ status: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`\n=== WindsurfAPI Model Probe ===\n`);
  console.log(`Fetching model list from ${HOST}:${PORT}...`);

  const models = await fetchModels();
  console.log(`Found ${models.length} models. Testing each one...\n`);

  const results = [];
  let done = 0;

  for (const model of models) {
    process.stdout.write(`\r  [${done + 1}/${models.length}] ${model.padEnd(45)} `);
    const result = await testModel(model);
    results.push({ model, ...result });
    done++;
    const tag =
      result.status === "ok" ? "OK" :
      result.status === "drought" ? "DROUGHT" :
      result.status === "quota" ? "QUOTA" :
      result.status === "notfound" ? "NOTFOUND" :
      result.status === "denied" ? "DENIED" :
      result.status === "timeout" ? "TIMEOUT" :
      result.status === "network" ? "NET" :
      "ERR";
    process.stdout.write(tag);
  }

  console.log("\n");

  // ── Summary ─────────────────────────────────────────────────────────────
  const byStatus = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }

  console.log("=== Summary ===\n");
  for (const [status, count] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(12)} ${count}`);
  }
  console.log(`  ${"TOTAL".padEnd(12)} ${results.length}\n`);

  // ── Working models ──────────────────────────────────────────────────────
  const working = results.filter((r) => r.status === "ok");
  if (working.length > 0) {
    console.log(`=== Working Models (${working.length}) ===\n`);
    for (const r of working) {
      console.log(`  ${r.model.padEnd(45)} "${r.content}"  tokens=${r.usage?.completion_tokens ?? "?"}`);
    }
  } else {
    console.log("=== No Working Models ===\n");
    console.log("All models are blocked. Check drought mode and quota.\n");
  }

  // ── Blocked by drought ──────────────────────────────────────────────────
  const drought = results.filter((r) => r.status === "drought");
  if (drought.length > 0) {
    console.log(`\n=== Blocked by Drought Mode (${drought.length}) ===\n`);
    for (const r of drought) {
      console.log(`  ${r.model}`);
    }
  }

  // ── Blocked by quota ────────────────────────────────────────────────────
  const quota = results.filter((r) => r.status === "quota");
  if (quota.length > 0) {
    console.log(`\n=== Blocked by Quota Exhaustion (${quota.length}) ===\n`);
    for (const r of quota) {
      console.log(`  ${r.model}`);
    }
  }

  // ── Other errors ────────────────────────────────────────────────────────
  const other = results.filter((r) => !["ok", "drought", "quota"].includes(r.status));
  if (other.length > 0) {
    console.log(`\n=== Other Errors (${other.length}) ===\n`);
    for (const r of other) {
      console.log(`  ${r.model.padEnd(45)} [${r.status}] ${r.msg ?? r.raw ?? ""}`);
    }
  }

  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
