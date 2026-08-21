/**
 * Health check / watchdog (replaces health-check.sh).
 *
 * Reads the shim's structured JSON log, counts response and error lines within
 * a rolling window, computes an error rate, and reports OK / WARN / CRITICAL.
 *
 * Modes:
 *   one-shot (default)   Check once and exit.
 *   --watch              Continuous checks at a fixed interval.
 *   --deploy             On CRITICAL, automatically run the deploy script.
 *
 * Env vars:
 *   SHIM_LOG         Path to the shim log file (default: /tmp/inference-shim.log)
 *   HEALTH_WINDOW    Rolling window in seconds (default: 300)
 *   HEALTH_THRESHOLD Error-rate percentage that triggers CRITICAL (default: 50)
 *   SHIM_PORT        Port to TCP-probe (default: from config)
 */
import { readFileSync, existsSync } from "node:fs";
import * as net from "node:net";
import { execSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";

const log = createLogger();

/** Parsed JSON log record shape (subset). */
interface LogRecord {
  ts?: string;
  level?: string;
  msg?: string;
}

type Status = "OK" | "WARN" | "CRITICAL";

function parseArgs(argv: string[]): { watch: boolean; deploy: boolean } {
  return {
    watch: argv.includes("--watch"),
    deploy: argv.includes("--deploy"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TCP-probe host:port. Resolves true on connect. */
function portIsListening(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const cleanup = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => cleanup(true));
    sock.once("timeout", () => cleanup(false));
    sock.once("error", () => cleanup(false));
  });
}

/** Parse a log timestamp (ISO) into epoch ms; returns NaN if unparseable. */
function parseTs(ts: string | undefined): number {
  if (!ts) return NaN;
  const ms = Date.parse(ts);
  return ms;
}

/**
 * Read the log file and tally response/error counts within `windowSec`.
 * Returns null if the file is missing or empty.
 */
function tallyLog(
  logFile: string,
  windowSec: number,
  now = Date.now(),
): { responses: number; errors: number; total: number } | null {
  if (!existsSync(logFile)) return null;
  let raw: string;
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    return null;
  }
  const cutoff = now - windowSec * 1000;
  let responses = 0;
  let errors = 0;
  let total = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: LogRecord;
    try {
      rec = JSON.parse(trimmed) as LogRecord;
    } catch {
      continue;
    }
    const ts = parseTs(rec.ts);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    total++;
    const msg = rec.msg ?? "";
    if (msg.includes("connected") || msg.includes("HTTP")) {
      responses++;
    }
    if (rec.level === "error" || msg.includes("HTTP 4") || msg.includes("HTTP 5")) {
      errors++;
    }
  }
  return { responses, errors, total };
}

/** Compute the status from the tally. */
function computeStatus(
  tally: { responses: number; errors: number; total: number } | null,
  portUp: boolean,
  thresholdPct: number,
): Status {
  if (!portUp) return "CRITICAL";
  if (!tally || tally.responses === 0) {
    // No traffic yet — treat as OK (shim is up, just idle).
    return "OK";
  }
  const errorRate = (tally.errors / tally.responses) * 100;
  if (errorRate >= thresholdPct) return "CRITICAL";
  if (errorRate >= thresholdPct / 2) return "WARN";
  return "OK";
}

async function checkOnce(
  logFile: string,
  windowSec: number,
  thresholdPct: number,
  host: string,
  port: number,
): Promise<Status> {
  const portUp = await portIsListening(host, port);
  const tally = tallyLog(logFile, windowSec);
  const status = computeStatus(tally, portUp, thresholdPct);
  log.info("health-check", {
    status,
    portUp,
    responses: tally?.responses ?? 0,
    errors: tally?.errors ?? 0,
    total: tally?.total ?? 0,
    windowSec,
    thresholdPct,
  });
  return status;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const logFile = process.env.SHIM_LOG ?? "/tmp/inference-shim.log";
  const windowSec = parseInt(process.env.HEALTH_WINDOW ?? "300", 10);
  const thresholdPct = parseInt(process.env.HEALTH_THRESHOLD ?? "50", 10);
  const port = parseInt(process.env.SHIM_PORT ?? String(config.port), 10);
  const host = config.host || "127.0.0.1";

  const runOnce = async (): Promise<Status> => checkOnce(logFile, windowSec, thresholdPct, host, port);

  if (!args.watch) {
    const status = await runOnce();
    if (status === "CRITICAL") {
      if (args.deploy) {
        log.warn("health-check: CRITICAL — auto-running deploy");
        try {
          execSync("node dist/scripts/deploy.js", { stdio: "inherit" });
        } catch (err) {
          log.error("health-check: auto-deploy failed", { error: err instanceof Error ? err.message : String(err) });
          process.exit(1);
        }
      }
      process.exit(1);
    }
    process.exit(0);
  }

  // --watch: loop forever at 60s intervals.
  log.info("health-check: watch mode started", { intervalSec: 60 });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await runOnce();
    if (status === "CRITICAL" && args.deploy) {
      log.warn("health-check: CRITICAL — auto-running deploy");
      try {
        execSync("node dist/scripts/deploy.js", { stdio: "inherit" });
      } catch (err) {
        log.error("health-check: auto-deploy failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    await sleep(60_000);
  }
}

main().catch((err) => {
  log.error("health-check: unhandled error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
