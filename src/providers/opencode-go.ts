/**
 * Factory for the OpenCode Go provider.
 *
 * A thin wrapper around BaseProvider that pins the provider name to
 * "opencode-go". The alias map, base URL, API key, and default model all
 * come from the supplied ProviderConfig.
 */
import type { Provider, ProviderConfig } from "../types.js";
import { BaseProvider } from "./base.js";
import { providerConfigSchema } from "../config/schema.js";

export function createOpencodeGoProvider(config: ProviderConfig): Provider {
  // Validate the raw config up front so a misconfigured provider fails fast
  // with a clear error instead of producing a silently-broken adapter that
  // only errors on the first request (e.g. empty baseUrl / defaultModel).
  const validated = providerConfigSchema.parse(config) as ProviderConfig;
  return new BaseProvider("opencode-go", validated);
}
