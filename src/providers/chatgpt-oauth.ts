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
 * NOTE: this path is officially intended for OpenAI's own clients; routing
 * a third-party tool through it sits in a gray area of the OpenAI ToS and
 * may carry account-risk. Use with your own informed judgment.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { KeyInfo } from "../types.js";

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

/** Refresh the access token when it expires within this window (ms). */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

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

/** Minimal logger surface the manager needs (avoids a hard dep on log.ts). */
export interface ChatGptLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generate a PKCE pair (S256). Verifier is 64 base64url chars (RFC 7636 allows 43-128). */
export function generatePkce(): PkcePair {
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Random URL-safe state parameter. */
export function generateState(): string {
  return crypto.randomBytes(24).toString("base64url");
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
// Token store (multi-account JSON file, 0600, atomic writes)
// ---------------------------------------------------------------------------

/** One signed-in ChatGPT account and its OAuth tokens. */
export interface ChatGptAccount {
  /** chatgpt_account_id from the access-token JWT (also the routing key id). */
  accountId: string;
  /** Email from the id-token claims, if available (display only). */
  email?: string;
  /** ChatGPT plan (plus/pro/...), if the token claims expose it. */
  plan?: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Access-token expiry (epoch ms). Refreshed before it lapses. */
  expiresAtMs: number;
  /** When the tokens were last obtained/refreshed (epoch ms). */
  obtainedAtMs: number;
  /** false after an invalid_grant — the account must re-login. */
  enabled: boolean;
  /** Rotation weight (1 = equal share across accounts). */
  weight?: number;
}

interface TokenFileShape {
  version: 1;
  accounts: ChatGptAccount[];
}

/** Mask a token/account id for logging. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

export class ChatGptTokenStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load all accounts; a missing/corrupt file yields an empty list. */
  load(): ChatGptAccount[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TokenFileShape>;
      if (!parsed || !Array.isArray(parsed.accounts)) return [];
      return parsed.accounts
        .filter(
          (a): a is ChatGptAccount =>
            !!a &&
            typeof a.accountId === "string" &&
            typeof a.refreshToken === "string" &&
            a.refreshToken.length > 0,
        )
        .map((a) => hydrateAccountFromToken(a));
    } catch {
      return [];
    }
  }

  /** Atomically persist the account list (write tmp + rename, mode 0600). */
  save(accounts: ChatGptAccount[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: TokenFileShape = { version: 1, accounts };
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", {
      mode: 0o600,
    });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // chmod is best-effort (e.g. some filesystems); the write mode above
      // already requested 0600.
    }
    fs.renameSync(tmp, this.filePath);
  }

  /** Insert or replace an account (keyed by accountId). */
  upsert(account: ChatGptAccount): void {
    const accounts = this.load().filter((a) => a.accountId !== account.accountId);
    accounts.push(account);
    this.save(accounts);
  }

  /** Remove an account by id. Returns true when it existed. */
  remove(accountId: string): boolean {
    const accounts = this.load();
    const next = accounts.filter((a) => a.accountId !== accountId);
    if (next.length === accounts.length) return false;
    this.save(next);
    return true;
  }
}

// ---------------------------------------------------------------------------
// OAuth HTTP helpers (token exchange / refresh / revoke)
// ---------------------------------------------------------------------------

/** A structured OAuth failure. `invalid_grant` means "re-login required". */
export class OAuthError extends Error {
  readonly kind: "invalid_grant" | "http" | "network";
  readonly status?: number;

  constructor(kind: OAuthError["kind"], message: string, status?: number) {
    super(message);
    this.name = "OAuthError";
    this.kind = kind;
    this.status = status;
  }
}

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
// Token manager (used by the shim at request time)
// ---------------------------------------------------------------------------

export interface ChatGptTokenManagerOptions {
  tokenFile: string;
  endpoints?: Partial<ChatGptOAuthEndpoints>;
  now?: () => number;
  logger?: ChatGptLogger;
}

/**
 * Keeps every signed-in ChatGPT account's access token fresh and hands the
 * current credential to the fetch layer, mirroring how static API keys work
 * elsewhere: one account == one `KeyInfo` whose `value` is the account id.
 *
 * Refreshes are single-flight per account (a burst of concurrent requests
 * triggers at most one token-endpoint call) and persist the rotating
 * refresh token atomically before the new access token is used.
 */
export class ChatGptTokenManager {
  private readonly store: ChatGptTokenStore;
  private readonly endpoints: ChatGptOAuthEndpoints;
  private readonly now: () => number;
  private readonly logger?: ChatGptLogger;
  private accounts: Map<string, ChatGptAccount> = new Map();
  /** In-flight refresh per account (single-flight). */
  private inflight: Map<string, Promise<boolean>> = new Map();

  constructor(opts: ChatGptTokenManagerOptions) {
    this.store = new ChatGptTokenStore(opts.tokenFile);
    this.endpoints = { ...defaultEndpoints(), ...opts.endpoints };
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger;
    for (const account of this.store.load()) {
      this.accounts.set(account.accountId, account);
    }
  }

  /**
   * True when an account can serve Codex-backend traffic. Plan is NOT a
   * gate: free-tier accounts work too — the backend serves them a different
   * model catalog (e.g. gpt-reserve / gpt-5.6 / gpt-6 families) and lower
   * quotas, and rejects unknown models itself. Only explicit disables
   * (invalid_grant / logout) remove an account from rotation.
   */
  private isUsable(account: ChatGptAccount): boolean {
    return account.enabled;
  }

