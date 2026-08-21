/**
 * Factory for the OpenCode Go provider.
 *
 * A thin wrapper around BaseProvider that pins the provider name to
 * "opencode-go". The alias map, base URL, API key, and default model all
 * come from the supplied ProviderConfig.
 */
import type { Provider, ProviderConfig } from "../types.js";
import { BaseProvider } from "./base.js";

export function createOpencodeGoProvider(config: ProviderConfig): Provider {
  return new BaseProvider("opencode-go", config);
}
