/**
 * Provider compat flag system.
 *
 * Ports the auto-detection logic from oh-my-pi's
 * `packages/catalog/src/compat/openai.ts`. `resolveCompat` inspects the
 * provider name, base URL, and model id to produce a `ProviderCompat` record
 * that the request translator consumes via `applyCompatToRequest`.
 */
import type { OpenAIChatRequest, OpenAIMessage } from "../types.js";

export type ThinkingFormat =
  | "openai"
  | "zai"
  | "qwen"
  | "qwen-chat-template"
  | "openrouter";

export type StreamMarkupHealingPattern =
  | "kimi"
  | "dsml"
  | "thinking"
  | undefined;

export interface ProviderCompat {
  supportsReasoningEffort: boolean;
  thinkingFormat: ThinkingFormat;
  reasoningContentField: string;
  requiresAssistantContentForToolCalls: boolean;
  supportsMultipleSystemMessages: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  streamIdleTimeoutMs: number;
  stripDeepseekSpecialTokens: boolean;
  streamMarkupHealingPattern: StreamMarkupHealingPattern;
}

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
const KIMI_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS = 300_000;

const GLM_CODING_PLAN_MODEL_PATTERN = /(^|\/)glm-5(?:[.-]|$)/i;

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

function hostMatches(baseUrl: string, hostname: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === hostname;
  } catch {
    return false;
  }
}

function isOfficialOpenAIEndpoint(provider: string, baseUrl: string): boolean {
  if (provider !== "openai") return false;
  if (!baseUrl) return true;
  return hostMatches(baseUrl, "api.openai.com");
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

function detectStreamMarkupHealingPattern(
  provider: string,
  modelId: string,
  baseUrl: string,
): StreamMarkupHealingPattern {
  if (provider === "kimi-code" || provider === "moonshot" || /kimi[-/_.]?k2/i.test(modelId)) {
    return "kimi";
  }
  if (isDeepseekModelId(modelId) && DSML_HEALING_PROVIDERS.has(provider)) {
    return "dsml";
  }
  if (isOfficialOpenAIEndpoint(provider, baseUrl)) return undefined;
  return "thinking";
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

/**
 * Resolve provider compat flags from the provider name, base URL, and model id.
 *
 * Detection mirrors oh-my-pi's `buildOpenAICompat`: provider name takes
 * precedence over URL-based heuristics, which take precedence over model-id
 * heuristics. Callers may override individual flags via the `overrides`
 * argument (wired through from `providerConfigSchema.compat`).
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
    streamMarkupHealingPattern: detectStreamMarkupHealingPattern(provider, modelIdLower, base),
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
