# grokbot-BYOK v2

Cursor sand-host BYOK (Bring Your Own Key) inference adapter. Routes all
inference through a local shim that translates between Cursor's Connect-RPC
protocol and OpenAI-compatible LLM providers.

TypeScript rewrite of grokbot-BYOK with modular architecture, structured
logging, circuit-breaker failover, vision fallback routing, and 342 tests.

## Quick start

```bash
# 1. Clone
git clone https://github.com/jroth1111/grokbot-BYOK.git
cd grokbot-BYOK

# 2. One-command setup (installs deps, creates config, builds, starts daemons)
#    Pass API keys via CLI flags — fully non-interactive:
npm run setup -- --opencode-key sk-xxx --openrouter-key sk-or-xxx

# Or via env vars:
OPENCODE_API_KEY=sk-xxx OPENROUTER_API_KEY=sk-or-xxx npm run setup

# Or without any keys (kilo is keyless — works with zero configuration):
npm run setup
```

The setup script is fully non-interactive. It:
- Installs npm dependencies
- Creates `config/config.json` and `.env` from examples
- Writes API keys from CLI flags or env vars into `.env`
- Builds the shim + scripts
- Starts three background daemons (shim, host watcher, health watchdog)
- Runs a smoke test
- Exits 0 on success, 1 on failure (agent-friendly)

If required keys are missing, it exits with an error showing exactly which
keys are needed and how to provide them.

## Managing daemons

```bash
npm run setup          # Start/restart everything (builds, stops old, starts new)
npm run setup -- --status   # Check daemon status (exit 0 if all running, 1 if not)
npm run setup -- --stop     # Stop all daemons
npm run setup -- --no-build # Restart without rebuilding
npm run setup -- --no-watch # Start without host watcher
npm run setup -- --quiet    # Minimal output (agent-friendly)
npm start              # Start shim only (foreground)
npm stop               # Stop all daemons
npm status             # Check daemon status
```

### Providing API keys (non-interactive)

Keys can be passed via CLI flags, env vars, or written to `.env` manually:

```bash
# CLI flags (keys are written to .env automatically)
npm run setup -- --opencode-key sk-xxx --kilo-key yyy --openrouter-key sk-or-zzz

# Env vars (keys are written to .env automatically)
OPENCODE_API_KEY=sk-xxx npm run setup

# Or just edit .env directly and run setup without flags
```

### Daemon processes

| Daemon | PID file | Log file | Purpose |
|--------|----------|----------|---------|
| Shim | `/tmp/inference-shim.pid` | `/tmp/inference-shim.log` | The inference proxy itself |
| Host watcher | `/tmp/grokbot-watch-host.pid` | `/tmp/grokbot-watch-host.log` | Re-patches Cursor's host bundle when it updates |
| Health watchdog | `/tmp/grokbot-health-check.pid` | `/tmp/grokbot-health-check.log` | Monitors shim health, auto-redeploys on failure |

The host watcher is the key to robust re-attachment: when Cursor's supervisor
updates or reinstalls `host-main.cjs`, the watcher detects the change,
re-applies the routing-client patch, and restarts the host process. This
happens automatically — no manual intervention needed after Cursor updates.

## Providers

The shim routes requests through providers in priority order with automatic
failover. Providers with missing API keys are skipped automatically (except
keyless ones).

### Provider list

| Provider | Env var | Required | Models | Description |
|----------|---------|----------|--------|-------------|
| `opencode-go` | `OPENCODE_API_KEY` | yes | ox-alpha-free, qwen3.8-max (vision) | Primary. Frontier reasoning, free tier |
| `kilo` | `KILO_API_KEY` | no (keyless) | stealth/ox-alpha | Keyless: 200 req/hr/IP without a key |
| `openrouter` | `OPENROUTER_API_KEY` | no | stealth/ox-alpha | OpenRouter gateway |
| `opencode-zen` | `OPENCODE_API_KEY` | no | x-preview-f-free | Secondary OpenCode endpoint (shared key) |
| `local` | `LOCAL_API_KEY` | no | glm-5.2, glm-5.1, swe-1-7 | WindsurfAPI on localhost |

**Failover order:** `opencode-go` → `kilo` → `openrouter` → `opencode-zen` → `local`

### Where to get API keys

| Provider | URL | Notes |
|----------|-----|-------|
| OpenCode | https://opencode.ai | One key works for both `opencode-go` and `opencode-zen` |
| Kilo | https://kilo.ai | Optional — anonymous access works without a key |
| OpenRouter | https://openrouter.ai/keys | Get a key at the keys page |
| WindsurfAPI | Local | `LOCAL_API_KEY` must match `API_KEY` in WindsurfAPI/.env |

### Where to put API keys

All keys go in **`.env`** in the project root. The shim sources `.env`
automatically at startup. See `.env.example` for the full template.

```bash
# .env
OPENCODE_API_KEY=sk-your-opencode-key
KILO_API_KEY=your-kilo-key          # optional (keyless works without this)
OPENROUTER_API_KEY=sk-or-v1-your-key
LOCAL_API_KEY=sk-local-test         # must match WindsurfAPI's API_KEY
```

