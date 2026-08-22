/**
 * One-command setup for grokbot-BYOK v2.
 *
 *   npm run setup
 *
 * Does everything:
 *   1. Checks prerequisites (Node version, node_modules).
 *   2. Copies config.example.json → config.json if not present.
 *   3. Copies .env.example → .env if not present.
 *   4. Prints a provider table and guides the user on where to put API keys.
 *   5. Builds the shim + scripts.
 *   6. Starts three detached background daemons with PID files + logs:
 *        a. Shim            (dist/shim.js)
 *        b. Host watcher    (dist/scripts/watch-host.js)
 *        c. Health watchdog (dist/scripts/health-check.js --watch --deploy)
 *   7. Runs a smoke test (health-check one-shot).
 *   8. Prints status summary.
 *
 * Re-running `npm run setup` is safe: it stops existing daemons (via PID
 * files) before starting new ones, so it acts as a restart command too.
 *
 * Flags:
 *   --no-build    Skip the build step (use existing dist/).
 *   --no-watch    Don't start the host watcher daemon.
 *   --no-health   Don't start the health watchdog daemon.
 *   --stop        Stop all daemons and exit (no build, no start).
 *   --status      Print daemon status and exit.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, mkdirSync, openSync } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ─── Paths ────────────────────────────────────────────────────────────────

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(distDir, "..");
const configDir = path.join(projectRoot, "config");

const PID_DIR = "/tmp";
const LOG_DIR = "/tmp";

const PIDS = {
  shim: path.join(PID_DIR, "inference-shim.pid"),
  shimPort: path.join(PID_DIR, "inference-shim-8788.pid"),
  watch: path.join(PID_DIR, "grokbot-watch-host.pid"),
  health: path.join(PID_DIR, "grokbot-health-check.pid"),
};

const LOGS = {
  shim: path.join(LOG_DIR, "inference-shim.log"),
  watch: path.join(LOG_DIR, "grokbot-watch-host.log"),
  health: path.join(LOG_DIR, "grokbot-health-check.log"),
};

// ─── Utilities ────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function info(msg: string): void {
  console.log(`${CYAN}[setup]${RESET} ${msg}`);
}
function ok(msg: string): void {
  console.log(`${GREEN}[setup]${RESET} ${msg}`);
}
function warn(msg: string): void {
  console.log(`${YELLOW}[setup] WARN${RESET} ${msg}`);
}
function err(msg: string): void {
  console.error(`${RED}[setup] ERROR${RESET} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portIsListening(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const cleanup = (v: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => cleanup(true));
    sock.once("timeout", () => cleanup(false));
    sock.once("error", () => cleanup(false));
  });
}

function readPid(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killPid(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* dead */ }
}

function stopDaemon(name: string, ...pidFiles: string[]): void {
  // Try each PID file; stop the first live process found.
  let stopped = false;
  for (const pidFile of pidFiles) {
    const pid = readPid(pidFile);
    if (pid === undefined) continue;
    if (!isProcessAlive(pid)) {
      try { unlinkSync(pidFile); } catch { /* ignore */ }
      continue;
    }
    info(`${name}: stopping pid ${pid}`);
    killPid(pid);
    // Wait up to 3s for graceful exit.
    for (let i = 0; i < 30; i++) {
      if (!isProcessAlive(pid)) break;
      try { process.kill(pid, 0); } catch { break; }
    }
    // SIGKILL if still alive.
    try { process.kill(pid, "SIGKILL"); } catch { /* dead */ }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    ok(`${name}: stopped`);
    stopped = true;
  }
  if (!stopped) {
    info(`${name}: no running process found`);
  }
}

function startDaemon(name: string, cmd: string, args: string[], pidFile: string, logFile: string): number | undefined {
  const outFd = openSync(logFile, "a");
  const errFd = openSync(logFile, "a");
  const child = spawn(cmd, args, {
    stdio: ["ignore", outFd, errFd],
    detached: true,
    cwd: projectRoot,
    env: process.env,
  });
  child.unref();
  if (child.pid) {
    writeFileSync(pidFile, String(child.pid));
    ok(`${name}: started (pid ${child.pid}, log ${logFile})`);
    return child.pid;
  }
  err(`${name}: failed to start`);
  return undefined;
}

