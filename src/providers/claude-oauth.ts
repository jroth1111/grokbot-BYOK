/**
 * Anthropic Claude subscription OAuth (the same flow Claude Code uses).
 *
 * A Claude Pro/Max subscriber logs in with their Anthropic account: an
 * OAuth 2.0 Authorization Code + PKCE flow against claude.ai yields an
 * access token (≈8h) plus a long-lived refresh token, and inference calls
 * go to the Anthropic Messages API at api.anthropic.com/v1/messages (see
 * translate/anthropic-messages.ts for the wire translation).
 *
 * Endpoint constants and wire quirks mirror the reference open-source
 * clients (CLIProxyAPI's internal Claude auth, which reproduces native
 * Claude Code traffic): the code exchange posts a JSON body whose FIELD
 * ORDER matters, OAuth control-plane requests wear an axios-shaped header
 * set to pass Anthropic's Cloudflare, and refreshed tokens may come back
 * without a new refresh_token (the old one stays valid).
 *
 * NOTE: this path is officially intended for Anthropic's own clients; use
 * with your own informed judgment re: ToS and account risk.
 */
import {
  OAuthError,
  OAuthTokenManagerBase,
  generatePkcePair,
  generateStateToken,
  type OAuthAccount,
  type OAuthLogger,
  type RefreshOutcome,
} from "./oauth-core.js";

// ---------------------------------------------------------------------------
// Endpoints & constants
// ---------------------------------------------------------------------------

/** Authorization endpoint (browser-facing). */
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";

/**
 * Token endpoint (code exchange + refresh). Native Claude Code posts the
 * code exchange to platform.claude.com, not api.anthropic.com.
 */
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/** Account profile endpoint (identity enrichment after login/refresh). */
export const CLAUDE_OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/** Public OAuth client id used by Claude Code. */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Loopback redirect URI (fixed port, matching the native client). */
export const CLAUDE_OAUTH_REDIRECT_URI = "http://localhost:54545/callback";

/** Fixed loopback callback port. */
export const CLAUDE_OAUTH_CALLBACK_PORT = 54545;

/** Scopes requested at authorization time (includes Console key creation). */
export const CLAUDE_OAUTH_AUTHORIZE_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/** Scopes used for refresh grants (no org:create_api_key). */
export const CLAUDE_OAUTH_REFRESH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/** Anthropic Messages API base (inference). */
export const CLAUDE_API_BASE = "https://api.anthropic.com";

/** Default token-store path. */
export const DEFAULT_CLAUDE_TOKEN_FILE = "config/oauth/claude-tokens.json";

/**
 * Candidate models probed (cheapest-first) after login to build the
 * account's usable catalog; the first probe that succeeds becomes the
 * suggested default. Ordered newest-small → newest-large.
 */
export const CLAUDE_CANDIDATE_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20251101",
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest",
];

/** Configurable endpoints (tests point these at a local mock). */
export interface ClaudeOAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  /** Anthropic Messages API base for probes and upstream calls. */
  apiBase: string;
}

export function defaultClaudeEndpoints(): ClaudeOAuthEndpoints {
  return {
    authorizeUrl: CLAUDE_OAUTH_AUTHORIZE_URL,
    tokenUrl: CLAUDE_OAUTH_TOKEN_URL,
    profileUrl: CLAUDE_OAUTH_PROFILE_URL,
    apiBase: CLAUDE_API_BASE,
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** One signed-in Claude account and its OAuth tokens. */
export interface ClaudeAccount extends OAuthAccount {
  accountId: string;
  /** Organization uuid from the token/profile response. */
  organizationUuid?: string;
  organizationName?: string;
}

// ---------------------------------------------------------------------------
// Wire helpers (axios-shaped headers; JSON bodies with stable field order)
// ---------------------------------------------------------------------------

/**
 * Header set the OAuth control plane wears. Native Claude Code ships an
 * axios client; Anthropic's Cloudflare heuristics key off that shape, so
 * requests match it (Accept/UA/Connection). Accept-Encoding is left to the
 * HTTP stack so decompression stays automatic.
 */
function axiosHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "User-Agent": "axios/1.15.2",
    Connection: "close",
  };
}

