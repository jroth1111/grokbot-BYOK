/**
 * Factory for the OpenCode Zen provider.
 *
 * A thin wrapper around BaseProvider that pins the provider name to
 * "opencode-zen". The alias map, base URL, API key, and default model all
 * come from the supplied ProviderConfig.
 */
import type { Provider, ProviderConfig } from "../types.js";
import { BaseProvider } from "./base.js";

export function createOpencodeZenProvider(config: ProviderConfig): Provider {
  return new BaseProvider("opencode-zen", config);
}
