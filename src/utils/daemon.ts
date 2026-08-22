/**
 * Shared daemon management utilities used by setup.ts and uninstall.ts.
 *
 * Extracted to avoid duplicating PID-file reading, process killing, and
 * port-probing logic across scripts.
 */
import { existsSync, readFileSync, unlinkSync, openSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { spawn } from "node:child_process";

// ─── Paths ────────────────────────────────────────────────────────────────

export const PID_DIR = "/tmp";
export const LOG_DIR = "/tmp";

export const PID_FILES = {
  shim: `${PID_DIR}/inference-shim.pid`,
  shimPort: `${PID_DIR}/inference-shim-8788.pid`,
  watch: `${PID_DIR}/grokbot-watch-host.pid`,
  health: `${PID_DIR}/grokbot-health-check.pid`,
};

export const LOG_FILES = {
  shim: `${LOG_DIR}/inference-shim.log`,
  watch: `${LOG_DIR}/grokbot-watch-host.log`,
  health: `${LOG_DIR}/grokbot-health-check.log`,
};

/** All PID files that should be cleaned up on stop/uninstall. */
export const ALL_PID_FILES = [PID_FILES.shim, PID_FILES.shimPort, PID_FILES.watch, PID_FILES.health];

/** All log files that should be removed on uninstall. */
export const ALL_LOG_FILES = [LOG_FILES.shim, LOG_FILES.watch, LOG_FILES.health];

// ─── Process helpers ──────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readPid(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function killPid(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* dead */ }
}

/**
 * Stop a daemon by its PID file(s). Tries SIGTERM, waits up to 3s,
 * then SIGKILL. Removes the PID file afterward.
 */
export async function stopDaemon(name: string, ...pidFiles: string[]): Promise<boolean> {
  let stopped = false;
  for (const pidFile of pidFiles) {
    const pid = readPid(pidFile);
    if (pid === undefined) continue;
    if (!isProcessAlive(pid)) {
      try { unlinkSync(pidFile); } catch { /* ignore */ }
      continue;
    }
    killPid(pid);
    for (let i = 0; i < 30; i++) {
      if (!isProcessAlive(pid)) break;
      try { process.kill(pid, 0); } catch { break; }
      await sleep(100);
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* dead */ }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    stopped = true;
  }
  return stopped;
}

/**
 * Stop all grokbot-BYOK daemons. Also pkill orphans as a fallback.
 */
export async function stopAllDaemons(): Promise<void> {
  await stopDaemon("Shim", PID_FILES.shim, PID_FILES.shimPort);
  await stopDaemon("Host watcher", PID_FILES.watch);
  await stopDaemon("Health watchdog", PID_FILES.health);
  // Best-effort pkill for orphaned processes without PID files.
  try { spawn("pkill", ["-f", "dist/shim.js"]).unref(); } catch { /* ignore */ }
  try { spawn("pkill", ["-f", "dist/scripts/watch-host.js"]).unref(); } catch { /* ignore */ }
  try { spawn("pkill", ["-f", "dist/scripts/health-check.js"]).unref(); } catch { /* ignore */ }
}

/**
 * Start a detached background daemon with a PID file and log file.
 * Returns the PID, or undefined on failure.
 */
export function startDaemon(
  name: string,
  cmd: string,
  args: string[],
  pidFile: string,
  logFile: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const outFd = openSync(logFile, "a");
  const errFd = openSync(logFile, "a");
  const child = spawn(cmd, args, {
    stdio: ["ignore", outFd, errFd],
    detached: true,
    cwd,
    env,
  });
  child.unref();
  if (child.pid) {
    // Only write PID file if a path was provided (the shim writes its own).
    if (pidFile) writeFileSync(pidFile, String(child.pid));
    return child.pid;
  }
  return undefined;
}

// ─── Network helpers ──────────────────────────────────────────────────────

export function portIsListening(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const cleanup = (v: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => cleanup(true));
    sock.once("timeout", () => cleanup(false));
    sock.once("error", () => cleanup(false));
  });
}

// ─── File helpers ─────────────────────────────────────────────────────────

export function removeFile(file: string): boolean {
  try { unlinkSync(file); return true; } catch { return false; }
}

export function removeDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────

export interface DaemonStatus {
  name: string;
  pidFiles: string[];
  logFile: string;
}

export const DAEMON_STATUS_LIST: DaemonStatus[] = [
  { name: "Shim", pidFiles: [PID_FILES.shim, PID_FILES.shimPort], logFile: LOG_FILES.shim },
  { name: "Host watcher", pidFiles: [PID_FILES.watch], logFile: LOG_FILES.watch },
  { name: "Health watchdog", pidFiles: [PID_FILES.health], logFile: LOG_FILES.health },
];

/** Find the live PID for a daemon by checking its PID file(s). */
export function findAlivePid(pidFiles: string[]): number | undefined {
  for (const pf of pidFiles) {
    const pid = readPid(pf);
    if (pid !== undefined && isProcessAlive(pid)) return pid;
  }
  return undefined;
}

/**
 * Resolve the sand-host directory. Precedence:
 *   1. SAND_HOST_DIR env var
 *   2. config hostConfig.sandHostDir — with ${VAR} patterns resolved.
 *      A literal "${SAND_HOST_DIR}" with no env var set is skipped.
 *   3. $HOME/sand-host fallback
 */
export function resolveSandHostDir(config?: { hostConfig?: { sandHostDir?: string } } | null): string {
  if (process.env.SAND_HOST_DIR) return process.env.SAND_HOST_DIR;
  const raw = config?.hostConfig?.sandHostDir;
  if (raw) {
    const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
    if (resolved && !resolved.includes("${")) return resolved;
  }
  return path.join(process.env.HOME ?? "/root", "sand-host");
}
