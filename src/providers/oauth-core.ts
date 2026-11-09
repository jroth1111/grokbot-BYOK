/**
 * Generic OAuth foundation shared by all login-based providers
 * ("Sign in with ChatGPT", Anthropic Claude, Google Antigravity).
 *
 * Everything provider-agnostic lives here:
 *  - the multi-account token store (0600, atomic tmp+rename writes)
 *  - the token manager skeleton: single-flight refresh, proactive refresh
 *    sweeps, invalid_grant → account disable, priority-ordered rotation
 *  - PKCE helpers and the loopback callback server used by login flows
 *
 * Provider specifics (endpoints, request shapes, onboarding) live in the
 * per-provider modules: chatgpt-oauth.ts, claude-oauth.ts,
 * antigravity-oauth.ts.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { KeyInfo } from "../types.js";

/** Directory holding per-provider token stores. */
export const OAUTH_TOKEN_DIR = "config/oauth";

/** Refresh the access token when it expires within this window (ms). */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Background sweep refreshes anything expiring within this window (ms). */
const DEFAULT_DUE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
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

/**
 * The refreshed token no longer belongs to the stored account (the user
 * re-logged-in elsewhere on this slot). The account is disabled, mirroring
 * how the reference clients treat this case.
 */
export class OAuthAccountMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthAccountMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Accounts & token store
// ---------------------------------------------------------------------------

/**
 * One signed-in account. Provider-specific fields (plan, organization,
 * projectId, tier, …) ride along via the index signature and are persisted
 * as-is.
 */
export interface OAuthAccount {
  /** Stable routing id (provider-specific: account uuid, email, …). */
  accountId: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry (epoch ms). Refreshed before it lapses. */
  expiresAtMs: number;
  /** When the tokens were last obtained/refreshed (epoch ms). */
  obtainedAtMs: number;
  /** false after invalid_grant / mismatch — the account must re-login. */
  enabled: boolean;
  /** Routing priority: lower = preferred. Default 100. */
  priority?: number;
  /** Rotation weight for weighted strategies (default 1). */
  weight?: number;
  [key: string]: unknown;
}

interface OAuthTokenFileShape {
  version: 1;
  accounts: OAuthAccount[];
}

/** Mask a token/account id for logging. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** Default account priority when none is set. */
export const DEFAULT_ACCOUNT_PRIORITY = 100;

/** Compare accounts for rotation order: priority asc, insertion-stable. */
export function compareAccountOrder(a: OAuthAccount, b: OAuthAccount): number {
  return (a.priority ?? DEFAULT_ACCOUNT_PRIORITY) - (b.priority ?? DEFAULT_ACCOUNT_PRIORITY);
}

/**
 * Multi-account JSON token store. Writes are atomic (tmp + rename) with
 * 0600 permissions; loads are defensive (missing/corrupt file → []).
 */
export class OAuthTokenStore {
  readonly filePath: string;
  private readonly hydrate?: (account: OAuthAccount) => OAuthAccount;

  constructor(filePath: string, hydrate?: (account: OAuthAccount) => OAuthAccount) {
    this.filePath = filePath;
    this.hydrate = hydrate;
  }

  /** Load all accounts; a missing/corrupt file yields an empty list. */
  load(): OAuthAccount[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<OAuthTokenFileShape>;
      if (!parsed || !Array.isArray(parsed.accounts)) return [];
      const accounts = parsed.accounts.filter(
        (a): a is OAuthAccount =>
          !!a &&
          typeof a.accountId === "string" &&
          typeof a.refreshToken === "string" &&
          a.refreshToken.length > 0,
      );
      return this.hydrate ? accounts.map((a) => this.hydrate!(a)) : accounts;
    } catch {
      return [];
    }
  }

  /** Atomically persist the account list (write tmp + rename, mode 0600). */
  save(accounts: OAuthAccount[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: OAuthTokenFileShape = { version: 1, accounts };
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // chmod is best-effort; the write mode above already requested 0600.
    }
    fs.renameSync(tmp, this.filePath);
  }

  /** Insert or replace an account (keyed by accountId). */
  upsert(account: OAuthAccount): void {
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
// PKCE + helpers
// ---------------------------------------------------------------------------

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generate a PKCE pair (S256). Verifier is 64 base64url chars (RFC 7636 allows 43-128). */
export function generatePkcePair(): PkcePair {
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Random URL-safe state parameter. */
export function generateStateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Minimal logger surface the managers need (avoids a hard dep on log.ts). */
export interface OAuthLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Loopback callback server (login flows)
// ---------------------------------------------------------------------------

export interface LoopbackCallback {
  code: string;
  state: string;
}

/**
 * Run a one-shot loopback OAuth callback server on the given port and path.
 * Resolves with the authorization code + state (after verifying the state
 * matches), or rejects on error/state-mismatch/timeout. The server closes
 * itself after the first callback.
 */
export function waitForLoopbackCallback(opts: {
  port: number;
  path: string;
  expectedState: string;
  timeoutMs?: number;
}): Promise<LoopbackCallback> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== opts.path) {
        res.writeHead(404).end("waiting for callback");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h3>Login failed: ${error}</h3>`);
        server.close();
        reject(new Error(`authorize error: ${error}`));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h3>Signed in &#9989;</h3><p>You can close this tab and go back to the terminal.</p>");
      server.close();
      if (!code) {
        reject(new Error("callback missing code"));
        return;
      }
      if (state !== opts.expectedState) {
        reject(new Error("callback state mismatch"));
        return;
      }
      resolve({ code, state: state ?? "" });
    });
    server.on("error", (err) => {
      reject(
        new Error(
          `could not bind callback port ${opts.port} (${(err as NodeJS.ErrnoException).code}). ` +
            `The redirect URI is fixed to localhost:${opts.port} — free the port and retry.`,
        ),
      );
    });
    server.listen(opts.port, "localhost");
    setTimeout(() => {
      server.close();
      reject(new Error(`login timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs).unref();
  });
}

