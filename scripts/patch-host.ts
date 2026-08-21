/**
 * Host patcher (replaces reapply-inference-patch.sh).
 *
 * Patches host-main.cjs so that:
 *   - SAND_DEFAULT_MODEL_ID is set to the configured default model.
 *   - The `createCursorInferencePromptSession` function body is replaced with
 *     a "routing client" that proxies all `.stream()` calls through the local
 *     inference shim (Connect-RPC), reading the proxy URL from
 *     SAND_INFERENCE_PROXY_URL or the proxy URL file.
 *
 * Usage:
 *   node dist/scripts/patch-host.js [hostMainPath] [proxyUrlPath]
 *
 * Defaults:
 *   hostMainPath  = SAND_HOST_DIR/host-main.cjs
 *   proxyUrlPath  = SAND_HOST_DIR/inference-proxy.url
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";

const log = createLogger();

/**
 * The routing-client function body that replaces the original
 * `createCursorInferencePromptSession` implementation. This is the TypeScript
 * port of the original reapply-inference-patch.sh NODE heredoc.
 *
 * It reads the proxy URL from SAND_INFERENCE_PROXY_URL or the proxy file,
 * constructs a Connect client pointed at the shim, and routes every `.stream()`
 * call through it.
 */
const ROUTING_CLIENT_BODY = `{
  const proxyUrl =
    process.env.SAND_INFERENCE_PROXY_URL ||
    (() => {
      try {
        return require("fs").readFileSync(
          process.env.SAND_INFERENCE_PROXY_URL_FILE ||
            (process.env.SAND_HOST_DIR || "/root/sand-host") +
              "/inference-proxy.url",
          "utf8"
        ).trim();
      } catch (e) {
        return null;
      }
    })();
  if (!proxyUrl) {
    throw new Error("routingClient: no inference proxy URL configured");
  }
  const { createConnectClient } = require("@connectrpc/connect");
  const { createGrpcTransport } = require("@connectrpc/connect-node");
  const { createClient } = require("@connectrpc/connect");
  const transport = createGrpcTransport({ baseUrl: proxyUrl, httpVersion: "2" });
  const client = createClient(transport);
  const routingClient = {
    stream: function (req) {
      return client.stream(req);
    },
    unary: function (req) {
      return client.unary(req);
    },
  };
  return routingClient;
}`;

/** The marker we grep for to detect an already-patched file. */
const PATCH_MARKER = "routingClient";

/**
 * The exact original function body (string match attempted first). Bundles
 * vary, so this is a best-effort literal that we fall back from to regex.
 */
const ORIGINAL_FUNCTION_REGEX =
  /function\s+createCursorInferencePromptSession\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}/;

/**
 * Replace the SAND_DEFAULT_MODEL_ID assignment with the configured model.
 * Matches `SAND_DEFAULT_MODEL_ID = "..."` or `SAND_DEFAULT_MODEL_ID="..."`.
 */
function patchDefaultModel(src: string, defaultModel: string): string {
  const re = /SAND_DEFAULT_MODEL_ID\s*=\s*"[^"]*"/;
  if (re.test(src)) {
    return src.replace(re, `SAND_DEFAULT_MODEL_ID = "${defaultModel}"`);
  }
  return src;
}

/**
 * Replace the createCursorInferencePromptSession function body with the
 * routing client. Tries an exact string match first, then a regex fallback.
 * Returns the patched source and whether a replacement was made.
 */
function patchFunction(src: string): { src: string; patched: boolean } {
  // Try exact string match against a few known original bodies first.
  // (The original bundle's body is not available here, so we go straight to
  // the regex fallback which handles arbitrary whitespace/content.)
  const match = src.match(ORIGINAL_FUNCTION_REGEX);
  if (match && match.index !== undefined) {
    const signatureMatch = match[0].match(/function\s+createCursorInferencePromptSession\s*\([^)]*\)/);
    if (signatureMatch) {
      const replaced = `function createCursorInferencePromptSession${signatureMatch[0].slice(signatureMatch[0].indexOf("("))} ${ROUTING_CLIENT_BODY}`;
      return {
        src: src.slice(0, match.index) + replaced + src.slice(match.index + match[0].length),
        patched: true,
      };
    }
  }
  return { src, patched: false };
}

function main(): void {
  const config = loadConfig();
  const sandHostDir =
    process.env.SAND_HOST_DIR || config.hostConfig.sandHostDir || path.join(process.env.HOME ?? "/root", "sand-host");
  const defaultModel = config.hostConfig.defaultModel;

  const hostMainPath = process.argv[2] || path.join(sandHostDir, "host-main.cjs");
  const proxyUrlPath = process.argv[3] || path.join(sandHostDir, "inference-proxy.url");

  if (!existsSync(hostMainPath)) {
    log.error("patch-host: host-main.cjs not found", { path: hostMainPath });
    process.exit(1);
  }
  if (!existsSync(proxyUrlPath)) {
    log.warn("patch-host: proxy URL file not found", { path: proxyUrlPath });
  }

  let src: string;
  try {
    src = readFileSync(hostMainPath, "utf8");
  } catch (err) {
    log.error("patch-host: failed to read host-main.cjs", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Already patched?
  const hasMarker = src.includes(PATCH_MARKER);
  const hasCorrectModel = src.includes(`SAND_DEFAULT_MODEL_ID = "${defaultModel}"`);

  if (hasMarker && hasCorrectModel) {
    log.info("patch-host: already patched, nothing to do");
    process.exit(0);
  }

  // Apply patches.
  let patched = src;
  patched = patchDefaultModel(patched, defaultModel);
  const fnResult = patchFunction(patched);
  patched = fnResult.src;

  if (!fnResult.patched && !hasCorrectModel) {
    log.error("patch-host: could not locate createCursorInferencePromptSession to patch");
    process.exit(1);
  }

  // Write back.
  try {
    writeFileSync(hostMainPath, patched, "utf8");
  } catch (err) {
    log.error("patch-host: failed to write host-main.cjs", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Syntax check the patched file.
  try {
    execSync(`node --check ${JSON.stringify(hostMainPath)}`, { stdio: "pipe" });
  } catch (err) {
    log.error("patch-host: patched file failed syntax check", { error: err instanceof Error ? err.message : String(err) });
    // Restore the original to avoid leaving a broken host.
    try {
      writeFileSync(hostMainPath, src, "utf8");
    } catch {
      /* best-effort restore */
    }
    process.exit(1);
  }

  log.info("patch-host: patched successfully", { path: hostMainPath, defaultModel });
  process.exit(0);
}

main();
