#!/usr/bin/env node
/**
 * Slowly test specific models with delays to avoid rate limiting.
 * Tests all reasoning modes for each model family.
 */
import * as http from "node:http";

const HOST = "127.0.0.1";
const PORT = 3003;
const API_KEY = "sk-local-test";

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
        hostname: HOST, port: PORT,
        path: "/v1/chat/completions", method: "POST",
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
              resolve({ ok: true, content: d.choices[0].message?.content?.slice(0, 50) ?? "" });
            } else if (d.error) {
              const msg = d.error.message ?? "?";
              if (msg.includes("quota") || msg.includes("exhausted")) resolve({ ok: false, reason: "quota" });
              else if (msg.includes("rate-limited") || msg.includes("Retry in")) resolve({ ok: false, reason: "rate-limited" });
              else if (msg.includes("drought") || msg.includes("配额")) resolve({ ok: false, reason: "drought" });
              else if (msg.includes("permission") || msg.includes("denied")) resolve({ ok: false, reason: "denied" });
              else resolve({ ok: false, reason: msg.slice(0, 80) });
            } else {
              resolve({ ok: false, reason: "unknown" });
            }
          } catch {
            resolve({ ok: false, reason: "parse error" });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, reason: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // All SWE + GLM variants and reasoning modes
  const models = [
    // SWE family — all variants
    "swe-1-7",
    "swe-1-7-medium",
    "swe-1-7-lightning",
    "swe-1-7-lightning-medium",
    "swe-1-6",
    "swe-1-6-fast",
    "swe-1-6-slow",
    // GLM family — all variants
    "glm-5-2-max",
    "glm-5-2-1m",
    "glm-5-2-max-1m",
    "glm-5-2-none",
    "glm-5-2-none-1m",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    // Other potentially free models
    "gemini-3.0-flash",
    "gemini-3-5-flash-minimal",
    "gemini-3-5-flash-low",
    "gemini-3-7-flash-minimal",
    "gemini-3-7-flash-low",
    "inkling-none",
    "inkling-low",
  ];

  console.log(`\n=== Slow Model Probe (${models.length} models, 3s delay) ===\n`);

  const working = [];
  const blocked = [];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    process.stdout.write(`  [${i + 1}/${models.length}] ${model.padEnd(35)} ... `);
    const r = await testModel(model);
    if (r.ok) {
      console.log(`OK "${r.content}"`);
      working.push(model);
    } else {
      console.log(`FAIL (${r.reason})`);
      blocked.push({ model, reason: r.reason });
    }
    if (i < models.length - 1) await sleep(3000);
  }

  console.log(`\n=== Results ===\n`);
  console.log(`  Working: ${working.length}/${models.length}`);
  if (working.length > 0) {
    console.log(`\n  Working models:`);
    for (const m of working) console.log(`    ✓ ${m}`);
  }
  console.log(`\n  Blocked: ${blocked.length}/${models.length}`);
  if (blocked.length > 0) {
    const byReason = {};
    for (const b of blocked) { byReason[b.reason] = (byReason[b.reason] ?? 0) + 1; }
    for (const [reason, count] of Object.entries(byReason)) {
      console.log(`    ${reason}: ${count}`);
    }
  }
  console.log("");
}

main().catch(console.error);