String values in `config/config.json` support `${ENV_VAR}` interpolation, so
the config references keys by env var name — no secrets in the config file.

## Configuration

Config is a single JSON file (`config/config.json`), validated by a zod schema
at startup. Copy `config/config.example.json` to get started.

```json
{
  "port": 8788,
  "host": "127.0.0.1",
  "failover": true,
  "requestTimeoutMs": 30000,
  "providers": {
    "priority": ["opencode-go", "kilo", "openrouter", "opencode-zen", "local"],
    "configs": { ... }
  },
  "hostConfig": {
    "sandHostDir": "${SAND_HOST_DIR}",
    "defaultModel": "Ox Alpha Free"
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_API_KEY` | — | OpenCode Go + Zen API key |
| `KILO_API_KEY` | — | Kilo gateway key (optional, keyless works without it) |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `LOCAL_API_KEY` | `sk-local-test` | Must match WindsurfAPI's `API_KEY` |
| `WINDSURF_API_KEY` | — | Override Devin session token (auto-read from credentials.toml if unset) |
| `DROUGHT_RESTRICT_PREMIUM` | `0` | Disable WindsurfAPI's stale premium gate |
| `VISION_FALLBACK_MODEL` | `qwen3.8-max` | Re-route image requests to this vision-capable model |
| `SHIM_PORT` | `8788` | Override listen port |
| `SHIM_HOST` | `127.0.0.1` | Override listen host |
| `SHIM_FAILOVER` | `true` | Set to `0` to disable provider failover |
| `SHIM_LOG_DIR` | — | Directory for tool-schema dumps (empty = disabled) |

## Architecture

```
src/
  types.ts                    Shared types (Provider, ShimConfig, etc.)
  config.ts                   Config loader (JSON file + env overrides)
  config/schema.ts            Zod validation schema
  log.ts                      Structured JSON logger
  shim.ts                     Entry point (PID lock, startup, shutdown)
  server.ts                   HTTP server with failover + vision fallback
  protocol/
    connect.ts                Connect-RPC envelope codec
    sse.ts                    SSE parser for OpenAI streaming
    proto3.ts                 Proto3 JSON helpers (Struct, Value, enums)
  translate/
    request.ts                InferenceStreamRequest -> OpenAI ChatRequest
    response.ts               OpenAI chunks -> InferenceStreamResponse frames
    tools.ts                  Tool call accumulator with error recovery
    vision-guard.ts           Image detection and vision fallback routing
  providers/
    base.ts                   BaseProvider + normalizeModelId
    registry.ts               Provider registry with deterministic routing
    failover.ts               Circuit breaker
    compat.ts                 Provider compatibility detection (vision, etc.)
  observability/
    log-redaction.ts          Console credential redaction
    process-safety-net.ts     Unhandled error/rejection catcher
    metrics.ts                Request counters
    guardrails.ts             Runtime-tunable safety settings
    error-classify.ts         Error classification for failover decisions
scripts/
  setup.ts                    One-command setup (build, start all daemons)
  start-shim.ts               Shim launcher (WindsurfAPI auto-start + seeding)
  deploy.ts                   Atomic deploy (build, stop, deploy, start, test)
  health-check.ts             Watchdog (JSON log parsing, auto-deploy)
  patch-host.ts               Host bundle patcher
  watch-host.ts               Bundle watcher (auto re-patch on Cursor updates)
  live-test.js                Live request test against the shim
  image-test.js               Image/vision request test
  windsurf-probe.js           WindsurfAPI connectivity probe
config/
  config.example.json         Example config with all providers
test/
  12 test files, 342 tests
```

## Routing

Providers are checked in priority order. The first provider whose model map
contains the normalized model id wins. If none match, the first provider in
the priority list is used (default fallback).

### Vision fallback

When a request contains images but the resolved model doesn't support vision,
the shim re-routes to `VISION_FALLBACK_MODEL` (default: `qwen3.8-max`) instead
of silently stripping the images.

## Failover

When `failover: true` (default), the shim tries providers in priority order
until one succeeds. A circuit breaker tracks failures per provider:

- After 3 consecutive failures, the circuit opens (provider is skipped)
- After 30s, one half-open probe is allowed
- If the probe succeeds, the circuit closes
- If the probe fails, the circuit stays open for another 30s

## Deploy

For advanced deployment (host patching, symlink deploy):

```bash
# Full deploy: typecheck, build, stop old, symlink, start, patch host, test
node dist/scripts/deploy.js

# Copy instead of symlink
node dist/scripts/deploy.js --copy

# Skip host restart
node dist/scripts/deploy.js --no-restart
```

## Tests

```bash
npm test              # Run all 342 tests
npm run test:watch    # Watch mode
npm run typecheck     # Type check only
```

## Build

```bash
npm run build         # Build shim only
npm run build:all     # Build shim + scripts
```

The build uses esbuild to produce standalone bundled `.js` files with no
runtime dependencies. The shim is a single `dist/shim.js` file.

## License

MIT
