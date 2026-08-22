/**
 * Provider compat flag system.
 *
 * Ports the auto-detection logic from oh-my-pi's
 * `packages/catalog/src/compat/openai.ts`. `resolveCompat` inspects the
 * provider name, base URL, and model id to produce a `ProviderCompat` record
 * that the request translator consumes via `applyCompatToRequest`.
 */
import type { OpenAIChatRequest, OpenAIMessage } from "../types.js";
import { stripImagesForNonVisionModel } from "../translate/vision-guard.js";

export type ThinkingFormat =
  | "openai"
  | "zai"
  | "qwen"
  | "qwen-chat-template"
  | "openrouter";

export interface ProviderCompat {
  supportsReasoningEffort: boolean;
  thinkingFormat: ThinkingFormat;
  reasoningContentField: string;
  requiresAssistantContentForToolCalls: boolean;
  supportsMultipleSystemMessages: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  streamIdleTimeoutMs: number;
  stripDeepseekSpecialTokens: boolean;
  supportsImages: boolean;
  /**
   * Leaked chat-template markup healing pattern for streaming content.
   *
   * Hosted models sometimes leak raw template markup (Kimi `<|tool_call_begin|>`,
   * DeepSeek DSML envelopes, generic `<think>` tags) into visible `content`
   * instead of returning structured events. When set, the streaming loop in
   * `server.ts` routes `delta.content` through a `StreamMarkupHealing` filter
   * that strips the markup and reconstructs tool calls / reasoning from it.
   *
   * `undefined` disables healing (the default for providers that never leak).
   */
  streamMarkupHealingPattern?: StreamMarkupHealingPattern;
}

/**
 * Leaked-markup healing pattern. See `StreamMarkupHealing` in
 * `translate/markup-healing.ts` for the streaming filter implementation.
 */
export type StreamMarkupHealingPattern =
  | "kimi"
  | "dsml"
  | "qwen"
  | "thinking";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
const KIMI_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS = 300_000;

const GLM_CODING_PLAN_MODEL_PATTERN = /(^|\/)glm-5(?:[.-]|$)/i;

function hostMatches(baseUrl: string, hostname: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === hostname;
  } catch {
    return false;
  }
}

function isDeepseekModelId(modelId: string): boolean {
  return /deepseek/i.test(modelId);
}

function isKimiModelId(modelId: string): boolean {
  return /kimi[-/_.]?k2/i.test(modelId) || /moonshot/i.test(modelId);
}

function isQwenModelId(modelId: string): boolean {
  return /qwen/i.test(modelId);
}

function isGlmModelId(modelId: string): boolean {
  return /glm/i.test(modelId);
}

function isMistralProvider(provider: string, baseUrl: string): boolean {
  return (
    provider === "mistral" ||
    hostMatches(baseUrl, "api.mistral.ai")
  );
}

function isZaiOrZhipu(provider: string, baseUrl: string): boolean {
  return (
    provider === "zai" ||
    provider === "zhipu" ||
    hostMatches(baseUrl, "open.bigmodel.cn") ||
    hostMatches(baseUrl, "api.z.ai")
  );
}

function isGrokProvider(provider: string, baseUrl: string): boolean {
  return (
    provider === "xai" ||
    provider === "grok" ||
    hostMatches(baseUrl, "api.x.ai")
  );
}

function isDashScopeProvider(provider: string, baseUrl: string): boolean {
  return (
    provider === "alibaba" ||
    provider === "alibaba-coding-plan" ||
    hostMatches(baseUrl, "dashscope.aliyuncs.com") ||
    hostMatches(baseUrl, "coding-intl.dashscope.aliyuncs.com")
  );
}

function isNvidiaProvider(provider: string, baseUrl: string): boolean {
  return (
    provider === "nvidia" ||
    hostMatches(baseUrl, "integrate.api.nvidia.com")
  );
}

function isOpenRouterProvider(provider: string, baseUrl: string): boolean {
  return (
    provider === "openrouter" ||
    hostMatches(baseUrl, "openrouter.ai")
  );
}