async function postJson(
  url: string,
  body: string,
): Promise<{ status: number; bodyText: string }> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: axiosHeaders(),
      body,
    });
  } catch (err) {
    throw new OAuthError(
      "network",
      `oauth request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const bodyText = await resp.text().catch(() => "");
  return { status: resp.status, bodyText };
}

/** Token-endpoint response shape. */
export interface ClaudeTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  organization?: { uuid?: string; name?: string };
  account?: { uuid?: string; email_address?: string };
}

function parseClaudeTokenResponse(
  status: number,
  bodyText: string,
  what: string,
): ClaudeTokenResponse {
  if (status < 200 || status >= 300) {
    let errorKind = "";
    try {
      errorKind = String(JSON.parse(bodyText)?.error ?? "");
    } catch {
      // non-JSON body
    }
    if (errorKind === "invalid_grant") {
      throw new OAuthError(
        "invalid_grant",
        `${what}: refresh token no longer valid — run the login flow again`,
        status,
      );
    }
    throw new OAuthError(
      "http",
      `${what}: unexpected status ${status}: ${bodyText.slice(0, 200)}`,
      status,
    );
  }
  try {
    const parsed = JSON.parse(bodyText) as ClaudeTokenResponse;
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw new Error("missing access_token");
    }
    return parsed;
  } catch (err) {
    throw new OAuthError(
      "http",
      `${what}: malformed token response (${err instanceof Error ? err.message : String(err)})`,
      status,
    );
  }
}

// ---------------------------------------------------------------------------
// Login flow pieces (used by the login CLI)
// ---------------------------------------------------------------------------

export function buildClaudeAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
  endpoints?: Partial<ClaudeOAuthEndpoints>;
}): string {
  const url = new URL(opts.endpoints?.authorizeUrl ?? CLAUDE_OAUTH_AUTHORIZE_URL);
  // NOTE: parameter ORDER mirrors the native client (code first).
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_OAUTH_AUTHORIZE_SCOPE);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

/**
 * Split a callback code that may carry a "#state" fragment appended by the
 * authorization server (observed on native Claude Code flows).
 */
export function parseClaudeCallbackCode(code: string): { code: string; state?: string } {
  const splits = code.split("#");
  return { code: splits[0], state: splits.length > 1 ? splits[1] : undefined };
}

/**
 * Exchange the authorization code for tokens. The request body's FIELD
 * ORDER is significant (it reproduces native Claude Code traffic), so the
 * JSON is built manually instead of via object serialization.
 */
export async function exchangeClaudeCode(opts: {
  code: string;
  state: string;
  codeVerifier: string;
  endpoints?: Partial<ClaudeOAuthEndpoints>;
}): Promise<ClaudeTokenResponse> {
  const tokenUrl = opts.endpoints?.tokenUrl ?? CLAUDE_OAUTH_TOKEN_URL;
  const body =
    `{"grant_type":"authorization_code"` +
    `,"code":${JSON.stringify(opts.code)}` +
    `,"redirect_uri":${JSON.stringify(CLAUDE_OAUTH_REDIRECT_URI)}` +
    `,"client_id":${JSON.stringify(CLAUDE_OAUTH_CLIENT_ID)}` +
    `,"code_verifier":${JSON.stringify(opts.codeVerifier)}` +
    `,"state":${JSON.stringify(opts.state)}}`;
  const { status, bodyText } = await postJson(tokenUrl, body);
  return parseClaudeTokenResponse(status, bodyText, "code exchange");
}

/** Account identity from the profile endpoint (advisory enrichment). */
export async function fetchClaudeProfile(opts: {
  accessToken: string;
  endpoints?: Partial<ClaudeOAuthEndpoints>;
}): Promise<{ accountUuid?: string; email?: string; organizationUuid?: string; organizationName?: string } | null> {
  const url = opts.endpoints?.profileUrl ?? CLAUDE_OAUTH_PROFILE_URL;
  try {
    const resp = await fetch(url, {
      headers: {
        ...axiosHeaders(),
        Authorization: `Bearer ${opts.accessToken}`,
        "Cache-Control": "no-cache",
      },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      account?: { uuid?: string; email?: string };
      organization?: { uuid?: string; name?: string };
    };
    return {
      accountUuid: data.account?.uuid,
      email: data.account?.email,
      organizationUuid: data.organization?.uuid,
      organizationName: data.organization?.name,
    };
  } catch {
    return null;
  }
}

/** Refresh grant (alphabetical field order, matching the reference client). */
export async function refreshClaudeToken(opts: {
  refreshToken: string;
  endpoints?: Partial<ClaudeOAuthEndpoints>;
}): Promise<ClaudeTokenResponse> {
  const tokenUrl = opts.endpoints?.tokenUrl ?? CLAUDE_OAUTH_TOKEN_URL;
  const body = JSON.stringify({
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    scope: CLAUDE_OAUTH_REFRESH_SCOPE,
  });
  const { status, bodyText } = await postJson(tokenUrl, body);
  return parseClaudeTokenResponse(status, bodyText, "token refresh");
}

// ---------------------------------------------------------------------------
// Model probing (build the account's usable catalog after login)
// ---------------------------------------------------------------------------

export interface ClaudeModelProbe {
  model: string;
  ok: boolean;
  status?: number;
  detail?: string;
}

/**
 * Probe candidate models with 1-token requests to discover which this
 * account may actually use (entitlements vary by plan). Stops at the first
 * success by default — that model becomes the suggested default.
 */
export async function probeClaudeModels(opts: {
  accessToken: string;
  models?: string[];
  firstHitOnly?: boolean;
  endpoints?: Partial<ClaudeOAuthEndpoints>;
}): Promise<ClaudeModelProbe[]> {
  const apiBase = (opts.endpoints?.apiBase ?? CLAUDE_API_BASE).replace(/\/+$/, "");
  const results: ClaudeModelProbe[] = [];
  for (const model of opts.models ?? CLAUDE_CANDIDATE_MODELS) {
    try {
      const resp = await fetch(`${apiBase}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.accessToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const ok = resp.ok;
      let detail = "";
      if (!ok) {
        detail = (await resp.text()).slice(0, 120);
      }
      results.push({ model, ok, status: resp.status, detail });
      if (ok && opts.firstHitOnly !== false) break;
    } catch (err) {
      results.push({
        model,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Token manager
// ---------------------------------------------------------------------------

export interface ClaudeTokenManagerOptions {
  tokenFile: string;
  endpoints?: Partial<ClaudeOAuthEndpoints>;
  now?: () => number;
  logger?: OAuthLogger;
}

/** Claude specifics on the generic OAuth skeleton. */
export class ClaudeTokenManager extends OAuthTokenManagerBase<ClaudeAccount> {
  private readonly endpoints: ClaudeOAuthEndpoints;

  constructor(opts: ClaudeTokenManagerOptions) {
    super({ tokenFile: opts.tokenFile, now: opts.now, logger: opts.logger });
    this.endpoints = { ...defaultClaudeEndpoints(), ...opts.endpoints };
  }

  protected get providerLabel(): string {
    return "claude";
  }

  protected async doRefresh(account: ClaudeAccount): Promise<RefreshOutcome> {
    const tokens = await refreshClaudeToken({
      refreshToken: account.refreshToken,
      endpoints: this.endpoints,
    });
    const expiresAtMs =
      tokens.expires_in && tokens.expires_in > 0
        ? this.now() + tokens.expires_in * 1000
        : this.now() + 8 * 60 * 60 * 1000;
    const patch: Record<string, unknown> = {};
    if (tokens.account?.email_address) patch.email = tokens.account.email_address;
    if (tokens.organization?.uuid) patch.organizationUuid = tokens.organization.uuid;
    if (tokens.organization?.name) patch.organizationName = tokens.organization.name;
    return {
      accessToken: tokens.access_token,
      // Anthropic may not rotate the refresh token on every grant; keep the
      // old one when no replacement was issued.
      refreshToken: tokens.refresh_token ?? account.refreshToken,
      expiresAtMs,
      accountPatch: patch,
    };
  }

  /** Upstream headers: Bearer + Anthropic version + OAuth beta flags. */
  override async buildUpstreamHeaders(
    accountId: string,
  ): Promise<Record<string, string>> {
    const { accessToken } = await this.getValidAccessToken(accountId);
    return {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    };
  }
}

/** PKCE/state re-exports under provider-neutral names for the login CLI. */
export function claudePkce(): { codeVerifier: string; codeChallenge: string; state: string } {
  const pkce = generatePkcePair();
  return { ...pkce, state: generateStateToken() };
}
