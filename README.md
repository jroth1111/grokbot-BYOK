# grokbot-BYOK v2

Cursor sand-host BYOK (Bring Your Own Key) inference adapter. Routes all
inference through a local shim that translates between Cursor's Connect-RPC
protocol and OpenAI-compatible LLM providers.

TypeScript rewrite of grokbot-BYOK with modular architecture, structured
logging, circuit-breaker failover, and 82 unit/integration tests.

## Architecture

```
src/
  types.ts                    Shared types (Provider, ShimConfig, etc.)
  config.ts                   Config loader (JSON file + env overrides)
  log.ts                      Structured JSON logger
  shim.ts                     Entry point
  server.ts                   HTTP server with failover + timeouts
  protocol/
    connect.ts                Connect-RPC envelope codec
    sse.ts                    SSE parser for OpenAI streaming
    proto3.ts                 Proto3 JSON helpers (Struct, Value, enums)
  translate/
    request.ts                InferenceStreamRequest -> OpenAI ChatRequest
    response.ts               OpenAI chunks -> InferenceStreamResponse frames
    tools.ts                  Tool call accumulator with error recovery
  providers/
    base.ts                   BaseProvider + normalizeModelId
    registry.ts               Provider registry with deterministic routing
    failover.ts               Circuit breaker
    opencode-go.ts            OpenCode Go adapter factory
    opencode-zen.ts           OpenCode Zen adapter factory
    local.ts                  Local backend adapter factory
scripts/
  deploy.ts                   Atomic deploy (build, stop, deploy, start, test)
  health-check.ts             Watchdog (JSON log parsing, auto-deploy)
  patch-host.ts               Host bundle patcher
  watch-host.ts               Bundle watcher (auto re-patch on Cursor updates)
test/
  protocol.test.ts            38 tests: Connect, SSE, proto3
  routing.test.ts             16 tests: registry, failover, circuit breaker
  translate.test.ts           26 tests: request/response/tools translation
  e2e.test.ts                  2 tests: full server round-trip
config/
  config.example.json         Example config with all providers
```

## Key improvements over v1

1. **Modular architecture** — 15 focused files instead of one 737-line monolith.
2. **Single routing rule** — providers checked in priority order, first match wins. No 5-level priority system with shared alias maps.
3. **Circuit breaker** — providers that fail repeatedly are skipped for 30s, then probed. No blind retry of dead providers.
4. **Request timeout** — AbortController kills hung upstream requests after 30s.
5. **Graceful shutdown** — SIGTERM drains connections instead of killing mid-stream.
6. **Structured logging** — JSON lines with fields, not regex-parseable text. Health check reads JSON, not grep.
7. **Type safety** — TypeScript strict mode, 82 tests, no untyped object access.
8. **Config validation** — zod schema validates config at startup. No cascading env var fallback chains.
9. **Tool call recovery** — partial tool calls emitted with `isComplete=false` on stream errors.
10. **Single source of truth** — `deploy.ts` symlinks the built shim, no copy drift.

## Quick start

```bash
# Install dependencies
npm install

# Copy config and add your API keys
cp config/config.example.json config/config.json
# Edit config/config.json — set apiKey fields

# Build
npm run build:all

# Run the shim
node dist/shim.js

# Or use the deploy script (builds, deploys, patches host, runs tests)
node dist/scripts/deploy.js
```

## Configuration

Config is a single JSON file (`config/config.json`), validated by a zod schema
at startup. String values support `${ENV_VAR}` interpolation for secrets.

A `.env` file in the project root is sourced automatically at startup (before
config loading), so the shim works standalone — no separate launcher needed.
Already-set env vars take precedence over `.env`.

```json
{
  "port": 8788,
  "host": "127.0.0.1",
  "failover": true,
  "requestTimeoutMs": 30000,
  "providers": {
    "priority": ["opencode-go", "opencode-zen", "local"],
    "configs": {
      "opencode-go": {
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "apiKey": "${OPENCODE_API_KEY}",
        "defaultModel": "ox-alpha-free",
        "models": { "sand-default": "ox-alpha-free", "ox alpha": "ox-alpha-free" }
      },
      "local": {
        "baseUrl": "http://127.0.0.1:3003/v1",
        "apiKey": "${LOCAL_API_KEY}",
        "defaultModel": "glm-5-2"
      }
    }
  },
  "hostConfig": {
    "sandHostDir": "${SAND_HOST_DIR}",
    "defaultModel": "Ox Alpha Free"
  }
}
```

### Credentials

Two keys, defined in `.env` (see `.env.example`):

| Env var | Used by | Description |
|---|---|---|
| `OPENCODE_API_KEY` | `opencode-go`, `opencode-zen` | Single key for both OpenCode endpoints |
| `LOCAL_API_KEY` | `local` | Must match `API_KEY` in `WindsurfAPI/.env` |

No fallback chain. Missing key = clear auth error from the provider.

### Operational overrides

Env var overrides for operational settings: `SHIM_PORT`, `SHIM_HOST`,
`SHIM_LOG_DIR`, `SHIM_FAILOVER`, `SHIM_CONFIG`.

## Routing

Providers are checked in priority order. The first provider whose model map
contains the normalized model id wins. If none match, the first provider in
the priority list is used (default fallback).

This is deterministic — no shared alias maps, no "default adapter's map first"
ambiguity. Each provider owns its model catalog independently.

## Failover

When `failover: true` (default), the shim tries providers in priority order
until one succeeds. A circuit breaker tracks failures per provider:

- After 3 consecutive failures, the circuit opens (provider is skipped)
- After 30s, one half-open probe is allowed
- If the probe succeeds, the circuit closes
- If the probe fails, the circuit stays open for another 30s

## Deploy

```bash
# Full deploy: typecheck, build, stop old, symlink, start, patch host, test
node dist/scripts/deploy.js

# Copy instead of symlink
node dist/scripts/deploy.js --copy

# Skip host restart
node dist/scripts/deploy.js --no-restart
```

## Health monitoring

```bash
# One-shot check
node dist/scripts/health-check.js

# Continuous (60s interval)
node dist/scripts/health-check.js --watch

# Auto-deploy on critical
node dist/scripts/health-check.js --deploy
```

## Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Type check only
npm run typecheck
```

## Build

```bash
# Build shim only
npm run build

# Build shim + scripts
npm run build:all
```

The build uses esbuild to produce standalone bundled `.js` files with no
runtime dependencies. The shim is a single `dist/shim.js` file.

## License

MIT
