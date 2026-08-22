/**
 * One-command setup for grokbot-BYOK v2. Fully non-interactive.
 *
 *   npm run setup
 *
 * Does everything:
 *   1. Checks prerequisites (Node version, node_modules).
 *   2. Copies config.example.json → config.json if not present.
 *   3. Copies .env.example → .env if not present.
 *   4. Writes API keys (from CLI flags or env vars) into .env.
 *   5. Builds the shim + scripts.
 *   6. Starts three detached background daemons with PID files + logs:
 *        a. Shim            (dist/shim.js)
 *        b. Host watcher    (dist/scripts/watch-host.js)
 *        c. Health watchdog (dist/scripts/health-check.js --watch --deploy)
 *   7. Runs a smoke test and prints status.
 *
 * Re-running `npm run setup` is safe: it stops existing daemons (via PID
 * files) before starting new ones, so it acts as a restart command too.
 *
 * API keys can be provided via CLI flags or env vars:
 *   npm run setup -- --opencode-key sk-xxx --openrouter-key sk-or-xxx
 *   OPENCODE_API_KEY=sk-xxx OPENROUTER_API_KEY=sk-or-xxx npm run setup
 *
 * Flags:
 *   --opencode-key=KEY     Set OPENCODE_API_KEY in .env
 *   --kilo-key=KEY         Set KILO_API_KEY in .env
 *   --openrouter-key=KEY   Set OPENROUTER_API_KEY in .env
 *   --local-key=KEY        Set LOCAL_API_KEY in .env
 *   --no-build             Skip the build step (use existing dist/).
 *   --no-watch             Don't start the host watcher daemon.
 *   --no-health            Don't start the health watchdog daemon.
 *   --no-patch             Don't patch Cursor's host-main.cjs.
 *   --quiet                Suppress provider table and detailed output.
 *   --stop                 Stop all daemons and exit.
 *   --status               Print daemon status and exit.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PID_FILES, LOG_FILES, DAEMON_STATUS_LIST, findAlivePid, resolveSandHostDir,
  stopAllDaemons, startDaemon, portIsListening, sleep,
} from "../src/utils/daemon.js";

// ─── Paths ────────────────────────────────────────────────────────────────

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(distDir, "..");
const configDir = path.join(projectRoot, "config");

// ─── Load .env into process.env ───────────────────────────────────────────
// The config file uses ${VAR} interpolation, and patch-host needs
// SAND_HOST_DIR. Load .env early so these are available.
(function sourceEnvFile() {
  const envFile = path.join(projectRoot, ".env");
  if (!existsSync(envFile)) return;
  const text = readFileSync(envFile, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
})();

// ─── Provider definitions ─────────────────────────────────────────────────

interface ProviderInfo {
  name: string;
  envVar: string;
  cliFlag: string;
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
    cliFlag: "--opencode-key",
    required: true,
    keyless: false,
    url: "https://opencode.ai",
    models: "ox-alpha-free, qwen3.8-max (vision)",
    description: "Primary provider. Frontier reasoning model, free tier.",
  },
  {
    name: "kilo",
    envVar: "KILO_API_KEY",
    cliFlag: "--kilo-key",
    required: false,
    keyless: true,
    url: "https://kilo.ai",
    models: "stealth/ox-alpha",
    description: "Keyless anonymous access (200 req/hr/IP). Set key for higher limits.",
  },
  {
    name: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    cliFlag: "--openrouter-key",
    required: false,
    keyless: false,
    url: "https://openrouter.ai/keys",
    models: "stealth/ox-alpha",
    description: "OpenRouter gateway. Get a key at openrouter.ai/keys.",
  },
  {
    name: "opencode-zen",
    envVar: "OPENCODE_API_KEY",
    cliFlag: "--opencode-key",
    required: false,
    keyless: false,
    url: "https://opencode.ai",
    models: "x-preview-f-free",
    description: "Secondary OpenCode endpoint. Shares the same key as opencode-go.",
  },
  {
    name: "local",
    envVar: "LOCAL_API_KEY",
    cliFlag: "--local-key",
    required: false,
    keyless: false,
    url: "127.0.0.1:3003 (WindsurfAPI)",
    models: "glm-5.2, glm-5.1, swe-1-7, swe-1-7-medium",
    description: "Local WindsurfAPI backend. Auto-started if found in ../WindsurfAPI.",
  },
];

// ─── Output helpers ───────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

let quiet = false;

function info(msg: string): void {
  if (quiet) return;
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

// ─── Arg parsing ──────────────────────────────────────────────────────────

interface SetupArgs {
  noBuild: boolean;
  noWatch: boolean;
  noHealth: boolean;
  noPatch: boolean;
  quiet: boolean;
  stop: boolean;
  status: boolean;
  keys: Record<string, string>; // envVar -> key value
}

function parseArgs(argv: string[]): SetupArgs {
  const keys: Record<string, string> = {};
  for (const p of PROVIDERS) {
    const flagEq = `${p.cliFlag}=`;
    for (const arg of argv) {
      if (arg.startsWith(flagEq)) {
        keys[p.envVar] = arg.slice(flagEq.length);
      } else if (arg === p.cliFlag) {
        const idx = argv.indexOf(arg);
        if (idx + 1 < argv.length && !argv[idx + 1].startsWith("--")) {
          keys[p.envVar] = argv[idx + 1];
        }
      }
    }
  }
  return {
    noBuild: argv.includes("--no-build"),
    noWatch: argv.includes("--no-watch"),
    noHealth: argv.includes("--no-health"),
    noPatch: argv.includes("--no-patch"),
    quiet: argv.includes("--quiet"),
    stop: argv.includes("--stop"),
    status: argv.includes("--status"),
    keys,
  };
}

// ─── .env management ──────────────────────────────────────────────────────

/** Set or update an env var in the .env file. Preserves comments and other lines. */
function setEnvVar(envPath: string, varName: string, value: string): void {
  let content = "";
  if (existsSync(envPath)) content = readFileSync(envPath, "utf8");
  const re = new RegExp(`^#?\\s*${varName}=.*$`, "m");
  const newLine = `${varName}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, newLine);
  } else {
    content = content.trimEnd() + "\n" + newLine + "\n";
  }
  writeFileSync(envPath, content, "utf8");
}

/** Read a var from .env. Returns undefined if not set or is a placeholder. */
function readEnvVar(envPath: string, varName: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, "utf8");
  const re = new RegExp(`^${varName}=(.+)$`, "m");
  const match = content.match(re);
  const val = match?.[1]?.trim();
  if (!val || val.includes("your-") || val.includes("-here")) return undefined;
  return val;
}

/** Write CLI/env-provided keys into .env. Returns unique env var names written. */
function writeKeysToEnv(envPath: string, cliKeys: Record<string, string>): Set<string> {
  const written = new Set<string>();
  const seen = new Set<string>();
  for (const p of PROVIDERS) {
    if (seen.has(p.envVar)) continue;
    seen.add(p.envVar);
    const cliVal = cliKeys[p.envVar];
    const envVal = process.env[p.envVar];
    const existingVal = readEnvVar(envPath, p.envVar);
    const value = cliVal ?? (envVal && !envVal.includes("your-") && !envVal.includes("-here") ? envVal : undefined);
    if (value) {
      if (value !== existingVal) {
        setEnvVar(envPath, p.envVar, value);
        ok(`Set ${p.envVar} in .env (from ${cliVal ? "CLI flag" : "env var"})`);
      } else {
        info(`${p.envVar} already set in .env`);
      }
      written.add(p.envVar);
    }
  }
  return written;
}

/** Check which required keys are missing. */
function getMissingRequiredKeys(envPath: string): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const p of PROVIDERS) {
    if (seen.has(p.envVar)) continue;
    seen.add(p.envVar);
    if (p.keyless || !p.required) continue;
    if (!readEnvVar(envPath, p.envVar)) missing.push(p.envVar);
  }
  return missing;
}

// ─── Provider table (suppressed by --quiet) ───────────────────────────────

function printProviderTable(): void {
  console.log();
  console.log(`${BOLD}Providers:${RESET}`);
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
  console.log(`${BOLD}Where to get keys:${RESET}`);
  console.log(`  OpenCode:    https://opencode.ai         (one key for go + zen)`);
  console.log(`  Kilo:        https://kilo.ai             (optional — keyless works without a key)`);
  console.log(`  OpenRouter:  https://openrouter.ai/keys`);
  console.log();
  console.log(`${BOLD}How to provide keys (non-interactive):${RESET}`);
  console.log(`  ${CYAN}npm run setup -- --opencode-key sk-xxx --openrouter-key sk-or-xxx${RESET}`);
  console.log(`  ${CYAN}OPENCODE_API_KEY=sk-xxx npm run setup${RESET}`);
  console.log(`  Or edit ${CYAN}.env${RESET} manually and run ${CYAN}npm run setup${RESET}`);
  console.log();
  console.log(`${BOLD}Failover order:${RESET} opencode-go → kilo → openrouter → opencode-zen → local`);
  console.log(`${DIM}Providers with missing API keys are automatically skipped (except keyless ones).${RESET}`);
  console.log();
}

