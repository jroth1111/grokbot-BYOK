/**
 * Operational launcher for the inference shim.
 *
 * Handles:
 *   1. WindsurfAPI auto-start — when the local provider points at
 *      `127.0.0.1:3003` and WindsurfAPI isn't already listening, start it
 *      from `WINDSURFAPI_DIR` (default: `../WindsurfAPI` relative to the
 *      project root).
 *   2. Exec the built shim (`dist/shim.js`).
 *
 * Credentials and `.env` loading are handled by the shim itself (src/config.ts),
 * so this launcher is only needed for WindsurfAPI auto-start. You can run
 * `node dist/shim.js` directly if WindsurfAPI is already running (or not needed).
 *
 * The shim itself handles PID-file locking and stale-instance killing.
 *
 * Env vars:
 *   WINDSURFAPI_DIR  Path to the WindsurfAPI project (default: ../WindsurfAPI)
 */
import { existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { sourceEnvFile, readDevinSessionToken } from "../src/utils/env.js";

const log = {
  info: (msg: string) => console.log(`[start-shim] ${msg}`),
  warn: (msg: string) => console.warn(`[start-shim] WARN: ${msg}`),
  error: (msg: string) => console.error(`[start-shim] ERROR: ${msg}`),
};

/** Resolve the project root from this script's location (dist/scripts/). */
function projectRoot(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..", "..");
}

/** TCP-connect to host:port; resolve true on success. */
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

/**
 * Auto-start WindsurfAPI when the local provider points at 127.0.0.1:3003
 * and nothing is listening there yet.
 */
async function autoStartWindsurfAPI(): Promise<void> {
  const windsurfDir = process.env.WINDSURFAPI_DIR ?? path.join(projectRoot(), "..", "WindsurfAPI");
  const localPort = 3003;
  const localHost = "127.0.0.1";

  // Check if something is already listening on 3003.
  if (await portIsListening(localHost, localPort)) {
    log.info(`WindsurfAPI already listening on ${localHost}:${localPort}`);
    return;
  }

  // Check if the WindsurfAPI directory exists.
  const entryFile = path.join(windsurfDir, "src", "index.js");
  if (!existsSync(entryFile)) {
    log.info(`WindsurfAPI not found at ${windsurfDir}, skipping auto-start`);
    return;
  }

  log.info(`starting WindsurfAPI from ${windsurfDir}...`);
  const logFile = path.join(windsurfDir, "windsurfapi.log");
  const outFd = openSync(logFile, "a");
  const errFd = openSync(logFile, "a");
  const child = spawn("node", [entryFile], {
    stdio: ["ignore", outFd, errFd],
    detached: true,
    cwd: windsurfDir,
    env: process.env,
  });
  child.unref();

  // Wait up to 15s for it to start listening.
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await portIsListening(localHost, localPort)) {
      log.info(`WindsurfAPI started (pid ${child.pid}), listening on ${localHost}:${localPort}`);
      return;
    }
  }
  log.warn(`WindsurfAPI did not start listening within 15s — check ${logFile}`);
}

/**
 * POST an account to WindsurfAPI's /auth/login and configure model access.
 * WindsurfAPI stores accounts and dashboard settings in-memory (data/accounts.json
 * gets wiped on unclean shutdown), so we seed both on every startup.
 *
 * The Devin CLI session token is read from ~/.local/share/devin/credentials.toml
 * (refreshed by the CLI periodically) rather than a static .env copy, so we
 * always have a valid token. An explicit WINDSURF_API_KEY in .env overrides the
 * credentials file for users who want to pin a specific key.
 */
