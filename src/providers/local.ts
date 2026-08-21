/**
 * Factory for the local provider.
 *
 * A thin wrapper around BaseProvider that pins the provider name to
 * "local". The alias map, base URL, API key, and default model all come
 * from the supplied ProviderConfig.
 */
import type { Provider, ProviderConfig } from "../types.js";
import { BaseProvider } from "./base.js";

export function createLocalProvider(config: ProviderConfig): Provider {
  return new BaseProvider("local", config);
}
