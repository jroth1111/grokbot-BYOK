/**
 * "Sign in with ChatGPT" OAuth support (the same flow the Codex CLI uses).
 *
 * grokbot-BYOK normally authenticates upstream providers with static API
 * keys. ChatGPT subscribers instead can log in with their OpenAI account:
 * an OAuth 2.0 Authorization Code + PKCE flow against auth.openai.com
 * yields a short-lived access token (JWT) plus a rotating refresh token,
 * and inference calls go to the Responses API endpoint hosted on
 * chatgpt.com/backend-api/codex (see translate/responses-api.ts for the
 * wire-format translation).
 *
 * Endpoints and the public client id mirror the open-source Codex CLI
 * (github.com/openai/codex, codex-rs/login) so any ChatGPT plan that works
 * with Codex works here too. Multiple accounts are supported: the login
 * CLI appends each signed-in account to a local token-store file, and the
 * provider rotates across accounts exactly like it rotates API keys.
 *
 * The generic machinery (token store, single-flight refresh manager,
 * loopback callback server) lives in oauth-core.ts; this module only
 * carries the ChatGPT specifics.
 *
 * NOTE: this path is officially intended for OpenAI's own clients; routing
 * a third-party tool through it sits in a gray area of the OpenAI ToS and
 * may carry account-risk. Use with your own informed judgment.
 */
import {
  OAuthAccountMismatchError,
  OAuthError,
  OAuthTokenManagerBase,
  OAuthTokenStore,
  generatePkcePair,
  generateStateToken,
  maskSecret,
  type OAuthAccount,
  type OAuthLogger,
  type RefreshOutcome,
} from "./oauth-core.js";

export { maskSecret, OAuthError };
export type { OAuthLogger };

// ---------------------------------------------------------------------------
// Endpoints & constants (mirror codex-rs/login)
// ---------------------------------------------------------------------------

/** Public OAuth client id used by the Codex CLI ("Sign in with ChatGPT"). */
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** OAuth issuer base. */
export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";

/** Authorization endpoint (browser-facing). */
export const CHATGPT_OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;

/** Token endpoint (code exchange + refresh, form-encoded POST). */
export const CHATGPT_OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;

/** Revocation endpoint (best-effort logout). */
export const CHATGPT_OAUTH_REVOKE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/revoke`;

/**
 * Loopback redirect URI. auth.openai.com only accepts redirect URIs
 * registered to the Codex client id, so the port is fixed at 1455 —
 * exactly like the Codex CLI's local callback server.
 */
export const CHATGPT_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

/** Fixed loopback port (must match CHATGPT_OAUTH_REDIRECT_URI). */
export const CHATGPT_OAUTH_CALLBACK_PORT = 1455;

/** OAuth scopes: offline_access is what yields a refresh token. */
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access";

/** Default token-store path, relative to the process cwd (like the config). */
export const DEFAULT_CHATGPT_TOKEN_FILE = "config/chatgpt-tokens.json";

/** Configurable endpoints (tests point these at a local mock). */
export interface ChatGptOAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
}

export function defaultEndpoints(): ChatGptOAuthEndpoints {
  return {
    authorizeUrl: CHATGPT_OAUTH_AUTHORIZE_URL,
    tokenUrl: CHATGPT_OAUTH_TOKEN_URL,
    revokeUrl: CHATGPT_OAUTH_REVOKE_URL,
  };
}

// ---------------------------------------------------------------------------
// PKCE (re-exported from the shared core under the historical names)
// ---------------------------------------------------------------------------

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generate a PKCE pair (S256). */
export function generatePkce(): PkcePair {
  return generatePkcePair();
}

/** Random URL-safe state parameter. */
export function generateState(): string {
  return generateStateToken();
}

/** Build the browser-facing authorize URL (Authorization Code + PKCE S256). */
export function buildAuthorizeUrl(opts: {
  codeChallenge: string;
  state: string;
  endpoints?: Partial<ChatGptOAuthEndpoints>;
  /** Force the account chooser even when already signed in (default true — friendly for adding multiple accounts). */
  promptLogin?: boolean;
}): string {
  const url = new URL(
    opts.endpoints?.authorizeUrl ?? CHATGPT_OAUTH_AUTHORIZE_URL,
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CHATGPT_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", CHATGPT_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.promptLogin !== false) {
    url.searchParams.set("prompt", "login");
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// JWT parsing (claims only — the token came from the token endpoint over
// TLS, we only need to read its payload, not verify a signature)
// ---------------------------------------------------------------------------

/** The `https://api.openai.com/auth` claim embedded in OpenAI-issued JWTs. */
export interface ChatGptAuthClaim {
  accountId?: string;
  userId?: string;
  plan?: string;
}