function detectSupportsMultipleSystemMessages(
  provider: string,
  baseUrl: string,
  modelId: string,
): boolean {
  if (/minimax/i.test(provider)) return false;
  if (isDashScopeProvider(provider, baseUrl)) return false;
  if (isQwenModelId(modelId)) return false;
  const allowedProviders = new Set([
    "openai",
    "azure",
    "azure-openai",
    "openrouter",
    "cerebras",
    "together",
    "groq",
    "deepseek",
    "mistral",
    "xai",
    "zai",
    "zhipu",
    "github-copilot",
    "zenmux",
  ]);
  if (allowedProviders.has(provider)) return true;
  if (hostMatches(baseUrl, "api.openai.com")) return true;
  if (hostMatches(baseUrl, "integrate.api.nvidia.com")) return true;
  if (hostMatches(baseUrl, "api.fireworks.ai")) return true;
  return false;
}

function detectMaxTokensField(
  provider: string,
  baseUrl: string,
  modelId: string,
): "max_tokens" | "max_completion_tokens" {
  if (isMistralProvider(provider, baseUrl)) return "max_tokens";
  if (provider === "moonshot" || isKimiModelId(modelId)) return "max_tokens";
  if (isZaiOrZhipu(provider, baseUrl)) return "max_tokens";
  if (hostMatches(baseUrl, "api.chutes.ai")) return "max_tokens";
  if (hostMatches(baseUrl, "api.fireworks.ai")) return "max_tokens";
  if (provider === "deepseek" || hostMatches(baseUrl, "api.deepseek.com")) {
    return "max_tokens";
  }
  return "max_completion_tokens";
}

