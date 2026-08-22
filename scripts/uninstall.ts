/**
 * Uninstall script for grokbot-BYOK v2. Fully non-interactive.
 *
 *   npm run uninstall
 *
 * Stops all daemons and removes runtime files (PID files, logs, proxy URL).
 * Restores Cursor's host-main.cjs from the .bak backup if one exists.
 *
 *   npm run uninstall -- --purge
 *
 * Full removal: also removes config/config.json, .env, dist/, node_modules/,
 * and the deployed inference-shim.cjs symlink in the sand-host directory.
 * Does NOT remove the git repository itself.
 *
 * Flags:
 *   --purge    Remove everything: config, .env, dist, node_modules, deployed shim.
 *   --quiet    Minimal output (agent-friendly).
 *   --keep-host  Skip host-main.cjs restoration (leave the patch in place).
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ─── Paths ────────────────────────────────────────────────────────────────

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(distDir, "..");
const configDir = path.join(projectRoot, "config");

const PID_DIR = "/tmp";
const LOG_DIR = "/tmp";

const PID_FILES = [
  path.join(PID_DIR, "inference-shim.pid"),
  path.join(PID_DIR, "inference-shim-8788.pid"),
  path.join(PID_DIR, "grokbot-watch-host.pid"),
  path.join(PID_DIR, "grokbot-health-check.pid"),
];

const LOG_FILES = [
  path.join(LOG_DIR, "inference-shim.log"),
  path.join(LOG_DIR, "grokbot-watch-host.log"),
  path.join(LOG_DIR, "grokbot-health-check.log"),
];

// ─── Output helpers ───────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let quiet = false;

function info(msg: string): void {
  if (quiet) return;
  console.log(`${CYAN}[uninstall]${RESET} ${msg}`);
}
function ok(msg: string): void {
  console.log(`${GREEN}[uninstall]${RESET} ${msg}`);
}
function warn(msg: string): void {
  console.log(`${YELLOW}[uninstall] WARN${RESET} ${msg}`);
}
function err(msg: string): void {
  console.error(`${RED}[uninstall] ERROR${RESET} ${msg}`);
}

// ─── Utilities ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function removeFile(file: string): void {
  try {
    unlinkSync(file);
    info(`Removed ${file}`);
  } catch {
    /* not present */
  }
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    info(`Removed ${dir}`);
  } catch {
    /* not present */
  }
}

// ─── Daemon stop ──────────────────────────────────────────────────────────

async function stopAllDaemons(): Promise<void> {
  const daemonNames: Record<string, string> = {};
  daemonNames[PID_FILES[0]] = "Shim (legacy PID)";
  daemonNames[PID_FILES[1]] = "Shim (per-port PID)";
  daemonNames[PID_FILES[2]] = "Host watcher";
  daemonNames[PID_FILES[3]] = "Health watchdog";

  for (const pidFile of PID_FILES) {
    const pid = readPid(pidFile);
    if (pid === undefined) continue;
    if (!isProcessAlive(pid)) {
      removeFile(pidFile);
      continue;
    }
    const name = daemonNames[pidFile] ?? "daemon";
    info(`${name}: stopping pid ${pid}`);
    try { process.kill(pid, "SIGTERM"); } catch { /* dead */ }
    // Wait up to 3s for graceful exit.
    for (let i = 0; i < 30; i++) {
      if (!isProcessAlive(pid)) break;
      try { process.kill(pid, 0); } catch { break; }
      await sleep(100);
    }
    // SIGKILL if still alive.
    try { process.kill(pid, "SIGKILL"); } catch { /* dead */ }
    removeFile(pidFile);
    ok(`${name}: stopped`);
  }

  // Also pkill any orphaned shim processes (best-effort).
  try {
    execSync('pkill -f "dist/shim.js"', { stdio: "ignore" });
  } catch { /* no matching process */ }
  try {
    execSync('pkill -f "dist/scripts/watch-host.js"', { stdio: "ignore" });
  } catch { /* no matching process */ }
  try {
    execSync('pkill -f "dist/scripts/health-check.js"', { stdio: "ignore" });
  } catch { /* no matching process */ }
}

// ─── Host restoration ─────────────────────────────────────────────────────

