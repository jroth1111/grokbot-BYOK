/**
 * Factory for the OpenCode Zen provider.
 *
 * A thin wrapper around BaseProvider that pins the provider name to
 * "opencode-zen". The alias map, base URL, API key, and default model all
 * come from the supplied ProviderConfig.
 */
import type { Provider, ProviderConfig } from "../types.js";
import { BaseProvider } from "./base.js";
import { providerConfigSchema } from "../config/schema.js";

export function createOpencodeZenProvider(config: ProviderConfig): Provider {
  // Validate the raw config up front so a misconfigured provider fails fast
  // with a clear error instead of producing a silently-broken adapter that
  // only errors on the first request (e.g. empty baseUrl / defaultModel).
  const validated = providerConfigSchema.parse(config) as ProviderConfig;
  return new BaseProvider("opencode-zen", validated);
}
