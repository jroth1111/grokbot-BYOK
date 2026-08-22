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
import { resolveSandHostDir } from "../src/utils/daemon.js";
import { createLogger } from "../src/log.js";
import type { ShimConfig } from "../src/types.js";

const log = createLogger();

/**
 * Escape a string so it can be embedded verbatim inside a double-quoted
 * JavaScript string literal in the generated source. Backslashes and double
 * quotes are escaped, and raw newlines are converted to their escape sequences
 * so the emitted line stays a single valid string literal.
 */
function escapeJsStringLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

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
 * Matches the function signature up to (and including) its opening brace.
 * The parameter list is captured so it can be preserved verbatim in the
 * replacement. We deliberately do NOT try to match the body with a regex:
 * the original bundle contains nested blocks whose closing braces would
 * terminate a non-greedy `[\s\S]*?\}` far too early. Instead the body is
 * located by brace counting in {@link patchFunction}.
 */
const FUNCTION_SIGNATURE_REGEX =
  /function\s+createCursorInferencePromptSession\s*\(([^)]*)\)\s*\{/;

/**
 * Replace the SAND_DEFAULT_MODEL_ID assignment with the configured model.
 * Matches `SAND_DEFAULT_MODEL_ID = "..."` and `SAND_DEFAULT_MODEL_ID = '...'`
 * (with arbitrary surrounding whitespace), normalizing the result to a
 * double-quoted literal.
 *
 * The configured model is escaped for inclusion in a JS string literal and
 * substituted via a replacer *function* so that any `$` characters in the
 * model name are not interpreted as `String.prototype.replace` patterns
 * (e.g. `$&`, `$1`, `` $` ``, `$'`).
 */
function patchDefaultModel(src: string, defaultModel: string): string {
  // Match a complete JS string literal (double or single quoted), honouring
  // backslash escapes so an existing value like `"my\"model"` is matched in
  // full rather than truncating at the escaped quote.
  const re = /\bSAND_DEFAULT_MODEL_ID\b\s*=\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/;
  if (!re.test(src)) {
    log.warn("patch-host: SAND_DEFAULT_MODEL_ID assignment not found; leaving unchanged");
    return src;
  }
  const escaped = escapeJsStringLiteral(defaultModel);
  return src.replace(re, () => `SAND_DEFAULT_MODEL_ID = "${escaped}"`);
}

/**
 * Replace the createCursorInferencePromptSession function body with the
 * routing client. The signature is located with {@link FUNCTION_SIGNATURE_REGEX}
 * and the matching closing brace is found by counting braces (ignoring braces
 * inside string/template literals, regex literals, and comments) so that
 * nested blocks in the original body do not terminate the match early.
 *
 * Returns the patched source and whether a replacement was made.
 */
function patchFunction(src: string): { src: string; patched: boolean } {
  const sigMatch = src.match(FUNCTION_SIGNATURE_REGEX);
  if (!sigMatch || sigMatch.index === undefined) {
    return { src, patched: false };
  }

  // Index of the opening `{` of the function body (last char of the signature).
  const openBraceIdx = sigMatch.index + sigMatch[0].length - 1;
  const endIdx = findMatchingBrace(src, openBraceIdx);
  if (endIdx === -1) {
    log.warn("patch-host: could not find matching brace for createCursorInferencePromptSession");
    return { src, patched: false };
  }

  const params = sigMatch[1];
  const replaced = `function createCursorInferencePromptSession(${params}) ${ROUTING_CLIENT_BODY}`;
  return {
    src: src.slice(0, sigMatch.index) + replaced + src.slice(endIdx + 1),
    patched: true,
  };
}

/**
 * Given the index of an opening `{` in `src`, return the index of the matching
 * closing `}`, accounting for nested braces and skipping over string/template
 * literals, regex literals, and line/block comments. Returns -1 if no match is
 * found (unbalanced input).
 */
function findMatchingBrace(src: string, openIdx: number): number {
  if (src[openIdx] !== "{") return -1;
  let depth = 1;
  let i = openIdx + 1;
  let inStr: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  // Heuristic for distinguishing a regex literal (`/x/`) from division: a
  // regex is assumed when the last non-space, non-comment significant char is
  // one that can legally precede a regex (or when there is none yet).
  let prevSignificant = "";

  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
        prevSignificant = ch;
      }
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "/") {
      const regexAfter =
        prevSignificant === "" || /[(,=:;!&|?{}[\];]/.test(prevSignificant);
      if (regexAfter) {
        // Scan to the closing `/`, skipping escaped chars and character classes.
        i++;
        let inClass = false;
        while (i < src.length) {
          const c = src[i];
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]" && inClass) inClass = false;
          else if (c === "/" && !inClass) {
            i++;
            break;
          }
          i++;
        }
        prevSignificant = "/";
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i++;
  }
  return -1;
}