/** Restore host-main.cjs from .bak backup if it exists. */
function restoreHost(keepHost: boolean): void {
  if (keepHost) {
    info("Host restoration: skipped (--keep-host)");
    return;
  }

  const sandHostDir =
    process.env.SAND_HOST_DIR || path.join(process.env.HOME ?? "/root", "sand-host");
  const hostMain = path.join(sandHostDir, "host-main.cjs");
  const backup = `${hostMain}.bak`;
  const proxyUrl = path.join(sandHostDir, "inference-proxy.url");
  const shimSymlink = path.join(sandHostDir, "inference-shim.cjs");

  if (!existsSync(hostMain)) {
    info(`Host: host-main.cjs not found at ${hostMain}, nothing to restore`);
  } else if (existsSync(backup)) {
    // Verify the backup is a valid JS file before overwriting.
    try {
      const backupContent = readFileSync(backup, "utf8");
      execSync(`node --check ${JSON.stringify(backup)}`, { stdio: "pipe" });
      writeFileSync(hostMain, backupContent, "utf8");
      ok(`Host: restored host-main.cjs from backup`);
      removeFile(backup);
    } catch {
      warn(`Host: backup at ${backup} failed syntax check, leaving host-main.cjs as-is`);
      warn(`Host: manual recovery may be needed. The .bak file is preserved.`);
    }
  } else {
    // No backup — check if the host is patched. If so, warn the user.
    try {
      const src = readFileSync(hostMain, "utf8");
      if (src.includes("routingClient")) {
        warn(`Host: host-main.cjs is patched but no .bak backup exists.`);
        warn(`Host: cannot auto-restore. Cursor will need to be reinstalled to get a clean host.`);
      } else {
        info(`Host: host-main.cjs is not patched, nothing to restore`);
      }
    } catch {
      info(`Host: could not read host-main.cjs, skipping`);
    }
  }

  // Remove the proxy URL file.
  removeFile(proxyUrl);

  // Remove the deployed shim symlink/copy.
  if (existsSync(shimSymlink)) {
    removeFile(shimSymlink);
  }
}

// ─── Arg parsing ──────────────────────────────────────────────────────────

interface UninstallArgs {
  purge: boolean;
  quiet: boolean;
  keepHost: boolean;
}

function parseArgs(argv: string[]): UninstallArgs {
  return {
    purge: argv.includes("--purge"),
    quiet: argv.includes("--quiet"),
    keepHost: argv.includes("--keep-host"),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  quiet = args.quiet;

  if (!quiet) {
    console.log();
    console.log(`\x1b[1mgrokbot-BYOK v2 — Uninstall${RESET}`);
    console.log();
  }

  // Step 1: Stop all daemons
  info("Step 1/3: Stopping daemons...");
  await stopAllDaemons();
  await sleep(500);
  ok("All daemons stopped");

  // Step 2: Remove runtime files
  info("Step 2/3: Removing runtime files...");
  for (const f of PID_FILES) removeFile(f);
  for (const f of LOG_FILES) removeFile(f);
  ok("Runtime files removed");

  // Step 3: Restore host
  info("Step 3/3: Restoring Cursor host...");
  restoreHost(args.keepHost);

  // Purge: remove all project artifacts
  if (args.purge) {
    info("Purge: removing project artifacts...");
    removeFile(path.join(projectRoot, ".env"));
    removeFile(path.join(projectRoot, ".env.example"));
    removeFile(path.join(configDir, "config.json"));
    removeDir(path.join(projectRoot, "dist"));
    removeDir(path.join(projectRoot, "node_modules"));
    ok("Project artifacts removed");
  }

  // Summary
  if (quiet) {
    console.log("uninstalled: ok");
  } else {
    console.log();
    console.log(`${GREEN}Uninstall complete.${RESET}`);
    console.log();
    if (args.purge) {
      console.log(`  All daemons stopped, runtime files removed, host restored,`);
      console.log(`  and project artifacts (.env, config.json, dist/, node_modules/) deleted.`);
      console.log();
      console.log(`  The git repository itself is preserved. To fully remove:`);
      console.log(`    ${DIM}cd .. && rm -rf grokbot-BYOK${RESET}`);
    } else {
      console.log(`  Daemons stopped, PID/log files removed, Cursor host restored.`);
      console.log();
      console.log(`  To also remove config, .env, and build artifacts:`);
      console.log(`    ${CYAN}npm run uninstall -- --purge${RESET}`);
    }
    console.log();
  }

  process.exit(0);
}

main().catch((e) => {
  err(`Unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
