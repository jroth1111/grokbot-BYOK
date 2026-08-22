/**
 * Opt-in request/response body capture for debugging.
 *
 * When enabled (env: CAPTURE_BODIES=true), the shim captures a truncated
 * copy of the inbound request body and the first N frames of the outbound
 * response, logging them as structured JSON. This is essential for debugging
 * "what did the model actually return?" issues without a proxy.
 *
 * Bodies are truncated to CAPTURE_MAX_BYTES (default 4096) to avoid logging
 * huge prompts or responses. Tool-call arguments are NOT redacted — this is
 * a debugging tool, not a production log. Enable it only when investigating
 * a specific issue.
 *
 * The capture is keyed by request ID so captured bodies correlate with the
 * request lifecycle logs.
 */
import type { Logger } from "../types.js";

/** Maximum bytes to capture per body (request or response). */
const DEFAULT_MAX_BYTES = 4096;

/** Whether body capture is enabled. */
export function isBodyCaptureEnabled(): boolean {
  return process.env.CAPTURE_BODIES === "true" || process.env.CAPTURE_BODIES === "1";
}

/** Get the max bytes to capture per body. */
function getMaxBytes(): number {
  const raw = process.env.CAPTURE_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** Truncate a string to maxBytes, appending a truncation marker if cut. */
function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return s.slice(0, maxBytes) + ` [...truncated, ${s.length - maxBytes} more bytes]`;
}

/**
 * Log a captured request body. Called after the request body is parsed.
 */
export function captureRequestBody(
  logger: Logger,
  requestId: string,
  body: unknown,
): void {
  if (!isBodyCaptureEnabled()) return;
  const maxBytes = getMaxBytes();
  let text: string;
  try {
    text = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    text = String(body);
  }
  logger.info("captured request body", {
    requestId,
    body: truncate(text, maxBytes),
  });
}

/**
 * Log a captured response summary. Called after the stream completes.
 * Captures the first N text frames and tool call names (not arguments).
 */
export function captureResponseSummary(
  logger: Logger,
  requestId: string,
  frames: ReadonlyArray<unknown>,
): void {
  if (!isBodyCaptureEnabled()) return;
  const maxBytes = getMaxBytes();
  const textParts: string[] = [];
  const toolCalls: string[] = [];
  let totalLen = 0;
  for (const f of frames) {
    const frame = f as Record<string, unknown>;
    const tp = frame.textPart as { text?: string; isFinal?: boolean } | undefined;
    if (tp?.text && !tp.isFinal) {
      if (totalLen + tp.text.length > maxBytes) {
        textParts.push(truncate(tp.text, maxBytes - totalLen));
        break;
      }
      textParts.push(tp.text);
      totalLen += tp.text.length;
    }
    const tc = frame.toolCallPart as { toolCall?: { name?: string } } | undefined;
    if (tc?.toolCall?.name) {
      toolCalls.push(tc.toolCall.name);
    }
  }
  logger.info("captured response summary", {
    requestId,
    text: textParts.join(""),
    toolCalls,
  });
}
