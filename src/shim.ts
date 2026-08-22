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

// Check for an existing shim on this port. If one is running, refuse to
// start rather than silently killing it — the user might have an active
// session on the first instance and a silent kill would be destructive.
const existingPid = readPidFile(pidFile) ?? readPidFile(legacyPidFile);
if (existingPid !== undefined && isProcessAlive(existingPid)) {
  logger.error("another shim instance is already running", {
    pid: existingPid,
    port: config.port,
    pidFile,
    hint: "Stop the existing instance first (kill the process or remove the PID file), " +
          "or use a different SHIM_PORT",
  });
  console.error(
    `\n  Error: shim already running on port ${config.port} (pid ${existingPid}).\n` +
    `  To start a second instance, set SHIM_PORT to a different value.\n` +
    `  To replace the existing instance, kill it first: kill ${existingPid}\n`,
  );
  process.exit(1);
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
