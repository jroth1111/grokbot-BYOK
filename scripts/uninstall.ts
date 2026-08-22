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
 * Does NOT remove the git repository itself or tracked files like .env.example.
 *
 * Flags:
 *   --purge      Remove everything: config, .env, dist, node_modules, deployed shim.
 *   --quiet      Minimal output (agent-friendly).
 *   --keep-host  Skip host-main.cjs restoration (leave the patch in place).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ALL_PID_FILES, ALL_LOG_FILES,
  stopAllDaemons, removeFile, removeDir, sleep,
} from "../src/utils/daemon.js";

// ─── Paths ────────────────────────────────────────────────────────────────

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(distDir, "..");
const configDir = path.join(projectRoot, "config");

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
    try {
      const backupContent = readFileSync(backup, "utf8");
      execSync(`node --check ${JSON.stringify(backup)}`, { stdio: "pipe" });
      writeFileSync(hostMain, backupContent, "utf8");
      ok("Host: restored host-main.cjs from backup");
      removeFile(backup);
    } catch {
      warn(`Host: backup at ${backup} failed syntax check, leaving host-main.cjs as-is`);
      warn("Host: manual recovery may be needed. The .bak file is preserved.");
    }
  } else {
    try {
      const src = readFileSync(hostMain, "utf8");
      if (src.includes("routingClient")) {
        warn("Host: host-main.cjs is patched but no .bak backup exists.");
        warn("Host: cannot auto-restore. Cursor will need to be reinstalled to get a clean host.");
      } else {
        info("Host: host-main.cjs is not patched, nothing to restore");
      }
    } catch {
      info("Host: could not read host-main.cjs, skipping");
    }
  }

  removeFile(proxyUrl);
  if (existsSync(shimSymlink)) removeFile(shimSymlink);
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
  for (const f of ALL_PID_FILES) removeFile(f);
  for (const f of ALL_LOG_FILES) removeFile(f);
  ok("Runtime files removed");

  // Step 3: Restore host
  info("Step 3/3: Restoring Cursor host...");
  restoreHost(args.keepHost);

  // Purge: remove all user-generated project artifacts
  if (args.purge) {
    info("Purge: removing project artifacts...");
    removeFile(path.join(projectRoot, ".env"));
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
      console.log("  All daemons stopped, runtime files removed, host restored,");
      console.log("  and project artifacts (.env, config.json, dist/, node_modules/) deleted.");
      console.log();
      console.log("  The git repository itself is preserved. To fully remove:");
      console.log(`    ${DIM}cd .. && rm -rf grokbot-BYOK${RESET}`);
    } else {
      console.log("  Daemons stopped, PID/log files removed, Cursor host restored.");
      console.log();
      console.log("  To also remove config, .env, and build artifacts:");
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