// ---------------------------------------------------------------------------
// Token manager skeleton
// ---------------------------------------------------------------------------

/** Successful refresh result; absent refreshToken keeps the old one. */
export interface RefreshOutcome {
  accessToken: string;
  /** New refresh token when the provider rotates it. */
  refreshToken?: string;
  expiresAtMs: number;
  /** Provider-specific account field updates (email, plan, projectId…). */
  accountPatch?: Record<string, unknown>;
}

/**
 * The credential surface the fetch layer consumes. Implemented by every
 * OAuth token manager; providers hold one in `authManager`.
 */
export interface OAuthCredentialManager {
  /** Resolve a currently-valid access token, refreshing when stale. */
  getValidAccessToken(accountId: string): Promise<{ accessToken: string; accountId: string }>;
  /** Force a refresh regardless of expiry (e.g. after an upstream 401). */
  forceRefresh(accountId: string): Promise<boolean>;
  /** Proactively refresh accounts expiring soon. Returns refresh count. */
  refreshDueAccounts(): Promise<number>;
  /** Rotation entries: one per enabled account, priority-ordered. */
  getKeyInfos(): KeyInfo[];
  /** True when at least one enabled account exists (routing eligibility). */
  hasEnabledAccount(): boolean;
  /**
   * Headers attached to upstream inference requests for this account
   * (Authorization + any provider-specific companions).
   */
  buildUpstreamHeaders(accountId: string): Promise<Record<string, string>>;
  /**
   * Optional undici dispatcher for provider-specific transport shapes
   * (e.g. Antigravity's HTTP/1.1-only fingerprint).
   */
  requestDispatcher?(): unknown;
  /**
   * Optional per-account context consumed by wire dialects (e.g. the
   * Antigravity translator needs the onboarded project id).
   */
  accountContext?(accountId: string): Promise<Record<string, unknown>>;
}

export interface OAuthManagerOptions {
  tokenFile: string;
  now?: () => number;
  logger?: OAuthLogger;
  /** Claim-hydration hook applied on load (fills email/plan/expiry). */
  hydrate?: (account: OAuthAccount) => OAuthAccount;
}

/**
 * Generic multi-account token manager: priority-ordered rotation entries,
 * single-flight refreshes, invalid_grant/mismatch → disable + persist,
 * proactive due-refresh sweeps. Subclasses implement the provider refresh
 * call and any onboarding specifics.
 */