/** Decode a JWT's payload segment into a plain object (no verification). */
export function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Extract the ChatGPT identity claim + expiry from an access/id token. */
export function extractChatgptAuthClaim(
  token: string,
): ChatGptAuthClaim & { expiresAtMs?: number; email?: string } {
  const claims = parseJwtClaims(token) ?? {};
  const auth = claims["https://api.openai.com/auth"];
  const out: ChatGptAuthClaim & { expiresAtMs?: number; email?: string } = {};
  if (auth !== null && typeof auth === "object") {
    const a = auth as Record<string, unknown>;
    if (typeof a.chatgpt_account_id === "string") out.accountId = a.chatgpt_account_id;
    if (typeof a.user_id === "string") out.userId = a.user_id;
    // Current tokens carry `chatgpt_plan_type` (free/plus/pro/…); keep the
    // legacy `chatgpt_plan` spelling as a fallback.
    if (typeof a.chatgpt_plan_type === "string") out.plan = a.chatgpt_plan_type;
    else if (typeof a.chatgpt_plan === "string") out.plan = a.chatgpt_plan;
  }
  if (typeof claims.email === "string") out.email = claims.email;
  if (typeof claims.exp === "number") out.expiresAtMs = claims.exp * 1000;
  return out;
}

// ---------------------------------------------------------------------------
// Accounts & token store
// ---------------------------------------------------------------------------

/** One signed-in ChatGPT account and its OAuth tokens. */
export interface ChatGptAccount extends OAuthAccount {
  /** chatgpt_account_id from the access-token JWT (also the routing key id). */
  accountId: string;
  /** ChatGPT plan (free/plus/pro/...), if the token claims expose it. */
  plan?: string;
  idToken?: string;
}

/**
 * Fill in email/plan/expiry from the stored access token's claims when the
 * persisted entry lacks them (e.g. tokens written before plan capture was
 * added, or hand-migrated stores). Per-field fallback — never overrides
 * values already present.
 */
function hydrateAccountFromToken(account: ChatGptAccount): ChatGptAccount {
  try {
    const claims = extractChatgptAuthClaim(account.accessToken);
    return {
      ...account,
      email: account.email ?? claims.email,
      plan: account.plan ?? claims.plan,
      expiresAtMs: account.expiresAtMs > 0 ? account.expiresAtMs : claims.expiresAtMs ?? 0,
    };
  } catch {
    return account;
  }
}

/** ChatGPT token store (same file format as the generic store + claim hydration). */
export class ChatGptTokenStore extends OAuthTokenStore {
  constructor(filePath: string) {
    super(filePath, hydrateAccountFromToken);
  }

  load(): ChatGptAccount[] {
    return super.load() as ChatGptAccount[];
  }
}

// ---------------------------------------------------------------------------
// OAuth HTTP helpers (token exchange / refresh / revoke)
// ---------------------------------------------------------------------------

/** Raw token-endpoint response (subset of fields we consume). */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; bodyText: string }> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
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

