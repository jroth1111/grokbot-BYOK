/**
 * Translate a Connect InferenceStreamRequest into an OpenAI ChatCompletion
 * request body.
 *
 * The resulting body is always configured for streaming (`stream: true`) with
 * usage reporting enabled. The `model` field is intentionally left empty here
 * — the server fills it in after routing the request to a provider.
 */

import type {
  InferenceStreamRequest,
  InferenceTool,
  InferenceMessage,
  InferenceContentPart,
  InferenceToolResultPart,
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIContentPart,
  OpenAITool,
  OpenAIToolCall,
} from "../types.js";
import {
  roleToOpenAI,
  structToJs,
  safeStringify,
} from "../protocol/proto3.js";

/**
 * Convert a single InferenceMessage's `parts` array into an array of OpenAI
 * content parts.
 *
 * - text  -> { type: "text", text }
 * - image -> { type: "image_url", image_url: { url } }
 * - file  -> { type: "text", text: "[file: name]" }
 */
function convertContentParts(
  parts: InferenceContentPart[],
): OpenAIContentPart[] {
  const out: OpenAIContentPart[] = [];
  for (const part of parts) {
    if (part.text && part.text.text != null) {
      out.push({ type: "text", text: part.text.text });
    } else if (part.image) {
      const url = part.image.url ?? part.image.data ?? "";
      out.push({ type: "image_url", image_url: { url } });
    } else if (part.file) {
      const name = part.file.name ?? "";
      out.push({ type: "text", text: `[file: ${name}]` });
    }
  }
  return out;
}

/**
 * Convert an InferenceMessage's `toolContent` parts into OpenAI tool messages.
 *
 * Each tool result part becomes a message with role "tool", the tool_call_id,
 * and a stringified content payload.
 */
function convertToolContent(
  parts: InferenceToolResultPart[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const part of parts) {
    const toolCallId = part.toolCallId ?? "";
    const content = safeStringify(part.result);
    out.push({ role: "tool", tool_call_id: toolCallId, content });
  }
  return out;
}

/**
 * Convert the request's declared tools into OpenAI tool definitions.
 *
 * Tools with empty/missing names are filtered out. Tool parameters are
 * unwrapped from proto3 Struct form (or default to `{}`).
 */
function convertTools(tools: InferenceTool[] | undefined): OpenAITool[] {
  if (!tools) {
    return [];
  }
  const out: OpenAITool[] = [];
  for (const t of tools) {
    const name = t.name ?? "";
    if (name === "") {
      continue;
    }
    let parameters = structToJs(t.parameters);
    // The host wraps JSON-schema tool parameters in a { jsonSchema: { ... } }
    // envelope (proto3 Struct form). OpenAI's API expects the raw JSON schema
    // directly as `parameters`, so unwrap the envelope if present.
    if (
      parameters &&
      typeof parameters === "object" &&
      "jsonSchema" in parameters &&
      typeof parameters.jsonSchema === "object" &&
      parameters.jsonSchema !== null
    ) {
      parameters = parameters.jsonSchema as Record<string, unknown>;
    }
    out.push({
      type: "function",
      function: {
        name,
        description: t.description ?? "",
        parameters,
      },
    });
  }
  return out;
}

/**
 * Translate an {@link InferenceStreamRequest} into an OpenAI
 * {@link OpenAIChatRequest} body configured for streaming.
 *
 * @param reqJson  The parsed Connect request.
 * @returns        The OpenAI chat completion request body (model left empty).
 */
export function convertRequest(reqJson: InferenceStreamRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  for (const m of reqJson.messages ?? []) {
    // Tool results expand into one or more "tool" role messages.
    if (m.toolContent != null && m.toolContent.parts != null) {
      messages.push(...convertToolContent(m.toolContent.parts));
      continue;
    }

    const role = roleToOpenAI(m.role);

    // Build the content for this message.
    let content: string | OpenAIContentPart[] | null;
    if (m.text != null) {
      content = m.text;
    } else if (m.parts != null && m.parts.parts != null) {
      content = convertContentParts(m.parts.parts);
    } else {
      content = "";
    }

    if (role === "assistant") {
      // Coerce falsy/empty content to null for assistant messages: both the
      // empty string and an empty content-parts array should become null
      // (an empty array is truthy, so a plain `|| null` would let it through).
      const hasContent = Array.isArray(content)
        ? content.length > 0
        : content !== "";
      const entry: OpenAIMessage = { role, content: hasContent ? content : null };

      const toolCalls: OpenAIToolCall[] = [];
      for (const tc of m.toolCalls ?? []) {
        toolCalls.push({
          id: tc.toolCallId ?? "",
          type: "function",
          function: {
            name: tc.toolName ?? "",
            arguments: safeStringify(structToJs(tc.args)),
          },
        });
      }
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls;
      }
      messages.push(entry);
    } else {
      messages.push({ role, content });
    }
  }

  const body: OpenAIChatRequest = {
    model: "",
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const tools = convertTools(reqJson.tools);
  if (tools.length > 0) {
    body.tools = tools;
  }

  const cfg = reqJson.modelConfig;
  if (cfg) {
    if (cfg.maxTokens != null && Number.isFinite(cfg.maxTokens)) {
      body.max_tokens = cfg.maxTokens;
    }
    if (cfg.temperature != null && Number.isFinite(cfg.temperature)) {
      body.temperature = cfg.temperature;
    }
    if (cfg.topP != null && Number.isFinite(cfg.topP)) {
      body.top_p = cfg.topP;
    }
    if (cfg.stopSequences != null && cfg.stopSequences.length > 0) {
      body.stop = cfg.stopSequences;
    }
  }

  return body;
}