// ─── Provider table ───────────────────────────────────────────────────────

interface ProviderInfo {
  name: string;
  envVar: string;
  required: boolean;
  keyless: boolean;
  url: string;
  models: string;
  description: string;
}

const PROVIDERS: ProviderInfo[] = [
  {
    name: "opencode-go",
    envVar: "OPENCODE_API_KEY",
    required: true,
    keyless: false,
    url: "https://opencode.ai",
    models: "ox-alpha-free, qwen3.8-max (vision)",
    description: "Primary provider. Frontier reasoning model, free tier.",
  },
  {
    name: "kilo",
    envVar: "KILO_API_KEY",
    required: false,
    keyless: true,
    url: "https://kilo.ai",
    models: "stealth/ox-alpha",
    description: "Keyless anonymous access (200 req/hr/IP). Set key for higher limits.",
  },
  {
    name: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    required: false,
    keyless: false,
    url: "https://openrouter.ai/keys",
    models: "stealth/ox-alpha",
    description: "OpenRouter gateway. Get a key at openrouter.ai/keys.",
  },
  {
    name: "opencode-zen",
    envVar: "OPENCODE_API_KEY",
    required: false,
    keyless: false,
    url: "https://opencode.ai",
    models: "x-preview-f-free",
    description: "Secondary OpenCode endpoint. Shares the same key as opencode-go.",
  },
  {
    name: "local",
    envVar: "LOCAL_API_KEY",
    required: false,
    keyless: false,
    url: "127.0.0.1:3003 (WindsurfAPI)",
    models: "glm-5.2, glm-5.1, swe-1-7, swe-1-7-medium",
    description: "Local WindsurfAPI backend. Auto-started if found in ../WindsurfAPI.",
  },
];

function printProviderTable(): void {
  console.log();
  console.log(`${BOLD}┌──────────────────┬──────────────────────┬──────────┬─────────────────────────────────────────────────────┐${RESET}`);
  console.log(`${BOLD}│ Provider         │ Env Var              │ Required │ Description                                         │${RESET}`);
  console.log(`${BOLD}├──────────────────┼──────────────────────┼──────────┼─────────────────────────────────────────────────────┤${RESET}`);
  for (const p of PROVIDERS) {
    const name = p.name.padEnd(16);
    const env = p.envVar.padEnd(20);
    const req = (p.keyless ? "keyless" : p.required ? "yes" : "optional").padEnd(8);
    const desc = (p.description.slice(0, 51)).padEnd(51);
    console.log(`${BOLD}│${RESET} ${name} ${BOLD}│${RESET} ${env} ${BOLD}│${RESET} ${req} ${BOLD}│${RESET} ${desc} ${BOLD}│${RESET}`);
  }
  console.log(`${BOLD}└──────────────────┴──────────────────────┴──────────┴─────────────────────────────────────────────────────┘${RESET}`);
  console.log();
  console.log(`${BOLD}Where to put API keys:${RESET}`);
  console.log(`  Edit ${CYAN}.env${RESET} in the project root. Example values are in ${CYAN}.env.example${RESET}.`);
  console.log();
  console.log(`${BOLD}Provider details:${RESET}`);
  for (const p of PROVIDERS) {
    console.log();
    console.log(`  ${BOLD}${p.name}${RESET} (${p.url})`);
    console.log(`    Env var:   ${CYAN}${p.envVar}${RESET}`);
    console.log(`    Required:  ${p.keyless ? "no (keyless — works without a key)" : p.required ? "yes" : "no"}`);
    console.log(`    Models:    ${p.models}`);
    console.log(`    ${p.description}`);
  }
  console.log();
  console.log(`${BOLD}Failover order:${RESET} opencode-go → kilo → openrouter → opencode-zen → local`);
  console.log(`${DIM}Providers with missing API keys are automatically skipped (except keyless ones).${RESET}`);
  console.log();
}

