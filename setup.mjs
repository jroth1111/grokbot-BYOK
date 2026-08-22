#!/usr/bin/env node
/**
 * Bootstrap entry point for grokbot-BYOK setup.
 *
 * This file lives at the project root (not in dist/) so it works even after
 * `npm run uninstall -- --purge` removes dist/ and node_modules/.
 *
 * It ensures node_modules and dist/ exist (for setup), then delegates to
 * the real setup script in dist/scripts/setup.js. For --stop and --status,
 * it handles them inline if dist/ is not available.
 *
 * Usage:
 *   node setup.mjs             # same as `npm run setup`
 *   node setup.mjs -- --quiet  # pass flags through
 *   node setup.mjs -- --stop
 *   node setup.mjs -- --status
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const PID_FILES = [
  "/tmp/inference-shim.pid",
  "/tmp/inference-shim-8788.pid",
  "/tmp/grokbot-watch-host.pid",
  "/tmp/grokbot-health-check.pid",
];

function readPid(file) {
  if (!existsSync(file)) return undefined;
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch { return undefined; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portIsListening(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const cleanup = (v) => { sock.removeAllListeners(); sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => cleanup(true));
    sock.once("timeout", () => cleanup(false));
    sock.once("error", () => cleanup(false));
  });
}

// ── --stop: stop all daemons inline (no dist needed) ──
if (args.includes("--stop")) {
  console.log("[setup] Stopping all daemons...");
  let stopped = false;
  for (const pf of PID_FILES) {
    const pid = readPid(pf);
    if (pid === undefined) continue;
    if (!isAlive(pid)) { try { unlinkSync(pf); } catch {} continue; }
    console.log(`[setup] stopping pid ${pid} (${pf})`);
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 30; i++) {
      if (!isAlive(pid)) break;
      try { process.kill(pid, 0); } catch { break; }
    }
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { unlinkSync(pf); } catch {}
    stopped = true;
  }
  try { execSync('pkill -f "dist/shim.js"', { stdio: "ignore" }); } catch {}
  try { execSync('pkill -f "dist/scripts"', { stdio: "ignore" }); } catch {}
  console.log(stopped ? "[setup] All daemons stopped" : "[setup] No running daemons found");
  process.exit(0);
}

// ── --status: check daemon status inline (no dist needed) ──
if (args.includes("--status")) {
  const names = ["Shim", "Host watcher", "Health watchdog"];
  const quiet = args.includes("--quiet");
  let allRunning = true;
  // Shim checks both PID files.
  const shimPid = readPid(PID_FILES[0]) ?? readPid(PID_FILES[1]);
  const watchPid = readPid(PID_FILES[2]);
  const healthPid = readPid(PID_FILES[3]);
  const daemons = [
    { name: "Shim", pid: shimPid, pids: [PID_FILES[0], PID_FILES[1]] },
    { name: "Host watcher", pid: watchPid, pids: [PID_FILES[2]] },
    { name: "Health watchdog", pid: healthPid, pids: [PID_FILES[3]] },
  ];
  if (!quiet) { console.log(); console.log("grokbot-BYOK v2 — daemon status"); console.log(); }
  for (const d of daemons) {
    const alive = d.pid !== undefined && isAlive(d.pid);
    if (!alive) allRunning = false;
    if (quiet) {
      console.log(`${d.name}: ${alive ? "running" : "stopped"}`);
    } else {
      console.log(`  ${d.name.padEnd(18)} ${alive ? "running" : "stopped"}`);
    }
  }
  // Port check (best-effort, may fail if config is gone).
  try {
    const configPath = path.join(root, "config", "config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      const port = cfg.port ?? 8788;
      const host = cfg.host ?? "127.0.0.1";
      const up = await portIsListening(host, port);
      if (!up) allRunning = false;
      if (quiet) console.log(`Port ${port}: ${up ? "listening" : "not listening"}`);
      else console.log(`  ${("Port " + port).padEnd(18)} ${up ? "listening" : "not listening"}`);
    }
  } catch { /* config gone — skip port check */ }
  if (!quiet) console.log();
  process.exit(allRunning ? 0 : 1);
}

// ── Normal setup: ensure prerequisites, then delegate to dist/scripts/setup.js ──
if (!existsSync(path.join(root, "node_modules"))) {
  console.log("[bootstrap] Installing dependencies...");
  try { execSync("npm install", { stdio: "inherit", cwd: root }); }
  catch { console.error("[bootstrap] npm install failed"); process.exit(1); }
}

const setupJs = path.join(root, "dist", "scripts", "setup.js");
if (!existsSync(setupJs)) {
  console.log("[bootstrap] Building...");
  try { execSync("npm run build:all", { stdio: "inherit", cwd: root }); }
  catch { console.error("[bootstrap] build failed"); process.exit(1); }
}

if (!existsSync(setupJs)) {
  console.error("[bootstrap] dist/scripts/setup.js not found after build. Run: npm run build:all");
  process.exit(1);
}

// Delegate to the real setup script, passing all args through.
execSync(`node ${JSON.stringify(setupJs)} ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
  stdio: "inherit",
  cwd: root,
});