async function seedWindsurfAccount(): Promise<void> {
  // WINDSURF_API_KEY in .env takes precedence; otherwise read from
  // credentials.toml (WINDSURF_CREDENTIALS_PATH can override the default path).
  const windsurfKey =
    process.env.WINDSURF_API_KEY ??
    readDevinSessionToken(process.env.WINDSURF_CREDENTIALS_PATH);
  const localKey = process.env.LOCAL_API_KEY;
  const dashboardPassword = process.env.WINDSURF_DASHBOARD_PASSWORD ?? process.env.DASHBOARD_PASSWORD ?? "test";
  const host = "127.0.0.1";
  const port = 3003;

  if (!windsurfKey) {
    log.warn(
      "No WindsurfAPI account token found — set WINDSURF_API_KEY in .env or " +
      "ensure ~/.local/share/devin/credentials.toml exists (windsurf_api_key field)",
    );
    return;
  }

  // 1. Add the account via /auth/login (token method triggers tier probe).
  await new Promise<void>((resolve) => {
    const body = JSON.stringify({
      token: windsurfKey,
      label: "grokbot-byok",
    });
    const req = http.request(
      {
        hostname: host,
        port,
        path: "/auth/login",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${localKey}`,
          "x-dashboard-password": dashboardPassword,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const d = JSON.parse(raw);
            if (d.success || d.account) {
              log.info(`WindsurfAPI account seeded (id=${d.account?.id ?? "?"}, status=${d.account?.status ?? "?"})`);
            } else if (d.error?.message?.includes("already")) {
              log.info(`WindsurfAPI account already present`);
            } else {
              log.warn(`WindsurfAPI account seed response: ${raw.slice(0, 200)}`);
            }
          } catch {
            log.warn(`WindsurfAPI account seed: non-JSON response (${res.statusCode})`);
          }
          resolve();
        });
      },
    );
    req.on("error", (err) => {
      log.warn(`WindsurfAPI account seed failed: ${err.message}`);
      resolve();
    });
    req.setTimeout(15000, () => {
      req.destroy();
      log.warn("WindsurfAPI account seed timed out");
      resolve();
    });
    req.write(body);
    req.end();
  });

  // 2. Set model-access to "all" so the dashboard allowlist doesn't block
  //    the free models. The shim's config already restricts which models
  //    are offered; the WindsurfAPI dashboard allowlist is redundant and
  //    gets wiped on restart.
  await new Promise<void>((resolve) => {
    const body = JSON.stringify({ mode: "all" });
    const req = http.request(
      {
        hostname: host,
        port,
        path: "/dashboard/api/model-access",
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${localKey}`,
          "x-dashboard-password": dashboardPassword,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          log.info("WindsurfAPI model-access set to 'all'");
          resolve();
        });
      },
    );
    req.on("error", () => resolve());
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

/**
 * Check WindsurfAPI account-pool health via GET /auth/status.
 * Returns the parsed status object, or undefined if the server is unreachable.
 */
async function checkWindsurfHealth(): Promise<{ active: number; total: number } | undefined> {
  const localKey = process.env.LOCAL_API_KEY;
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 3003,
        path: "/auth/status",
        method: "GET",
        headers: { Authorization: `Bearer ${localKey}` },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(data);
            resolve({ active: d.active ?? 0, total: d.total ?? 0 });
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on("error", () => resolve(undefined));
    req.setTimeout(5000, () => { req.destroy(); resolve(undefined); });
    req.end();
  });
}

/**
 * Start a background health-check loop that re-seeds the WindsurfAPI account
 * pool if it drops to zero active accounts (e.g. after a WindsurfAPI restart
 * or crash). Runs every 30s. Returns the interval handle so the caller can
 * clear it on shutdown.
 */
function startHealthCheckLoop(): NodeJS.Timeout {
  const HEALTH_CHECK_INTERVAL_MS = 30_000;
  let reseedInProgress = false;

  return setInterval(async () => {
    const health = await checkWindsurfHealth();
    if (!health) {
      // WindsurfAPI is down — autoStartWindsurfAPI won't fire here, but the
      // next startup will re-start it. Just log.
      log.warn("WindsurfAPI health check: server unreachable");
      return;
    }
    if (health.active === 0 && !reseedInProgress) {
      log.warn(`WindsurfAPI health check: 0 active accounts (total=${health.total}), re-seeding...`);
      reseedInProgress = true;
      try {
        await seedWindsurfAccount();
      } finally {
        reseedInProgress = false;
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

async function main(): Promise<void> {
  // Load .env before anything else — we need WINDSURF_API_KEY and
  // DROUGHT_RESTRICT_PREMIUM for WindsurfAPI, and they live in .env.
  sourceEnvFile();

  // Auto-start WindsurfAPI if the local backend is configured.
  await autoStartWindsurfAPI();

  // Seed the WindsurfAPI account pool from our .env. This runs whether we
  // just started WindsurfAPI or it was already running — accounts are
  // in-memory and get wiped on restart, so we always re-seed.
  if (await portIsListening("127.0.0.1", 3003)) {
    await seedWindsurfAccount();
  }

  // Start background health check: re-seeds the account pool if WindsurfAPI
  // restarts independently and loses its in-memory accounts.
  const healthHandle = startHealthCheckLoop();

  // Exec the built shim. The shim handles its own PID locking and
  // stale-instance killing, so we just spawn it and exit.
  // Credentials and .env loading are handled by the shim itself (src/config.ts).
  const shimPath = path.join(projectRoot(), "dist", "shim.js");
  if (!existsSync(shimPath)) {
    log.error(`shim not built: ${shimPath} — run 'npm run build' first`);
    process.exit(1);
  }

  log.info(`launching shim: ${shimPath}`);
  const shim = spawn("node", [shimPath], {
    stdio: "inherit",
    env: process.env,
  });

  // Forward signals so Ctrl+C kills the shim, not just this wrapper.
  // Also clear the background intervals on shutdown.
  const shutdown = (): void => {
    clearInterval(healthHandle);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { shutdown(); shim.kill(sig); });
  }
  shim.on("exit", (code) => { shutdown(); process.exit(code ?? 0); });
}

main().catch((err) => {
  log.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
