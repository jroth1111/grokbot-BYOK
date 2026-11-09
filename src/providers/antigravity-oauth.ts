/**
 * Google Antigravity subscription OAuth (the same login the Antigravity IDE
 * uses).
 *
 * Any Google account (free tier included) signs in via Google OAuth; the
 * credential must then be onboarded to the Cloud Code "Antigravity" surface
 * (loadCodeAssist / onboardUser) to obtain a cloudaicompanionProject id,
 * and inference calls go to the v1internal Gemini endpoint on
 * daily-cloudcode-pa.googleapis.com (see translate/gemini-v1internal.ts for
 * the wire translation).
 *
 * Endpoint constants, the onboarding sequence, and the transport quirks
 * (HTTP/1.1-only, no h2 ALPN, `antigravity/hub/<version>` UA with a
 * version floor enforced by Cloud Code) mirror the reference open-source
 * clients (CLIProxyAPI's internal Antigravity auth/executor, which
 * reproduces native Antigravity traffic).
 *
 * NOTE: this path is officially intended for Google's own clients; use
 * with your own informed judgment re: ToS and account risk.
 */
import { Agent } from "undici";
import {
  OAuthError,
  OAuthTokenManagerBase,
  generateStateToken,
  type OAuthAccount,
  type OAuthLogger,
  type RefreshOutcome,
} from "./oauth-core.js";

// ---------------------------------------------------------------------------
// Endpoints & constants
// ---------------------------------------------------------------------------

/** Google OAuth authorization endpoint. */
export const ANTIGRAVITY_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";

/** Google OAuth token endpoint. */
export const ANTIGRAVITY_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Google user info endpoint (email capture). */
export const ANTIGRAVITY_USERINFO_ENDPOINT =
  "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";

/** Cloud Code (prod) API base. */
export const ANTIGRAVITY_API_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** Cloud Code (daily) API base — the surface native Antigravity uses. */
export const ANTIGRAVITY_DAILY_API_ENDPOINT =
  "https://daily-cloudcode-pa.googleapis.com";

/** Antigravity's internal API version segment. */
export const ANTIGRAVITY_API_VERSION = "v1internal";

/**
 * Antigravity IDE's Google OAuth client (installed-app credentials; the
 * "secret" is public by design for native clients).
 */
export const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET =
  "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";

/** Loopback redirect (fixed port, matching the native client). */
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_CALLBACK_PORT = 51121;

/** OAuth scopes required by the Antigravity surface. */
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Default token-store path. */
export const DEFAULT_ANTIGRAVITY_TOKEN_FILE = "config/oauth/antigravity-tokens.json";

// ---------------------------------------------------------------------------
// User-Agent management (Cloud Code enforces a client version floor)
// ---------------------------------------------------------------------------

/** Fallback hub version — must stay ≥ 2.23.0 (Cloud Code model gating). */
const ANTIGRAVITY_FALLBACK_VERSION = "2.29.0";
const ANTIGRAVITY_FALLBACK_CHANGELIST = "1013060670";
const ANTIGRAVITY_HUB_PLATFORM = "os_type=darwin; arch=arm64";
const ANTIGRAVITY_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
const NODE_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";

let cachedHubVersion: { version: string; changelist: string; fetchedAt: number } | null =
  null;

