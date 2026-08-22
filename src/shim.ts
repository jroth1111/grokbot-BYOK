/**
 * Entry point for the Connect-RPC to OpenAI translation shim.
 *
 * Loads configuration, creates a structured logger, emits startup diagnostics,
 * and starts the HTTP server returned by {@link createServer}. Process-level
 * error handlers ensure no error goes unlogged; graceful shutdown on SIGTERM /
 * SIGINT is handled inside {@link createServer} (which owns the HTTP server and
 * its session-affinity cleanup interval), so this module intentionally does
 * not register duplicate signal handlers.
 *
 * A PID-file lock ensures only one shim instance runs per port. On startup,
 * any existing shim on the same port is killed (SIGTERM → SIGKILL) before the
 * new instance binds. The lock is released on normal exit, signal, and
 * uncaught errors.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createServer } from "./server.js";
import type { ShimConfig } from "./types.js";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { sleep } from "./providers/retry.js";
import { installProcessSafetyNet } from "./observability/process-safety-net.js";
import { installLogRedaction } from "./observability/log-redaction.js";

// Console-level credential redaction must be installed before anything else
// logs — provider keys reach stdout through undici error stacks, debug lines,
// and URL logging. This wraps console.log/info/warn/error/debug/trace so no
// credential (sk-*, gsk_*, AIza*, Bearer tokens, JWTs, etc.) ever reaches
// stdout, even from code that hasn't been written yet.
installLogRedaction();

// The logger is created before config loading so that a config error can be
// emitted as a structured log line rather than crashing with a raw stack
// trace (and so the error handlers below always have a logger to use).
const logger = createLogger();

let config: ShimConfig;
try {
  config = loadConfig();
} catch (err) {
  logger.error("failed to load config", { error: err });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PID-file lock: ensure only one shim runs per port.
// ---------------------------------------------------------------------------

/** PID file path for this port. Per-port so different configs coexist. */
const pidFile = `/tmp/inference-shim-${config.port}.pid`;

/** Legacy fixed-path PID file used by the deploy script. */
const legacyPidFile = "/tmp/inference-shim.pid";

/** Check whether a process with the given PID is still alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false; // ESRCH (no such process) or EPERM (different user)
  }
}

/** Kill a process: SIGTERM, wait up to 5s, then SIGKILL if still alive. */
async function killProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already dead
  }
  for (let i = 0; i < 50; i++) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

/** Read a PID from a file, or undefined if the file is missing/unreadable. */
function readPidFile(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/** Remove the PID file if it contains our PID (or is stale). */
function releaseLock(): void {
  for (const file of [pidFile, legacyPidFile]) {
    const pid = readPidFile(file);
    if (pid === undefined) continue;
    // Only remove if it's our PID or the process is dead (stale lock).
    if (pid === process.pid || !isProcessAlive(pid)) {
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
}

// Kill any existing shim on this port before we try to bind.
const existingPid = readPidFile(pidFile) ?? readPidFile(legacyPidFile);
if (existingPid !== undefined && isProcessAlive(existingPid)) {
  logger.info("stopping existing shim instance", {
    pid: existingPid,
    port: config.port,
  });
  await killProcess(existingPid);
  // Brief pause for the OS to release the listening socket.
  await sleep(500);
}

// Acquire the lock by writing our PID.
writeFileSync(pidFile, String(process.pid));
// Also update the legacy path so the deploy script can find us.
writeFileSync(legacyPidFile, String(process.pid));

// Release the lock on any exit path. The 'exit' event fires for normal
// returns, process.exit(), and signal-induced exits where server.ts's own
// SIGTERM/SIGINT handler calls process.exit(0). (SIGKILL is the only path
// that bypasses 'exit'; a stale-lock check on the next startup handles that.)
process.on("exit", () => {
  releaseLock();
});

// ---------------------------------------------------------------------------

// Derive startup diagnostics directly from the config instead of constructing
// a throwaway ProviderRegistry. The server builds its own long-lived instance
// internally, so constructing one here would create a second registry whose
// state could drift from the one actually serving requests. This mirrors
// ProviderRegistry.getDefaultProvider() (first priority entry that has a
// config) and getProviderNames() (all config keys, insertion order).
const defaultProviderName =
  config.providers.priority.find((name) => name in config.providers.configs) ??
  Object.keys(config.providers.configs)[0];
const adapters = Object.keys(config.providers.configs);

logger.info("starting shim", {
  port: config.port,
  host: config.host,
  defaultProvider: defaultProviderName,
  failover: config.failover,
  routingStrategy: config.routingStrategy,
  sessionAffinity: config.sessionAffinity.enabled,
  adapters,
});

const server = createServer(config, logger);

server.listen(config.port, config.host, () => {
  // When config.port is 0 the OS assigns an ephemeral port; report the
  // actually bound port rather than the configured 0 so logs are useful.
  const addr = server.address();
  const boundPort =
    addr && typeof addr === "object" ? addr.port : config.port;
  logger.info("listening", {
    port: boundPort,
    host: config.host,
  });
});

// If the port is still in use (e.g. another process without a PID file),
// exit with a clear error rather than an opaque EADDRINUSE stack trace.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.error("port already in use", {
      port: config.port,
      hint: "Another process is holding the port. Stop it or use a different port.",
    });
  } else {
    logger.error("server error", { error: err });
  }
  process.exit(1);
});

// Graceful shutdown on SIGTERM / SIGINT is handled inside createServer, which
// owns the HTTP server and clears its session-affinity cleanup interval. When
// it calls process.exit(0), the 'exit' handler above releases the PID lock.

// Process-level safety net: swallow transient transport errors (ECONNRESET,
// UND_ERR_SOCKET, etc.) that fire after a fetch() has already resolved — a
// CDN edge resetting a socket must never take the process down. Everything
// else (programming bugs) stays fatal (exit 1) to surface loudly.
installProcessSafetyNet({
  log: (...args) => logger.error("process-safety-net", { detail: args }),
});