/**
 * Write the inference proxy URL to the proxy URL file so the patched host can
 * discover the shim at runtime. The URL is taken from SAND_INFERENCE_PROXY_URL
 * if set, otherwise derived from the shim's configured listen address
 * (`http://<host>:<port>`). Nothing else in the project writes this file, so
 * without this step the patched host would always throw
 * "routingClient: no inference proxy URL configured" unless the env var is set.
 *
 * A write failure is non-fatal: the env-var fallback still works, and an
 * already-running shim may itself refresh the file later.
 */
function writeProxyUrlFile(proxyUrlPath: string, config: ShimConfig): void {
  const proxyUrl =
    process.env.SAND_INFERENCE_PROXY_URL || `http://${config.host}:${config.port}`;
  try {
    writeFileSync(proxyUrlPath, proxyUrl + "\n", "utf8");
    log.info("patch-host: wrote proxy URL file", { path: proxyUrlPath, proxyUrl });
  } catch (err) {
    log.warn("patch-host: failed to write proxy URL file", {
      path: proxyUrlPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function main(): void {
  const config = loadConfig();
  const sandHostDir = resolveSandHostDir(config);
  const defaultModel = config.hostConfig.defaultModel;

  const hostMainPath = process.argv[2] || path.join(sandHostDir, "host-main.cjs");
  const proxyUrlPath = process.argv[3] || path.join(sandHostDir, "inference-proxy.url");

  if (!existsSync(hostMainPath)) {
    log.error("patch-host: host-main.cjs not found", { path: hostMainPath });
    process.exit(1);
  }

  // Ensure the proxy URL file exists so the patched host can locate the shim.
  // Done before reading host-main.cjs so it is refreshed even on the
  // already-patched / no-op path.
  writeProxyUrlFile(proxyUrlPath, config);

  let src: string;
  try {
    src = readFileSync(hostMainPath, "utf8");
  } catch (err) {
    log.error("patch-host: failed to read host-main.cjs", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Already patched? Compare against the escaped form since that is what we
  // write to disk; comparing the raw model would never match a name containing
  // characters that get escaped (e.g. `"` or `\`).
  const hasMarker = src.includes(PATCH_MARKER);
  const expectedModelLiteral = `SAND_DEFAULT_MODEL_ID = "${escapeJsStringLiteral(defaultModel)}"`;
  const hasCorrectModel = src.includes(expectedModelLiteral);

  if (hasMarker && hasCorrectModel) {
    log.info("patch-host: already patched, nothing to do");
    process.exit(0);
  }

  // Apply patches. The function patch is only applied when the marker is
  // absent; re-running patchFunction on an already-patched file would match
  // the routing-client body (which itself contains nested braces) and
  // corrupt it. When the marker is present we only need to refresh the model.
  let patched = src;
  let fnPatched = false;
  if (!hasMarker) {
    const fnResult = patchFunction(patched);
    patched = fnResult.src;
    fnPatched = fnResult.patched;
    if (!fnPatched) {
      log.error("patch-host: could not locate createCursorInferencePromptSession to patch");
      process.exit(1);
    }
  }
  patched = patchDefaultModel(patched, defaultModel);

  // Create a backup before writing so the original can be recovered even if
  // the process is killed between the write and the syntax check below.
  const backupPath = `${hostMainPath}.bak`;
  try {
    writeFileSync(backupPath, src, "utf8");
  } catch (err) {
    log.warn("patch-host: failed to write backup", {
      path: backupPath,
      error: err instanceof Error ? err.message : String(err),
    });
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
      /* best-effort restore; the .bak backup still exists on disk */
    }
    process.exit(1);
  }

  log.info("patch-host: patched successfully", { path: hostMainPath, defaultModel, fnPatched });
  process.exit(0);
}

main();