/** Best-effort fetch of the latest hub version (electron-builder manifest). */
async function refreshHubVersion(): Promise<void> {
  try {
    const resp = await fetch(ANTIGRAVITY_MANIFEST_URL, {
      headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const text = await resp.text();
    const match = text.match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m);
    if (match) {
      cachedHubVersion = {
        version: match[1],
        // Changelists are release-specific; only the fallback release has a
        // verified value, unknown releases ship without the cl= hint.
        changelist:
          match[1] === ANTIGRAVITY_FALLBACK_VERSION
            ? ANTIGRAVITY_FALLBACK_CHANGELIST
            : "",
        fetchedAt: Date.now(),
      };
    }
  } catch {
    // offline / blocked — keep the fallback
  }
}

/** The `antigravity/hub/<version>` UA string used on all API requests. */
export async function antigravityUserAgent(): Promise<string> {
  if (
    !cachedHubVersion ||
    Date.now() - cachedHubVersion.fetchedAt > ANTIGRAVITY_VERSION_TTL_MS
  ) {
    await refreshHubVersion();
    if (!cachedHubVersion) {
      cachedHubVersion = {
        version: ANTIGRAVITY_FALLBACK_VERSION,
        changelist: ANTIGRAVITY_FALLBACK_CHANGELIST,
        fetchedAt: Date.now(),
      };
    }
  }
  const v = cachedHubVersion;
  const metadata =
    `aidev_client; ${ANTIGRAVITY_HUB_PLATFORM}` +
    (v.changelist ? `; cl=${v.changelist}` : "");
  return `antigravity/hub/${v.version} (${metadata})`;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** One signed-in Antigravity account. */
export interface AntigravityAccount extends OAuthAccount {
  accountId: string;
  /** cloudaicompanionProject id from onboarding (required for inference). */
  projectId?: string;
  tier?: string;
}

// ---------------------------------------------------------------------------
// OAuth flow pieces (Google, form-encoded, client_secret)
// ---------------------------------------------------------------------------

export function buildAntigravityAuthorizeUrl(opts: {
  state: string;
  redirectUri?: string;
  authEndpoint?: string;
}): string {
  const url = new URL(opts.authEndpoint ?? ANTIGRAVITY_AUTH_ENDPOINT);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set(
    "redirect_uri",
    opts.redirectUri ?? ANTIGRAVITY_REDIRECT_URI,
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function postGoogleForm(
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

function parseGoogleTokenResponse(
  status: number,
  bodyText: string,
  what: string,
): GoogleTokenResponse {
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
    const parsed = JSON.parse(bodyText) as GoogleTokenResponse;
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

/** Exchange the authorization code (includes the installed-app secret). */
export async function exchangeAntigravityCode(opts: {
  code: string;
  tokenEndpoint?: string;
}): Promise<GoogleTokenResponse> {
  const { status, bodyText } = await postGoogleForm(
    opts.tokenEndpoint ?? ANTIGRAVITY_TOKEN_ENDPOINT,
    {
      code: opts.code,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      grant_type: "authorization_code",
    },
  );
  return parseGoogleTokenResponse(status, bodyText, "code exchange");
}

/** Standard Google refresh grant (refresh tokens are long-lived). */
export async function refreshAntigravityToken(opts: {
  refreshToken: string;
  tokenEndpoint?: string;
}): Promise<GoogleTokenResponse> {
  const { status, bodyText } = await postGoogleForm(
    opts.tokenEndpoint ?? ANTIGRAVITY_TOKEN_ENDPOINT,
    {
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
    },
  );
  return parseGoogleTokenResponse(status, bodyText, "token refresh");
}

/** Fetch the Google account email. */
export async function fetchAntigravityEmail(opts: {
  accessToken: string;
  userinfoEndpoint?: string;
}): Promise<string | undefined> {
  try {
    const resp = await fetch(
      opts.userinfoEndpoint ?? ANTIGRAVITY_USERINFO_ENDPOINT,
      { headers: { Authorization: `Bearer ${opts.accessToken}` } },
    );
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { email?: string };
    return data.email?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Onboarding: loadCodeAssist / onboardUser → cloudaicompanionProject
// ---------------------------------------------------------------------------

function extractProjectId(data: Record<string, unknown> | null | undefined): string {
  if (!data) return "";
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value !== null && typeof value === "object") {
      const id = (value as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  }
  return "";
}

function defaultTierId(loadResp: Record<string, unknown>): string {
  const tiers = loadResp.allowedTiers;
  if (Array.isArray(tiers)) {
    for (const raw of tiers) {
      const tier = raw as Record<string, unknown>;
      if (tier?.isDefault === true && typeof tier.id === "string" && tier.id.trim()) {
        return tier.id;
      }
    }
  }
  const current = loadResp.currentTier as Record<string, unknown> | undefined;
  if (current && typeof current.id === "string" && current.id.trim()) {
    return current.id;
  }
  return "free-tier";
}

/**
 * Complete Antigravity onboarding for the account: resolve the
 * cloudaicompanionProject id via loadCodeAssist, falling back to
 * onboardUser (polled until done). Throws when no project id is obtained —
 * credentials without a project cannot serve inference.
 */
export async function onboardAntigravity(opts: {
  accessToken: string;
  apiBase?: string;
  version?: string;
}): Promise<{ projectId: string; tier: string }> {
  const base = (opts.apiBase ?? ANTIGRAVITY_DAILY_API_ENDPOINT).replace(/\/+$/, "");
  const version = opts.version ?? ANTIGRAVITY_API_VERSION;
  const ua = await antigravityUserAgent();

  // Step 1: loadCodeAssist — existing users already carry a project.
  let loadResp: Record<string, unknown> = {};
  {
    const resp = await fetch(`${base}/${version}:loadCodeAssist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.accessToken}`,
        "User-Agent": ua,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    });
    const text = await resp.text().catch(() => "");
    if (resp.ok) {
      try {
        loadResp = JSON.parse(text) as Record<string, unknown>;
      } catch {
        loadResp = {};
      }
    } else if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      throw new OAuthError(
        "http",
        `antigravity loadCodeAssist failed: status ${resp.status}: ${text.slice(0, 160)}`,
        resp.status,
      );
    }
  }
  const direct = extractProjectId(loadResp);
  if (direct) {
    return { projectId: direct, tier: defaultTierId(loadResp) };
  }

  // Step 2: onboardUser — provision the default tier, poll until done.
  const tier = defaultTierId(loadResp);
  const versionTag = ua.split(" ")[0]?.split("/")[2] ?? ANTIGRAVITY_FALLBACK_VERSION;
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(`${base}/${version}:onboardUser`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Authorization: `Bearer ${opts.accessToken}`,
        "User-Agent": `${ua} ${NODE_API_CLIENT_UA}`,
        "X-Goog-Api-Client": "gl-node/22.21.1",
      },
      body: JSON.stringify({
        tier_id: tier,
        metadata: {
          ide_type: "ANTIGRAVITY",
          ide_version: versionTag,
          ide_name: "antigravity",
        },
      }),
    });
    const text = await resp.text().catch(() => "");
    if (resp.ok) {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (data.done === true) {
        const response = data.response as Record<string, unknown> | undefined;
        const projectId = extractProjectId(response ?? data);
        if (projectId) return { projectId, tier };
        throw new OAuthError("http", "antigravity onboardUser returned no project_id");
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new OAuthError(
      "http",
      `antigravity onboardUser failed: status ${resp.status}: ${text.slice(0, 160)}`,
      resp.status,
    );
  }
  throw new OAuthError("http", "antigravity onboarding did not complete in time");
}

// ---------------------------------------------------------------------------
// Candidate models (free-tier Gemini family; entitlements verified live)
// ---------------------------------------------------------------------------

export const ANTIGRAVITY_CANDIDATE_MODELS = [
  "gemini-3-pro-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3-pro-image-preview",
];

// ---------------------------------------------------------------------------
// Token manager
// ---------------------------------------------------------------------------

export interface AntigravityTokenManagerOptions {
  tokenFile: string;
  tokenEndpoint?: string;
  now?: () => number;
  logger?: OAuthLogger;
}

/**
 * Antigravity specifics on the generic OAuth skeleton. Inference requests
 * for this provider must run over HTTP/1.1 without h2 ALPN (native client
 * fingerprint), so the manager exposes a dedicated undici dispatcher.
 */
export class AntigravityTokenManager extends OAuthTokenManagerBase<AntigravityAccount> {
  private readonly tokenEndpoint: string;
  private dispatcher: Agent | undefined;

  constructor(opts: AntigravityTokenManagerOptions) {
    super({ tokenFile: opts.tokenFile, now: opts.now, logger: opts.logger });
    this.tokenEndpoint = opts.tokenEndpoint ?? ANTIGRAVITY_TOKEN_ENDPOINT;
  }

  protected get providerLabel(): string {
    return "antigravity";
  }

  protected async doRefresh(account: AntigravityAccount): Promise<RefreshOutcome> {
    const tokens = await refreshAntigravityToken({
      refreshToken: account.refreshToken,
      tokenEndpoint: this.tokenEndpoint,
    });
    const expiresAtMs =
      tokens.expires_in && tokens.expires_in > 0
        ? this.now() + tokens.expires_in * 1000
        : this.now() + 60 * 60 * 1000;
    return {
      accessToken: tokens.access_token,
      // Google refresh tokens are long-lived and not rotated.
      refreshToken: tokens.refresh_token ?? account.refreshToken,
      expiresAtMs,
    };
  }

  /** Upstream headers: Bearer + the antigravity/hub UA (version floor). */
  override async buildUpstreamHeaders(
    accountId: string,
  ): Promise<Record<string, string>> {
    const { accessToken } = await this.getValidAccessToken(accountId);
    return {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": await antigravityUserAgent(),
    };
  }

  /**
   * HTTP/1.1-only dispatcher matching the native client's TLS/ALPN shape
   * (no h2). Shared across accounts; keep-alive with a short idle timeout.
   */
  requestDispatcher(): unknown {
    if (!this.dispatcher) {
      this.dispatcher = new Agent({
        allowH2: false,
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 210_000,
      });
    }
    return this.dispatcher;
  }

  /** Dialect context: the onboarded project id rides in request bodies. */
  async accountContext(accountId: string): Promise<Record<string, unknown>> {
    const account = this.getAccount(accountId);
    return { projectId: account?.projectId };
  }
}

/** Random state under a neutral name for the login CLI. */
export function antigravityState(): string {
  return generateStateToken();
}
