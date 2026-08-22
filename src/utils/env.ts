/**
 * Shared .env file loader.
 *
 * Sources a `.env` file into `process.env` (KEY=VALUE lines, # comments).
 * Does NOT override already-set env vars (caller's env wins).
 *
 * Skipped in tests (NODE_ENV=test) to prevent the project's real .env from
 * leaking into test env state.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function sourceEnvFile(cwd: string = process.cwd()): void {
  if (process.env.NODE_ENV === "test") return;
  const file = path.resolve(cwd, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * Read the Devin CLI session token from ~/.local/share/devin/credentials.toml.
 *
 * The Devin CLI refreshes this JWT periodically, so reading it at startup
 * (rather than keeping a static copy in .env) ensures we always have a
 * valid token. Returns undefined if the file is missing or has no
 * windsurf_api_key field.
 *
 * @param credentialsPath Optional override path to the credentials file.
 *                        Defaults to ~/.local/share/devin/credentials.toml.
 */
export function readDevinSessionToken(credentialsPath?: string): string | undefined {
  const file =
    credentialsPath ??
    path.resolve(
      process.env.HOME ?? process.env.USERPROFILE ?? "~",
      ".local/share/devin/credentials.toml",
    );
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  // Simple TOML parse: look for windsurf_api_key = "..."
  const match = text.match(/^windsurf_api_key\s*=\s*"([^"]+)"/m);
  return match?.[1];
}
