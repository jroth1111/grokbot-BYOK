/**
 * Entry point for the Connect-RPC to OpenAI translation shim.
 *
 * Loads configuration, creates a structured logger, emits startup diagnostics,
 * and starts the HTTP server returned by {@link createServer}. Process-level
 * signal and error handlers ensure a clean shutdown and that no error goes
 * unlogged.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createServer } from "./server.js";
import { ProviderRegistry } from "./providers/registry.js";

/** Force-exit grace period (ms) after a graceful-shutdown signal. */
const SHUTDOWN_GRACE_MS = 10_000;

const config = loadConfig();
const logger = createLogger();

// Build a registry purely for startup diagnostics (the server builds its own
// long-lived instance internally).
const registry = new ProviderRegistry(
  config.providers.configs,
  config.providers.priority,
);
const defaultProvider = registry.getDefaultProvider();
const adapters = registry.getProviderNames();

logger.info("starting shim", {
  port: config.port,
  host: config.host,
  defaultProvider: defaultProvider.name,
  failover: config.failover,
  adapters,
});

const server = createServer(config, logger);

server.listen(config.port, config.host, () => {
  logger.info("listening", {
    port: config.port,
    host: config.host,
  });
});

// Graceful shutdown on termination signals.
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("shutting down", {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Never let an unexpected error slip by silently.
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { error: err });
});
process.on("unhandledRejection", (err) => {
  logger.error("unhandledRejection", { error: err });
});