  /** True when at least one usable account exists (routing eligibility). */
  hasEnabledAccount(): boolean {
    for (const account of this.accounts.values()) {
      if (this.isUsable(account)) return true;
    }
    return false;
  }

  /** All accounts (snapshot, display purposes). */
  getAccounts(): ChatGptAccount[] {
    return [...this.accounts.values()];
  }

  /**
   * KeyInfos for the provider's rotation machinery: one per enabled
   * account, `value` = account id (the actual token is resolved at
   * request time so it's always fresh).
   */
  getKeyInfos(): KeyInfo[] {
    const infos: KeyInfo[] = [];
    for (const account of this.accounts.values()) {
      if (!this.isUsable(account)) continue;
      infos.push({ value: account.accountId, weight: account.weight ?? 1, enabled: true });
    }
    return infos;
  }

  /**
   * Resolve a currently-valid access token for the account, refreshing it
   * first when it is about to expire (or already has).
   */
  async getValidAccessToken(
    accountId: string,
  ): Promise<{ accessToken: string; accountId: string }> {
    let account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`chatgpt oauth: unknown account ${maskSecret(accountId)}`);
    }
    if (!account.enabled) {
      throw new Error(
        `chatgpt oauth: account ${maskSecret(accountId)} disabled — run npm run chatgpt:login`,
      );
    }
    if (account.expiresAtMs - this.now() < REFRESH_MARGIN_MS) {
      await this.refreshAccount(accountId);
      account = this.accounts.get(accountId)!;
      if (!account.enabled) {
        throw new Error(
          `chatgpt oauth: account ${maskSecret(accountId)} could not be refreshed — re-login required`,
        );
      }
    }
    return { accessToken: account.accessToken, accountId };
  }

  /** Force a refresh regardless of expiry (e.g. after an upstream 401). */
  async forceRefresh(accountId: string): Promise<boolean> {
    return this.refreshAccount(accountId);
  }

  /**
   * Refresh every enabled account whose token expires within the margin.
   * Returns how many were refreshed. Intended for a periodic background
   * sweep so request-time refreshes are rare.
   */
  async refreshDueAccounts(): Promise<number> {
    let refreshed = 0;
    for (const [accountId, account] of this.accounts) {
      if (!this.isUsable(account)) continue;
      if (account.expiresAtMs - this.now() < 10 * 60 * 1000) {
        if (await this.refreshAccount(accountId)) refreshed++;
      }
    }
    return refreshed;
  }

  /** Single-flight wrapper around {@link doRefresh}. */
  private async refreshAccount(accountId: string): Promise<boolean> {
    const existing = this.inflight.get(accountId);
    if (existing) return existing;
    const promise = this.doRefresh(accountId).finally(() => {
      this.inflight.delete(accountId);
    });
    this.inflight.set(accountId, promise);
    return promise;
  }

  private async doRefresh(accountId: string): Promise<boolean> {
    const account = this.accounts.get(accountId);
    if (!account) return false;
    try {
      const tokens = await refreshAccessToken({
        refreshToken: account.refreshToken,
        tokenUrl: this.endpoints.tokenUrl,
      });
      const claims = extractChatgptAuthClaim(tokens.access_token);
      // The refreshed token must still belong to the same ChatGPT account —
      // a mismatch means the user re-logged-in elsewhere on this account
      // slot (Codex treats this as a hard error; we disable the entry).
      if (claims.accountId && claims.accountId !== accountId) {
        this.logger?.warn("chatgpt oauth: account mismatch after refresh, disabling", {
          account: maskSecret(accountId),
          tokenAccount: maskSecret(claims.accountId),
        });
        account.enabled = false;
        this.persist();
        return false;
      }
      const expiresAtMs =
        claims.expiresAtMs ??
        (tokens.expires_in && tokens.expires_in > 0
          ? this.now() + tokens.expires_in * 1000
          : this.now() + 60 * 60 * 1000);
      const next: ChatGptAccount = {
        ...account,
        accessToken: tokens.access_token,
        // Refresh tokens rotate on every use; keep the old one only when the
        // endpoint did not issue a replacement.
        refreshToken: tokens.refresh_token ?? account.refreshToken,
        idToken: tokens.id_token ?? account.idToken,
        expiresAtMs,
        obtainedAtMs: this.now(),
        enabled: true,
        email: account.email ?? claims.email,
        plan: account.plan ?? claims.plan,
      };
      this.accounts.set(accountId, next);
      this.persist();
      this.logger?.info("chatgpt oauth: token refreshed", {
        account: maskSecret(accountId),
        expiresAtMs,
      });
      return true;
    } catch (err) {
      if (err instanceof OAuthError && err.kind === "invalid_grant") {
        this.logger?.warn("chatgpt oauth: refresh token invalid, account disabled — re-login required", {
          account: maskSecret(accountId),
        });
        account.enabled = false;
        this.persist();
      } else {
        this.logger?.warn("chatgpt oauth: token refresh failed (transient)", {
          account: maskSecret(accountId),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }
  }

  private persist(): void {
    try {
      this.store.save([...this.accounts.values()]);
    } catch (err) {
      this.logger?.warn("chatgpt oauth: failed to persist token store", {
        file: this.store.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