function detectStreamIdleTimeoutMs(
  provider: string,
  baseUrl: string,
  modelId: string,
): number {
  if (
    GLM_CODING_PLAN_MODEL_PATTERN.test(modelId) &&
    (isZaiOrZhipu(provider, baseUrl) || provider === "opencode-go" || provider === "opencode-zen")
  ) {
    return GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS;
  }
  if (provider === "alibaba-coding-plan") {
    return GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS;
  }
  if (isKimiModelId(modelId)) {
    return KIMI_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS;
  }
  if (isDeepseekModelId(modelId) && (provider === "deepseek" || hostMatches(baseUrl, "api.deepseek.com"))) {
    return KIMI_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS;
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function detectThinkingFormat(
  provider: string,
  baseUrl: string,
  modelId: string,
): ThinkingFormat {
  const isKimi = isKimiModelId(modelId);
  const isZai = isZaiOrZhipu(provider, baseUrl);
  const isQwen = isQwenModelId(modelId);
  const isAlibaba = isDashScopeProvider(provider, baseUrl);
  const isNvidia = isNvidiaProvider(provider, baseUrl);
  const isOpenRouter = isOpenRouterProvider(provider, baseUrl);
  const isFireworks = hostMatches(baseUrl, "api.fireworks.ai");
  if ((isKimi && !/k3/i.test(modelId)) || isZai || isGlmModelId(modelId)) {
    return "zai";
  }
  if (isOpenRouter) {
    return "openrouter";
  }
  if (isQwen && (isNvidia || provider === "vllm")) {
    return "qwen-chat-template";
  }
  if (isQwen && isFireworks) {
    return "openai";
  }
  if (isAlibaba || isQwen) {
    return "qwen";
  }
  return "openai";
}

function detectSupportsReasoningEffort(
  provider: string,
  baseUrl: string,
  modelId: string,
): boolean {
  if (isGrokProvider(provider, baseUrl)) return false;
  if (isZaiOrZhipu(provider, baseUrl) && !/glm-5/i.test(modelId)) return false;
  return true;
}

export function detectSupportsImages(
  provider: string,
  baseUrl: string,
  modelId: string,
): boolean {
  const id = modelId.toLowerCase();
  // Ox Alpha (ox-alpha-free on OpenCode, stealth/ox-alpha on OpenRouter/Kilo)
  // is a multimodal frontier reasoning model that accepts text, image, and video.
  if (/ox-alpha/.test(id) || /stealth\/ox-alpha/.test(id)) return true;
  if (isGlmModelId(id)) {
    return /glm-.*v\b/.test(id) || /glm-4v/.test(id);
  }
  if (isKimiModelId(id)) return /kimi-k2(?:\.\d+)?/.test(id);
  if (isQwenModelId(id)) return /qwen.*vl|qwen.*vision|qwen3\.8-max/.test(id);
  if (isDeepseekModelId(id)) return /vl|vision/.test(id);
  if (isGrokProvider(provider, baseUrl)) return true;
  if (provider === "openai" || hostMatches(baseUrl, "api.openai.com")) {
    return /gpt-4o|gpt-4-vision|gpt-4-turbo|o[134]-/.test(id);
  }
  if (provider === "anthropic" || hostMatches(baseUrl, "api.anthropic.com")) {
    return /claude/.test(id);
  }
  if (provider === "google" || hostMatches(baseUrl, "generativelanguage.googleapis.com")) {
    return /gemini/.test(id);
  }
  return false;
}

/**
 * Providers known to serve DeepSeek models that leak DSML tool-call envelopes
 * into visible `content`. Used by {@link detectStreamMarkupHealingPattern} to
 * gate the DSML healer — only enable it where the leak has been observed.
 */
const DSML_HEALING_PROVIDERS = new Set([
  "ollama",
  "ollama-cloud",
  "nvidia",
  "deepseek",
  "fireworks",
  "nanogpt",
  "opencode-go",
  "openrouter",
]);

/**
 * Detect the leaked-markup healing pattern for a provider + model.
 *
 * - Kimi-K2 (any provider): `"kimi"` — strips `<|tool_call_begin|>` tokens.
 * - DeepSeek on a DSML-leaking provider: `"dsml"` — strips fullwidth DSML envelopes.
 * - Qwen on a leaking provider: `"qwen"` — strips `<tool_calls>` XML blocks.
 * - Otherwise: `undefined` — no healing (the existing think-tags filter +
 *   dialect hold-window in server.ts handle generic thinking extraction and
 *   post-hoc dialect rescue).
 *
 * Only providers that have been observed to leak structured tool-call markup
 * into `content` get a pattern; the generic thinking-tag case is already
 * covered by `ThinkTagStreamFilter` and the dialect hold-window, so returning
 * `undefined` here preserves the existing behavior for the majority of models.
 */
function detectStreamMarkupHealingPattern(
  provider: string,
  modelId: string,
): StreamMarkupHealingPattern | undefined {
  if (provider === "kimi-code" || provider === "moonshot" || /kimi[-/_.]?k2/i.test(modelId)) {
    return "kimi";
  }
  if (isDeepseekModelId(modelId) && DSML_HEALING_PROVIDERS.has(provider)) {
    return "dsml";
  }
  return undefined;
}

/**
 * Resolve the full compat record for a provider. Detection mirrors oh-my-pi's
 * `buildOpenAICompat`: provider name takes precedence over URL-based
 * heuristics, which take precedence over model-id heuristics. Callers may
 * override individual flags via the `overrides` argument (wired through from
 * `providerConfigSchema.compat`).
 */
export function resolveCompat(
  providerName: string,
  baseUrl: string,
  modelId: string,
  overrides?: Partial<ProviderCompat>,
): ProviderCompat {
  const provider = providerName.toLowerCase();
  const modelIdLower = (modelId ?? "").toLowerCase();
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const isKimi = isKimiModelId(modelIdLower);
  const isDirectDeepseekReasoning =
    isDeepseekModelId(modelIdLower) &&
    (provider === "deepseek" || hostMatches(base, "api.deepseek.com"));
  const compat: ProviderCompat = {
    supportsReasoningEffort: detectSupportsReasoningEffort(provider, base, modelIdLower),
    thinkingFormat: detectThinkingFormat(provider, base, modelIdLower),
    reasoningContentField: "reasoning_content",
    requiresAssistantContentForToolCalls: isKimi || isDirectDeepseekReasoning,
    supportsMultipleSystemMessages: detectSupportsMultipleSystemMessages(provider, base, modelIdLower),
    maxTokensField: detectMaxTokensField(provider, base, modelIdLower),
    streamIdleTimeoutMs: detectStreamIdleTimeoutMs(provider, base, modelIdLower),
    stripDeepseekSpecialTokens:
      isDeepseekModelId(modelIdLower) &&
      (provider === "nvidia" || provider === "deepseek"),
    supportsImages: detectSupportsImages(provider, base, modelIdLower),
    streamMarkupHealingPattern: detectStreamMarkupHealingPattern(provider, modelIdLower),
  };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        (compat as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return compat;
}

/**
 * Apply compat flags to an OpenAI chat request in place.
 *
 * - Coalesces leading system messages into one when
 *   `supportsMultipleSystemMessages` is false.
 * - Renames `max_tokens` to `max_completion_tokens` (or vice versa) to match
 *   the provider's expected field.
 * - Adds `"."` content to assistant tool-call turns that have empty content
 *   when `requiresAssistantContentForToolCalls` is true.
 */
export function applyCompatToRequest(
  openaiBody: OpenAIChatRequest,
  compat: ProviderCompat,
  modelId?: string,
  providerName?: string,
  baseUrl?: string,
): OpenAIChatRequest {
  const messages = openaiBody.messages;

  if (!compat.supportsMultipleSystemMessages) {
    const systemIndices: number[] = [];
    let firstNonSystem = messages.length;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") {
        systemIndices.push(i);
      } else {
        firstNonSystem = i;
        break;
      }
    }
    if (systemIndices.length > 1) {
      const coalesced = messages
        .slice(0, firstNonSystem)
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter((s) => s.length > 0)
        .join("\n\n");
      const replacement: OpenAIMessage = {
        role: "system",
        content: coalesced,
      };
      openaiBody.messages = [replacement, ...messages.slice(firstNonSystem)];
    }
  }

  if (compat.requiresAssistantContentForToolCalls) {
    for (const msg of openaiBody.messages) {
      if (msg.role !== "assistant") continue;
      if (!msg.tool_calls || msg.tool_calls.length === 0) continue;
      const hasContent =
        msg.content !== null &&
        msg.content !== undefined &&
        (typeof msg.content === "string"
          ? msg.content.length > 0
          : msg.content.length > 0);
      if (!hasContent) {
        msg.content = ".";
      }
    }
  }

  // Re-check vision support with the actual model id, not just the
  // provider-level compat (which was resolved with the default model).
  const supportsImages = modelId && providerName && baseUrl
    ? detectSupportsImages(providerName, baseUrl, modelId) || compat.supportsImages
    : compat.supportsImages;

  if (!supportsImages) {
    for (const msg of openaiBody.messages) {
      if (Array.isArray(msg.content)) {
        msg.content = stripImagesForNonVisionModel(msg.content, false);
      }
    }
  }

  const desired = compat.maxTokensField;
  const hasMaxTokens = openaiBody.max_tokens !== undefined;
  const hasMaxCompletion =
    (openaiBody as unknown as { max_completion_tokens?: number })
      .max_completion_tokens !== undefined;
  if (desired === "max_completion_tokens" && hasMaxTokens) {
    (openaiBody as unknown as { max_completion_tokens?: number }).max_completion_tokens =
      openaiBody.max_tokens;
    delete openaiBody.max_tokens;
  } else if (desired === "max_tokens" && hasMaxCompletion) {
    openaiBody.max_tokens = (openaiBody as unknown as { max_completion_tokens?: number })
      .max_completion_tokens;
    delete (openaiBody as unknown as { max_completion_tokens?: number }).max_completion_tokens;
  }

  return openaiBody;
}