export abstract class OAuthTokenManagerBase<A extends OAuthAccount = OAuthAccount>
  implements OAuthCredentialManager
{
  protected readonly store: OAuthTokenStore;
  protected readonly now: () => number;
  protected readonly logger?: OAuthLogger;
  protected accounts: Map<string, A> = new Map();
  private readonly inflight: Map<string, Promise<boolean>> = new Map();
  private readonly refreshMarginMs: number;

  constructor(opts: OAuthManagerOptions) {
    this.store = new OAuthTokenStore(opts.tokenFile, opts.hydrate);
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger;
    this.refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS;
    for (const account of this.store.load() as A[]) {
      this.accounts.set(account.accountId, account);
    }
  }

  /** Provider label used in log/error messages (e.g. "chatgpt"). */
  protected abstract get providerLabel(): string;

  /** Provider refresh call. Throw OAuthError("invalid_grant") /
   *  OAuthAccountMismatchError to disable the account. */
  protected abstract doRefresh(account: A): Promise<RefreshOutcome>;

  /** All accounts (snapshot, display purposes). */
  getAccounts(): A[] {
    return [...this.accounts.values()];
  }

  getAccount(accountId: string): A | undefined {
    return this.accounts.get(accountId);
  }

  /** Insert/replace an account and persist (used by login flows). */
  upsertAccount(account: A): void {
    this.accounts.set(account.accountId, account);
    this.persist();
  }

  /** True when at least one enabled account exists (routing eligibility). */
  hasEnabledAccount(): boolean {
    for (const account of this.accounts.values()) {
      if (account.enabled) return true;
    }
    return false;
  }

  /**
   * KeyInfos for the provider's rotation machinery: one per enabled
   * account, `value` = account id, priority-ordered (preferred first).
   */
  getKeyInfos(): KeyInfo[] {
    return this.getAccounts()
      .filter((a) => a.enabled)
      .sort(compareAccountOrder)
      .map((a) => ({
        value: a.accountId,
        weight: a.weight ?? 1,
        enabled: true,
      }));
  }

  async getValidAccessToken(
    accountId: string,
  ): Promise<{ accessToken: string; accountId: string }> {
    let account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(
        `${this.providerLabel} oauth: unknown account ${maskSecret(accountId)}`,
      );
    }
    if (!account.enabled) {
      throw new Error(
        `${this.providerLabel} oauth: account ${maskSecret(accountId)} disabled — run the login flow again`,
      );
    }
    if (account.expiresAtMs - this.now() < this.refreshMarginMs) {
      await this.refreshAccount(accountId);
      account = this.accounts.get(accountId)!;
      if (!account.enabled) {
        throw new Error(
          `${this.providerLabel} oauth: account ${maskSecret(accountId)} could not be refreshed — re-login required`,
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
   * Refresh every enabled account whose token expires within the due
   * window. Returns how many were refreshed.
   */
  async refreshDueAccounts(): Promise<number> {
    let refreshed = 0;
    for (const [accountId, account] of this.accounts) {
      if (!account.enabled) continue;
      if (account.expiresAtMs - this.now() < DEFAULT_DUE_WINDOW_MS) {
        if (await this.refreshAccount(accountId)) refreshed++;
      }
    }
    return refreshed;
  }

  /** Default upstream headers: Authorization Bearer only. */
  async buildUpstreamHeaders(accountId: string): Promise<Record<string, string>> {
    const { accessToken } = await this.getValidAccessToken(accountId);
    return { Authorization: `Bearer ${accessToken}` };
  }

  /** Single-flight wrapper around {@link doRefresh}. */
  private async refreshAccount(accountId: string): Promise<boolean> {
    const existing = this.inflight.get(accountId);
    if (existing) return existing;
    const promise = this.doRefreshAccount(accountId).finally(() => {
      this.inflight.delete(accountId);
    });
    this.inflight.set(accountId, promise);
    return promise;
  }

  private async doRefreshAccount(accountId: string): Promise<boolean> {
    const account = this.accounts.get(accountId);
    if (!account) return false;
    try {
      const outcome = await this.doRefresh(account);
      const next: A = {
        ...account,
        ...(outcome.accountPatch ?? {}),
        accessToken: outcome.accessToken,
        refreshToken: outcome.refreshToken ?? account.refreshToken,
        expiresAtMs: outcome.expiresAtMs,
        obtainedAtMs: this.now(),
        enabled: true,
      };
      this.accounts.set(accountId, next);
      this.persist();
      this.logger?.info(`${this.providerLabel} oauth: token refreshed`, {
        account: maskSecret(accountId),
        expiresAtMs: outcome.expiresAtMs,
      });
      return true;
    } catch (err) {
      if (err instanceof OAuthAccountMismatchError) {
        this.logger?.warn(
          `${this.providerLabel} oauth: account mismatch after refresh, disabling`,
          { account: maskSecret(accountId), error: err.message },
        );
        account.enabled = false;
        this.persist();
      } else if (err instanceof OAuthError && err.kind === "invalid_grant") {
        this.logger?.warn(
          `${this.providerLabel} oauth: refresh token invalid, account disabled — re-login required`,
          { account: maskSecret(accountId) },
        );
        account.enabled = false;
        this.persist();
      } else {
        this.logger?.warn(`${this.providerLabel} oauth: token refresh failed (transient)`, {
          account: maskSecret(accountId),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }
  }

  protected persist(): void {
    try {
      this.store.save([...this.accounts.values()]);
    } catch (err) {
      this.logger?.warn(`${this.providerLabel} oauth: failed to persist token store`, {
        file: this.store.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