function parseTokenResponse(
  status: number,
  bodyText: string,
  what: string,
): OAuthTokenResponse {
  if (status < 200 || status >= 300) {
    let errorKind = "";
    try {
      errorKind = String(JSON.parse(bodyText)?.error ?? "");
    } catch {
      // non-JSON error body
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
    const parsed = JSON.parse(bodyText) as OAuthTokenResponse;
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

/** Exchange an authorization code (from the loopback callback) for tokens. */
export async function exchangeAuthorizationCode(opts: {
  code: string;
  codeVerifier: string;
  tokenUrl?: string;
}): Promise<OAuthTokenResponse> {
  const { status, bodyText } = await postForm(opts.tokenUrl ?? CHATGPT_OAUTH_TOKEN_URL, {
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
  });
  return parseTokenResponse(status, bodyText, "code exchange");
}

/** Refresh an access token with a refresh token (rotates the refresh token). */
export async function refreshAccessToken(opts: {
  refreshToken: string;
  tokenUrl?: string;
}): Promise<OAuthTokenResponse> {
  const { status, bodyText } = await postForm(opts.tokenUrl ?? CHATGPT_OAUTH_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    scope: CHATGPT_OAUTH_SCOPE,
  });
  return parseTokenResponse(status, bodyText, "token refresh");
}

/** Best-effort revocation of a refresh token (logout). Never throws. */
export async function revokeRefreshToken(opts: {
  refreshToken: string;
  revokeUrl?: string;
}): Promise<boolean> {
  try {
    const { status } = await postForm(opts.revokeUrl ?? CHATGPT_OAUTH_REVOKE_URL, {
      token: opts.refreshToken,
      client_id: CHATGPT_OAUTH_CLIENT_ID,
    });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token manager (chatgpt specifics on the generic skeleton)
// ---------------------------------------------------------------------------

export interface ChatGptTokenManagerOptions {
  tokenFile: string;
  endpoints?: Partial<ChatGptOAuthEndpoints>;
  now?: () => number;
  logger?: OAuthLogger;
}

/**
 * Keeps every signed-in ChatGPT account's access token fresh and hands the
 * current credential to the fetch layer, mirroring how static API keys work
 * elsewhere: one account == one `KeyInfo` whose `value` is the account id.
 */
export class ChatGptTokenManager extends OAuthTokenManagerBase<ChatGptAccount> {
  private readonly endpoints: ChatGptOAuthEndpoints;

  constructor(opts: ChatGptTokenManagerOptions) {
    super({
      tokenFile: opts.tokenFile,
      now: opts.now,
      logger: opts.logger,
      hydrate: hydrateAccountFromToken,
    });
    this.endpoints = { ...defaultEndpoints(), ...opts.endpoints };
  }

  protected get providerLabel(): string {
    return "chatgpt";
  }

  protected async doRefresh(account: ChatGptAccount): Promise<RefreshOutcome> {
    const tokens = await refreshAccessToken({
      refreshToken: account.refreshToken,
      tokenUrl: this.endpoints.tokenUrl,
    });
    const claims = extractChatgptAuthClaim(tokens.access_token);
    // The refreshed token must still belong to the same ChatGPT account —
    // a mismatch means the user re-logged-in elsewhere on this slot.
    if (claims.accountId && claims.accountId !== account.accountId) {
      throw new OAuthAccountMismatchError(
        `refreshed token belongs to ${maskSecret(claims.accountId)}, not ${maskSecret(account.accountId)}`,
      );
    }
    const expiresAtMs =
      claims.expiresAtMs ??
      (tokens.expires_in && tokens.expires_in > 0
        ? this.now() + tokens.expires_in * 1000
        : this.now() + 60 * 60 * 1000);
    return {
      accessToken: tokens.access_token,
      // Refresh tokens rotate on every use; keep the old one only when the
      // endpoint did not issue a replacement.
      refreshToken: tokens.refresh_token ?? account.refreshToken,
      expiresAtMs,
      accountPatch: {
        idToken: tokens.id_token ?? account.idToken,
        email: account.email ?? claims.email,
        plan: account.plan ?? claims.plan,
      },
    };
  }

  /** Upstream headers: Bearer + ChatGPT account routing + responses beta. */
  override async buildUpstreamHeaders(
    accountId: string,
  ): Promise<Record<string, string>> {
    const { accessToken, accountId: id } = await this.getValidAccessToken(accountId);
    return {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": id,
      "OpenAI-Beta": "responses=v1",
    };
  }
}