// ─── Env file helpers ─────────────────────────────────────────────────────

/** Check which API keys are set in .env and report missing ones. */
function checkEnvKeys(): void {
  const envPath = path.join(projectRoot, ".env");
  if (!existsSync(envPath)) {
    warn(".env not found — copy .env.example and add your API keys");
    return;
  }
  const envContent = readFileSync(envPath, "utf8");
  const missing: string[] = [];
  for (const p of PROVIDERS) {
    if (p.keyless) continue;
    // Look for ENV_VAR=value where value is not empty and not a placeholder.
    const re = new RegExp(`^${p.envVar}=(.+)$`, "m");
    const match = envContent.match(re);
    const val = match?.[1]?.trim();
    if (!val || val.includes("your-") || val.includes("-here")) {
      if (p.required) missing.push(`${p.envVar} (${p.name})`);
    }
  }
  if (missing.length > 0) {
    warn(`Missing required API keys in .env:`);
    for (const m of missing) warn(`  ${m}`);
    console.log();
    warn(`Edit .env now, then re-run: npm run setup`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { noBuild: boolean; noWatch: boolean; noHealth: boolean; stop: boolean; status: boolean } {
  return {
    noBuild: argv.includes("--no-build"),
    noWatch: argv.includes("--no-watch"),
    noHealth: argv.includes("--no-health"),
    stop: argv.includes("--stop"),
    status: argv.includes("--status"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ── --status: print daemon status and exit ──
  if (args.status) {
    console.log();
    console.log(`${BOLD}grokbot-BYOK v2 — daemon status${RESET}`);
    console.log();
    const daemons: Array<{ name: string; pidFiles: string[]; logFile: string }> = [
      { name: "Shim", pidFiles: [PIDS.shim, PIDS.shimPort], logFile: LOGS.shim },
      { name: "Host watcher", pidFiles: [PIDS.watch], logFile: LOGS.watch },
      { name: "Health watchdog", pidFiles: [PIDS.health], logFile: LOGS.health },
    ];
    for (const d of daemons) {
      let alivePid: number | undefined;
      for (const pf of d.pidFiles) {
        const pid = readPid(pf);
        if (pid !== undefined && isProcessAlive(pid)) { alivePid = pid; break; }
      }
      const status = alivePid !== undefined ? `${GREEN}running${RESET} (pid ${alivePid})` : `${DIM}stopped${RESET}`;
      console.log(`  ${d.name.padEnd(18)} ${status}  ${DIM}log: ${d.logFile}${RESET}`);
    }
    // Also check if the shim port is listening.
    const config = loadConfigSafe();
    if (config) {
      const up = await portIsListening(config.host || "127.0.0.1", config.port);
      const portLabel = `Port ${config.port}`.padEnd(18);
      console.log(`  ${portLabel} ${up ? `${GREEN}listening${RESET}` : `${DIM}not listening${RESET}`}`);
    }
    console.log();
    process.exit(0);
  }

  // ── --stop: stop all daemons and exit ──
  if (args.stop) {
    console.log();
    info("Stopping all daemons...");
    stopDaemon("Shim", PIDS.shim, PIDS.shimPort);
    stopDaemon("Host watcher", PIDS.watch);
    stopDaemon("Health watchdog", PIDS.health);
    ok("All daemons stopped");
    process.exit(0);
  }

  console.log();
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║         grokbot-BYOK v2 — Setup                              ║${RESET}`);
  console.log(`${BOLD}║         Cursor sand-host BYOK inference adapter              ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();

  // ── Step 1: Check prerequisites ──
  info("Step 1/7: Checking prerequisites...");

  // Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  if (major < 18) {
    err(`Node 18+ required, found ${nodeVersion}`);
    process.exit(1);
  }
  ok(`Node ${nodeVersion}`);

  // node_modules
  if (!existsSync(path.join(projectRoot, "node_modules"))) {
    info("Installing dependencies (npm install)...");
    try {
      execSync("npm install", { stdio: "inherit", cwd: projectRoot });
    } catch {
      err("npm install failed");
      process.exit(1);
    }
  }
  ok("Dependencies installed");

  // ── Step 2: Config file ──
  info("Step 2/7: Checking config file...");
  const configExample = path.join(configDir, "config.example.json");
  const configJson = path.join(configDir, "config.json");
  if (!existsSync(configJson)) {
    if (existsSync(configExample)) {
      copyFileSync(configExample, configJson);
      ok(`Created config/config.json from example`);
    } else {
      err("config/config.example.json not found");
      process.exit(1);
    }
  } else {
    ok("config/config.json exists");
  }

  // ── Step 3: .env file ──
  info("Step 3/7: Checking .env file...");
  const envExample = path.join(projectRoot, ".env.example");
  const envFile = path.join(projectRoot, ".env");
  if (!existsSync(envFile)) {
    if (existsSync(envExample)) {
      copyFileSync(envExample, envFile);
      ok(`Created .env from .env.example`);
    } else {
      warn(".env.example not found, creating empty .env");
      writeFileSync(envFile, "", "utf8");
    }
  } else {
    ok(".env exists");
  }

  // ── Step 4: Print provider info ──
  info("Step 4/7: Provider configuration");
  printProviderTable();
  checkEnvKeys();

  // ── Step 5: Build ──
  if (args.noBuild) {
    info("Step 5/7: Build (skipped via --no-build)");
  } else {
    info("Step 5/7: Building shim + scripts...");
    try {
      execSync("npm run build:all", { stdio: "inherit", cwd: projectRoot });
    } catch {
      err("Build failed");
      process.exit(1);
    }
    ok("Build complete");
  }

  // Verify dist exists.
  if (!existsSync(path.join(distDir, "shim.js"))) {
    err("dist/shim.js not found — build may have failed. Run: npm run build:all");
    process.exit(1);
  }

  // ── Step 6: Stop existing daemons ──
  info("Step 6/7: Stopping existing daemons (if any)...");
  stopDaemon("Shim", PIDS.shim, PIDS.shimPort);
  stopDaemon("Host watcher", PIDS.watch);
  stopDaemon("Health watchdog", PIDS.health);
  await sleep(500); // let OS release sockets

  // ── Step 7: Start daemons ──
  info("Step 7/7: Starting daemons...");

  // 7a: Shim (use start-shim.js which handles WindsurfAPI auto-start + seeding)
  const startShimPath = path.join(distDir, "scripts", "start-shim.js");
  const shimPath = path.join(distDir, "shim.js");
  const shimEntry = existsSync(startShimPath) ? startShimPath : shimPath;
  // Don't pre-write the PID file — the shim writes its own PID on startup.
  // Just clean up any stale file and start the process.
  try { unlinkSync(PIDS.shim); } catch { /* not present */ }
  const shimOutFd = openSync(LOGS.shim, "a");
  const shimErrFd = openSync(LOGS.shim, "a");
  const shimChild = spawn("node", [shimEntry], {
    stdio: ["ignore", shimOutFd, shimErrFd],
    detached: true,
    cwd: projectRoot,
    env: process.env,
  });
  shimChild.unref();
  if (shimChild.pid) {
    ok(`Shim: starting (pid ${shimChild.pid}, log ${LOGS.shim})`);
  }

  // Wait for shim to start listening.
  const config = loadConfigSafe();
  const shimPort = config?.port ?? 8788;
  const shimHost = config?.host ?? "127.0.0.1";
  let listening = false;
  for (let i = 0; i < 15; i++) {
    if (await portIsListening(shimHost, shimPort)) { listening = true; break; }
    await sleep(1000);
  }
  if (listening) {
    ok(`Shim listening on ${shimHost}:${shimPort}`);
  } else {
    err(`Shim did not start listening on ${shimHost}:${shimPort} within 15s`);
    warn(`Check log: ${LOGS.shim}`);
  }

  // 7b: Host watcher (only if host-main.cjs exists)
  if (args.noWatch) {
    info("Host watcher: skipped (--no-watch)");
  } else {
    const sandHostDir = process.env.SAND_HOST_DIR || config?.hostConfig?.sandHostDir || path.join(process.env.HOME ?? "/root", "sand-host");
    const hostMain = path.join(sandHostDir, "host-main.cjs");
    if (existsSync(hostMain)) {
      const watchScript = path.join(distDir, "scripts", "watch-host.js");
      if (existsSync(watchScript)) {
        startDaemon("Host watcher", "node", [watchScript], PIDS.watch, LOGS.watch);
      } else {
        warn("Host watcher: dist/scripts/watch-host.js not found (build may be incomplete)");
      }
    } else {
      info(`Host watcher: host-main.cjs not found at ${hostMain}, skipping`);
      info(`${DIM}The watcher re-patches Cursor's host bundle when it updates.${RESET}`);
      info(`${DIM}It will be needed after Cursor is installed. Re-run setup then.${RESET}`);
    }
  }

  // 7c: Health watchdog
  if (args.noHealth) {
    info("Health watchdog: skipped (--no-health)");
  } else {
    const healthScript = path.join(distDir, "scripts", "health-check.js");
    if (existsSync(healthScript)) {
      startDaemon("Health watchdog", "node", [healthScript, "--watch", "--deploy"], PIDS.health, LOGS.health);
    } else {
      warn("Health watchdog: dist/scripts/health-check.js not found (build may be incomplete)");
    }
  }

  // ── Smoke test ──
  console.log();
  info("Running smoke test...");
  if (listening) {
    ok(`Shim is up on ${shimHost}:${shimPort}`);
  } else {
    warn("Shim is not listening — check the log file");
  }

  // ── Summary ──
  console.log();
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Setup complete                                             ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  Shim:            ${listening ? GREEN + "running" + RESET : RED + "not listening" + RESET}                         ${BOLD}║${RESET}`);
  const watchRunning = readPid(PIDS.watch) !== undefined && isProcessAlive(readPid(PIDS.watch)!);
  const healthRunning = readPid(PIDS.health) !== undefined && isProcessAlive(readPid(PIDS.health)!);
  console.log(`${BOLD}║${RESET}  Host watcher:    ${watchRunning ? GREEN + "running" + RESET : DIM + "stopped" + RESET}                         ${BOLD}║${RESET}`);
  console.log(`${BOLD}║${RESET}  Health watchdog: ${healthRunning ? GREEN + "running" + RESET : DIM + "stopped" + RESET}                         ${BOLD}║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  Logs:  ${DIM}/tmp/inference-shim.log${RESET}                              ${BOLD}║${RESET}`);
  console.log(`${BOLD}║${RESET}         ${DIM}/tmp/grokbot-watch-host.log${RESET}                          ${BOLD}║${RESET}`);
  console.log(`${BOLD}║${RESET}         ${DIM}/tmp/grokbot-health-check.log${RESET}                        ${BOLD}║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  ${CYAN}npm run setup -- --status${RESET}   check daemon status          ${BOLD}║${RESET}`);
  console.log(`${BOLD}║${RESET}  ${CYAN}npm run setup -- --stop${RESET}      stop all daemons             ${BOLD}║${RESET}`);
  console.log(`${BOLD}║${RESET}  ${CYAN}npm run setup${RESET}               restart everything            ${BOLD}║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();
}

/** Load config safely (may fail if config.json is invalid). */
function loadConfigSafe(): { port: number; host: string; hostConfig?: { sandHostDir?: string } } | null {
  try {
    // Use dynamic import to avoid hard dependency at build time.
    const configPath = path.join(configDir, "config.json");
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    return {
      port: cfg.port ?? 8788,
      host: cfg.host ?? "127.0.0.1",
      hostConfig: cfg.hostConfig,
    };
  } catch {
    return null;
  }
}

main().catch((e) => {
  err(`Unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
