/**
 * Entry point for the Connect-RPC to OpenAI translation shim.
 *
 * Loads configuration, creates a structured logger, emits startup diagnostics,
 * and starts the HTTP server returned by {@link createServer}. Process-level
 * error handlers ensure no error goes unlogged; graceful shutdown on SIGTERM /
 * SIGINT is handled inside {@link createServer} (which owns the HTTP server and
 * its session-affinity cleanup interval), so this module intentionally does
 * not register duplicate signal handlers.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createServer } from "./server.js";
import type { ShimConfig } from "./types.js";

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

// Graceful shutdown on SIGTERM / SIGINT is handled inside createServer, which
// owns the HTTP server and clears its session-affinity cleanup interval.
// Registering handlers here as well would call server.close() twice and
// schedule two force-exit timers, so we intentionally do not register them.

// Never let an unexpected error slip by silently. Once a handler is registered
// for uncaughtException / unhandledRejection, Node no longer exits on its own,
// so we must exit explicitly — continuing in an unknown state is unsafe.
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { error: err });
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  logger.error("unhandledRejection", { error: err });
  process.exit(1);
});