// ─── Config loader ────────────────────────────────────────────────────────

function loadConfigSafe(): { port: number; host: string; hostConfig?: { sandHostDir?: string } } | null {
  try {
    const configPath = path.join(configDir, "config.json");
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    return { port: cfg.port ?? 8788, host: cfg.host ?? "127.0.0.1", hostConfig: cfg.hostConfig };
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  quiet = args.quiet;

  // ── --status ──
  if (args.status) {
    if (!quiet) {
      console.log();
      console.log(`${BOLD}grokbot-BYOK v2 — daemon status${RESET}`);
      console.log();
    }
    let allRunning = true;
    for (const d of DAEMON_STATUS_LIST) {
      const alivePid = findAlivePid(d.pidFiles);
      const running = alivePid !== undefined;
      if (!running) allRunning = false;
      if (quiet) {
        console.log(`${d.name}: ${running ? "running" : "stopped"}`);
      } else {
        const status = running ? `${GREEN}running${RESET} (pid ${alivePid})` : `${DIM}stopped${RESET}`;
        console.log(`  ${d.name.padEnd(18)} ${status}  ${DIM}log: ${d.logFile}${RESET}`);
      }
    }
    const config = loadConfigSafe();
    if (config) {
      const up = await portIsListening(config.host || "127.0.0.1", config.port);
      if (!up) allRunning = false;
      if (quiet) {
        console.log(`Port ${config.port}: ${up ? "listening" : "not listening"}`);
      } else {
        const portLabel = `Port ${config.port}`.padEnd(18);
        console.log(`  ${portLabel} ${up ? `${GREEN}listening${RESET}` : `${DIM}not listening${RESET}`}`);
      }
    }
    if (!quiet) console.log();
    process.exit(allRunning ? 0 : 1);
  }

  // ── --stop ──
  if (args.stop) {
    if (!quiet) console.log();
    info("Stopping all daemons...");
    await stopAllDaemons();
    ok("All daemons stopped");
    process.exit(0);
  }

  if (!quiet) {
    console.log();
    console.log(`${BOLD}grokbot-BYOK v2 — Setup${RESET}`);
    console.log();
  }

  // ── Step 1: Prerequisites ──
  info("Step 1/7: Checking prerequisites...");
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  if (major < 18) { err(`Node 18+ required, found ${nodeVersion}`); process.exit(1); }
  ok(`Node ${nodeVersion}`);

  if (!existsSync(path.join(projectRoot, "node_modules"))) {
    info("Installing dependencies (npm install)...");
    try { execSync("npm install", { stdio: quiet ? "pipe" : "inherit", cwd: projectRoot }); }
    catch { err("npm install failed"); process.exit(1); }
  }
  ok("Dependencies installed");

  // ── Step 2: Config file ──
  info("Step 2/7: Checking config file...");
  const configExample = path.join(configDir, "config.example.json");
  const configJson = path.join(configDir, "config.json");
  if (!existsSync(configJson)) {
    if (existsSync(configExample)) { copyFileSync(configExample, configJson); ok("Created config/config.json from example"); }
    else { err("config/config.example.json not found"); process.exit(1); }
  } else { ok("config/config.json exists"); }

  // ── Step 3: .env file ──
  info("Step 3/7: Checking .env file...");
  const envExample = path.join(projectRoot, ".env.example");
  const envFile = path.join(projectRoot, ".env");
  if (!existsSync(envFile)) {
    if (existsSync(envExample)) { copyFileSync(envExample, envFile); ok("Created .env from .env.example"); }
    else { warn(".env.example not found, creating empty .env"); writeFileSync(envFile, "", "utf8"); }
  } else { ok(".env exists"); }

  // ── Step 4: Write keys + print provider info ──
  info("Step 4/7: Configuring API keys...");
  const writtenKeys = writeKeysToEnv(envFile, args.keys);
  if (writtenKeys.size > 0) ok(`Wrote ${writtenKeys.size} key(s) to .env: ${[...writtenKeys].join(", ")}`);

  if (!quiet) printProviderTable();

  const missing = getMissingRequiredKeys(envFile);
  if (missing.length > 0) {
    warn(`Missing required API keys: ${missing.join(", ")}`);
    const flags = missing.map((v) => {
      const p = PROVIDERS.find((pp) => pp.envVar === v);
      return p ? `${p.cliFlag} <key>` : `${v}=<key>`;
    });
    warn(`  npm run setup -- ${flags.join(" ")}`);
    warn(`  ${missing.map((v) => `${v}=<key>`).join(" ")} npm run setup`);
    err("Cannot start without required API keys.");
    process.exit(1);
  }
  ok("All required API keys are set");

  // ── Step 5: Build ──
  if (args.noBuild) {
    info("Step 5/7: Build (skipped via --no-build)");
  } else {
    info("Step 5/7: Building shim + scripts...");
    try { execSync("npm run build:all", { stdio: quiet ? "pipe" : "inherit", cwd: projectRoot }); }
    catch { err("Build failed"); process.exit(1); }
    ok("Build complete");
  }

  if (!existsSync(path.join(distDir, "shim.js"))) {
    err("dist/shim.js not found — build may have failed. Run: npm run build:all");
    process.exit(1);
  }

  // ── Step 6: Stop existing daemons ──
  info("Step 6/7: Stopping existing daemons (if any)...");
  await stopAllDaemons();
  await sleep(500);

  // ── Step 7: Start daemons ──
  info("Step 7/7: Starting daemons...");

  // 7a: Shim (use start-shim.js which handles WindsurfAPI auto-start + seeding)
  const startShimPath = path.join(distDir, "scripts", "start-shim.js");
  const shimPath = path.join(distDir, "shim.js");
  const shimEntry = existsSync(startShimPath) ? startShimPath : shimPath;
  // Don't pre-write the PID file — the shim writes its own PID on startup.
  // Using startDaemon would write start-shim.js's PID, which shim.js would
  // then see as "already running" and refuse to start.
  try { unlinkSync(PID_FILES.shim); } catch { /* not present */ }
  try { unlinkSync(PID_FILES.shimPort); } catch { /* not present */ }
  const shimPid = startDaemon("Shim", "node", [shimEntry], "", LOG_FILES.shim, projectRoot);
  if (shimPid) ok(`Shim: starting (pid ${shimPid})`);

  // Wait for shim to listen.
  const config = loadConfigSafe();
  const shimPort = config?.port ?? 8788;
  const shimHost = config?.host ?? "127.0.0.1";
  let listening = false;
  for (let i = 0; i < 15; i++) {
    if (await portIsListening(shimHost, shimPort)) { listening = true; break; }
    await sleep(1000);
  }
  if (listening) ok(`Shim listening on ${shimHost}:${shimPort}`);
  else { err(`Shim did not start listening on ${shimHost}:${shimPort} within 15s`); warn(`Check log: ${LOG_FILES.shim}`); }

  // 7b: Patch Cursor's host to route through the shim
  if (args.noPatch) {
    info("Host patch: skipped (--no-patch)");
  } else {
    const sandHostDir = resolveSandHostDir(config);
    const hostMain = path.join(sandHostDir, "host-main.cjs");
    if (existsSync(hostMain)) {
      const patchScript = path.join(distDir, "scripts", "patch-host.js");
      if (existsSync(patchScript)) {
        info("Patching Cursor host to route through shim...");
        try {
          execSync(`node ${JSON.stringify(patchScript)}`, { stdio: quiet ? "pipe" : "inherit", cwd: projectRoot });
          ok("Host patched — Cursor inference now routes through the shim");
        } catch {
          warn("Host patch failed — shim is running but Cursor is not hooked in.");
          warn("Run manually: node dist/scripts/patch-host.js");
        }
      } else { warn("Host patch: dist/scripts/patch-host.js not found"); }
    } else {
      info(`Host patch: host-main.cjs not found at ${hostMain}, skipping`);
      if (!quiet) info(`${DIM}Cursor may not be installed. Re-run setup after Cursor is installed.${RESET}`);
    }
  }

  // 7c: Host watcher (only if host-main.cjs exists)
  if (args.noWatch) {
    info("Host watcher: skipped (--no-watch)");
  } else {
    const sandHostDir = resolveSandHostDir(config);
    const hostMain = path.join(sandHostDir, "host-main.cjs");
    if (existsSync(hostMain)) {
      const watchScript = path.join(distDir, "scripts", "watch-host.js");
      if (existsSync(watchScript)) {
        const pid = startDaemon("Host watcher", "node", [watchScript], PID_FILES.watch, LOG_FILES.watch, projectRoot);
        if (pid) ok(`Host watcher: started (pid ${pid})`);
      } else { warn("Host watcher: dist/scripts/watch-host.js not found"); }
    } else {
      info(`Host watcher: host-main.cjs not found at ${hostMain}, skipping`);
      if (!quiet) info(`${DIM}Re-run setup after Cursor is installed to enable auto re-patching.${RESET}`);
    }
  }

  // 7d: Health watchdog
  if (args.noHealth) {
    info("Health watchdog: skipped (--no-health)");
  } else {
    const healthScript = path.join(distDir, "scripts", "health-check.js");
    if (existsSync(healthScript)) {
      const pid = startDaemon("Health watchdog", "node", [healthScript, "--watch", "--deploy"], PID_FILES.health, LOG_FILES.health, projectRoot);
      if (pid) ok(`Health watchdog: started (pid ${pid})`);
    } else { warn("Health watchdog: dist/scripts/health-check.js not found"); }
  }

  // ── Summary ──
  if (quiet) {
    console.log(`shim: ${listening ? "running" : "failed"}`);
    const watchRunning = findAlivePid([PID_FILES.watch]) !== undefined;
    const healthRunning = findAlivePid([PID_FILES.health]) !== undefined;
    console.log(`host_watcher: ${watchRunning ? "running" : "stopped"}`);
    console.log(`health_watchdog: ${healthRunning ? "running" : "stopped"}`);
  } else {
    console.log();
    console.log(`${BOLD}Setup complete${RESET}`);
    console.log();
    console.log(`  Shim:             ${listening ? GREEN + "running" + RESET : RED + "not listening" + RESET} (${shimHost}:${shimPort})`);
    const watchRunning = findAlivePid([PID_FILES.watch]) !== undefined;
    const healthRunning = findAlivePid([PID_FILES.health]) !== undefined;
    console.log(`  Host watcher:     ${watchRunning ? GREEN + "running" + RESET : DIM + "stopped" + RESET}`);
    console.log(`  Health watchdog:  ${healthRunning ? GREEN + "running" + RESET : DIM + "stopped" + RESET}`);
    console.log();
    console.log(`  Logs: ${DIM}${LOG_FILES.shim}${RESET}`);
    console.log(`        ${DIM}${LOG_FILES.watch}${RESET}`);
    console.log(`        ${DIM}${LOG_FILES.health}${RESET}`);
    console.log();
    console.log(`  ${CYAN}npm run setup -- --status${RESET}  check status`);
    console.log(`  ${CYAN}npm run setup -- --stop${RESET}     stop all`);
    console.log(`  ${CYAN}npm run setup${RESET}               restart`);
    console.log();
  }

  process.exit(listening ? 0 : 1);
}

main().catch((e) => {
  err(`Unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
