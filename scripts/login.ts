/**
 * Unified login CLI for all subscription (OAuth) providers.
 *
 *   npm run login -- claude [--priority 10] [--no-open] [--auto-config]
 *   npm run login -- antigravity [...]
 *   npm run login -- chatgpt [...]      (npm run chatgpt:login still works)
 *   npm run login --status [--models]    all providers, all accounts
 *   npm run login --logout claude [--all | --account <id>]
 *
 * Each provider supports MULTIPLE accounts (re-run login in another
 * browser profile); accounts carry a routing PRIORITY (lower = preferred,
 * default 100) and fail down to the next account automatically.
 *
 * After a successful login the CLI discovers the account's usable model
 * catalog (provider-specific) and suggests — or with --auto-config writes —
 * defaultModel = the first available model.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import {
  CHATGPT_OAUTH_CALLBACK_PORT,
  ChatGptTokenStore,
  DEFAULT_CHATGPT_TOKEN_FILE,
  buildAuthorizeUrl as buildChatgptAuthorizeUrl,
  exchangeAuthorizationCode,
  extractChatgptAuthClaim,
  generatePkce as chatgptPkce,
  generateState as chatgptState,
  revokeRefreshToken as revokeChatgpt,
  type ChatGptAccount,
} from "../src/providers/chatgpt-oauth.js";
import {
  CLAUDE_OAUTH_CALLBACK_PORT,
  buildClaudeAuthorizeUrl,
  exchangeClaudeCode,
  fetchClaudeProfile,
  parseClaudeCallbackCode,
  probeClaudeModels,
  claudePkce,
  CLAUDE_CANDIDATE_MODELS,
} from "../src/providers/claude-oauth.js";
import {
  ANTIGRAVITY_CANDIDATE_MODELS,
  ANTIGRAVITY_CALLBACK_PORT,
  ANTIGRAVITY_TOKEN_ENDPOINT,
  buildAntigravityAuthorizeUrl,
  exchangeAntigravityCode,
  fetchAntigravityEmail,
  onboardAntigravity,
  antigravityState,
} from "../src/providers/antigravity-oauth.js";
import { OAuthTokenStore, maskSecret, waitForLoopbackCallback, type OAuthAccount } from "../src/providers/oauth-core.js";

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

const info = (msg: string): void => console.log(msg);
const ok = (msg: string): void => console.log(`${GREEN}${msg}${RESET}`);
const warn = (msg: string): void => console.log(`${YELLOW}${msg}${RESET}`);
const fail = (msg: string): void => {
  console.error(`${RED}${msg}${RESET}`);
  process.exit(1);
};

type Provider = "claude" | "antigravity" | "chatgpt";
const PROVIDERS: Provider[] = ["claude", "antigravity", "chatgpt"];

interface Args {
  command: "login" | "logout" | "status";
  provider?: Provider;
  account?: string;
  all: boolean;
  priority?: number;
  noOpen: boolean;
  autoConfig: boolean;
  models: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "status",
    all: false,
    noOpen: false,
    autoConfig: false,
    models: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") args.command = "status";
    else if (a === "--logout") args.command = "logout";
    else if (a === "--priority") args.priority = parseInt(argv[++i], 10);
    else if (a === "--account") args.account = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--no-open") args.noOpen = true;
    else if (a === "--auto-config") args.autoConfig = true;
    else if (a === "--models") args.models = true;
    else if (PROVIDERS.includes(a as Provider)) {
      args.command = "login";
      args.provider = a as Provider;
    } else {
      fail(`unknown argument: ${a}\n\nusage: login [claude|antigravity|chatgpt [--priority N] [--auto-config] [--no-open]] | --status [--models] | --logout <provider> [--all|--account <id>]`);
    }
  }
  if (args.command === "login" && !args.provider) {
    fail(`specify a provider: login ${PROVIDERS.join("|")}`);
  }
  if (args.command === "logout" && !args.provider) {
    fail(`specify a provider: --logout ${PROVIDERS.join("|")}`);
  }
  if (args.priority !== undefined && !Number.isFinite(args.priority)) {
    fail("--priority requires a number");
  }
  return args;
}

// ---------------------------------------------------------------------------
// Config / store resolution
// ---------------------------------------------------------------------------

function loadJsonConfig(): Record<string, unknown> | null {
  for (const p of [process.env.SHIM_CONFIG, "config/config.json"]) {
    if (!p) continue;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  return null;
}

/** Resolve a provider's token file: config auth.tokenFile, else default. */
function resolveTokenFile(provider: Provider): string {
  interface ProviderEntry {
    auth?: { type?: string; tokenFile?: string };
  }
  const cfg = loadJsonConfig() as
    | { providers?: { configs?: Record<string, ProviderEntry> } }
    | null;
  const wantType = `${provider}-oauth`;
  for (const entry of Object.values(cfg?.providers?.configs ?? {})) {
    if (entry?.auth?.type === wantType && entry.auth.tokenFile) {
      return entry.auth.tokenFile;
    }
  }
  switch (provider) {
    case "chatgpt":
      return process.env.CHATGPT_TOKEN_FILE ?? DEFAULT_CHATGPT_TOKEN_FILE;
    case "claude":
      return "config/oauth/claude-tokens.json";
    case "antigravity":
      return "config/oauth/antigravity-tokens.json";
  }
}

function storeFor(provider: Provider): OAuthTokenStore {
  const file = resolveTokenFile(provider);
  return provider === "chatgpt" ? new ChatGptTokenStore(file) : new OAuthTokenStore(file);
}

// ---------------------------------------------------------------------------
// Shared login helpers
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      info(`${DIM}Could not open a browser automatically — copy the URL above into it.${RESET}`);
    }
  });
}

function openAndPrint(url: string, port: number, noOpen: boolean): void {
  info("");
  info(`${BOLD}Sign in${RESET} — opening your browser…`);
  info("");
  info(`  ${CYAN}${url}${RESET}`);
  info("");
  info(`${DIM}Complete the sign-in there; this tool waits on http://localhost:${port}.$RESET}`);
  if (!noOpen) openBrowser(url);
}

// ---------------------------------------------------------------------------
// Login result + token handoff between the flow and persistence
// ---------------------------------------------------------------------------

interface LoginResult {
  accountId: string;
  email?: string;
  defaultModel?: string;
  models: string[];
  note?: string;
}

let pendingTokens: {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  extras?: Record<string, unknown>;
} | null = null;

function autoConfig(provider: Provider, defaultModel?: string): void {
  const cfgPath = process.env.SHIM_CONFIG ?? "config/config.json";
  if (!defaultModel) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const entry = cfg?.providers?.configs?.[provider];
    if (!entry) {
      info(`  ${DIM}--auto-config: no "${provider}" entry in ${cfgPath}; add one with defaultModel "${defaultModel}".${RESET}`);
      return;
    }
    entry.defaultModel = defaultModel;
    entry.models = {
      [defaultModel]: defaultModel,
      ...(entry.models ?? {}),
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    ok(`  config updated: ${provider}.defaultModel = ${defaultModel}`);
  } catch (err) {
    warn(`  --auto-config failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Status / logout
// ---------------------------------------------------------------------------

function summarize(provider: Provider): void {
  const accounts = storeFor(provider).load();
  if (accounts.length === 0) {
    info(`  ${DIM}${provider}: no accounts — npm run login -- ${provider}${RESET}`);
    return;
  }
  info(`  ${BOLD}${provider}${RESET} (${accounts.length}):`);
  for (const a of accounts) {
    const expires =
      a.expiresAtMs > Date.now()
        ? `${Math.round((a.expiresAtMs - Date.now()) / 60000)}m`
        : `${YELLOW}expired${RESET}`;
    info(
      `    ${a.enabled ? GREEN : RED}${maskSecret(a.accountId)}${RESET}` +
        (a.email ? ` <${a.email}>` : "") +
        `  pri=${a.priority ?? 100}` +
        `  ${expires}` +
        (a.enabled ? "" : "  DISABLED (re-login)"),
    );
  }
}

async function revokeFor(provider: Provider, refreshToken: string): Promise<boolean> {
  if (provider === "chatgpt") {
    return revokeChatgpt({ refreshToken });
  }
  if (provider === "antigravity") {
    try {
      const resp = await fetch(`${ANTIGRAVITY_TOKEN_ENDPOINT.slice(0, -6)}revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
  // Claude has no public revocation endpoint — local removal only.
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let argsGlobal: Args;

async function runLogin(args: Args): Promise<void> {
  const provider = args.provider!;
  let login: LoginResult;
  if (provider === "chatgpt") {
    const pkce = chatgptPkce();
    const state = chatgptState();
    const url = buildChatgptAuthorizeUrl({ codeChallenge: pkce.codeChallenge, state });
    openAndPrint(url, CHATGPT_OAUTH_CALLBACK_PORT, args.noOpen);
    const cb = await waitForLoopbackCallback({
      port: CHATGPT_OAUTH_CALLBACK_PORT,
      path: "/auth/callback",
      expectedState: state,
    });
    ok("authorization code received — exchanging tokens…");
    const tokens = await exchangeAuthorizationCode({ code: cb.code, codeVerifier: pkce.codeVerifier });
    const claims = extractChatgptAuthClaim(tokens.access_token);
    const idClaims = tokens.id_token ? extractChatgptAuthClaim(tokens.id_token) : undefined;
    const accountId = claims.accountId ?? idClaims?.accountId;
    if (!accountId) throw new Error("token response carries no chatgpt_account_id claim");
    if (!tokens.refresh_token) throw new Error("token response carries no refresh_token");
    let models: string[] = [];
    try {
      const resp = await fetch(
        "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
        {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "chatgpt-account-id": accountId,
            Accept: "application/json",
          },
        },
      );
      if (resp.ok) {
        const data = (await resp.json()) as { models?: Array<{ slug?: string }> };
        models = (data.models ?? []).map((m) => m.slug ?? "").filter(Boolean);
      }
    } catch {
      // catalog is advisory
    }
    login = {
      accountId,
      email: claims.email ?? idClaims?.email,
      defaultModel: models[0],
      models,
      note: claims.plan ? `plan: ${claims.plan}` : undefined,
    };
    pendingTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAtMs:
        claims.expiresAtMs ??
        Date.now() + (tokens.expires_in && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000,
    };
  } else if (provider === "claude") {
    const { codeVerifier, codeChallenge, state } = claudePkce();
    const url = buildClaudeAuthorizeUrl({ state, codeChallenge });
    openAndPrint(url, CLAUDE_OAUTH_CALLBACK_PORT, args.noOpen);
    const cb = await waitForLoopbackCallback({
      port: CLAUDE_OAUTH_CALLBACK_PORT,
      path: "/callback",
      expectedState: state,
    });
    ok("authorization code received — exchanging tokens…");
    const { code: parsedCode, state: parsedState } = parseClaudeCallbackCode(cb.code);
    const tokens = await exchangeClaudeCode({
      code: parsedCode,
      state: parsedState ?? state,
      codeVerifier,
    });
    const profile = await fetchClaudeProfile({ accessToken: tokens.access_token });
    const accountId =
      profile?.accountUuid ?? tokens.account?.uuid ?? profile?.email ?? tokens.account?.email_address;
    if (!accountId) throw new Error("could not determine the Claude account id");
    if (!tokens.refresh_token) throw new Error("token response carries no refresh_token");
    info("probing usable models (1-token requests)…");
    const probes = await probeClaudeModels({ accessToken: tokens.access_token });
    const usable = probes.filter((p) => p.ok).map((p) => p.model);
    for (const p of probes) {
      info(`  ${p.ok ? GREEN : DIM}${p.model}${p.ok ? " ✅" : ` ❌ ${p.status ?? ""}${p.detail ? " " + p.detail.slice(0, 60) : ""}`}${RESET}`);
    }
    login = {
      accountId,
      email: profile?.email ?? tokens.account?.email_address,
      defaultModel: usable[0],
      models: usable.length > 0 ? usable : CLAUDE_CANDIDATE_MODELS,
      note:
        usable.length === 0
          ? "no model probe succeeded — entitlement may require a paid Claude plan"
          : undefined,
    };
    pendingTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAtMs:
        Date.now() + (tokens.expires_in && tokens.expires_in > 0 ? tokens.expires_in : 8 * 3600) * 1000,
      extras: {
        organizationUuid: profile?.organizationUuid ?? tokens.organization?.uuid,
        organizationName: profile?.organizationName ?? tokens.organization?.name,
      },
    };
  } else {
    const state = antigravityState();
    const url = buildAntigravityAuthorizeUrl({ state });
    openAndPrint(url, ANTIGRAVITY_CALLBACK_PORT, args.noOpen);
    const cb = await waitForLoopbackCallback({
      port: ANTIGRAVITY_CALLBACK_PORT,
      path: "/oauth-callback",
      expectedState: state,
    });
    ok("authorization code received — exchanging tokens…");
    const tokens = await exchangeAntigravityCode({ code: cb.code });
    const email = await fetchAntigravityEmail({ accessToken: tokens.access_token });
    info("onboarding to the Antigravity surface (loadCodeAssist/onboardUser)…");
    const { projectId, tier } = await onboardAntigravity({ accessToken: tokens.access_token });
    ok(`onboarded (tier ${tier}, project ${maskSecret(projectId)})`);
    if (!email) throw new Error("could not determine the Google account email");
    if (!tokens.refresh_token) throw new Error("token response carries no refresh_token (consent missed?)");
    login = {
      accountId: email,
      email,
      defaultModel: ANTIGRAVITY_CANDIDATE_MODELS[0],
      models: ANTIGRAVITY_CANDIDATE_MODELS,
      note: "model entitlements verified on first use; free Google accounts include Gemini quota",
    };
    pendingTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAtMs:
        Date.now() + (tokens.expires_in && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000,
      extras: { projectId, tier },
    };
  }

  // Persist the account with tokens + provider extras.
  const store = storeFor(provider);
  const existing = store.load().find((a) => a.accountId === login.accountId);
  const tokensNow = pendingTokens!;
  const account = {
    ...(existing ?? {}),
    accountId: login.accountId,
    email: login.email,
    obtainedAtMs: Date.now(),
    enabled: true,
    priority: args.priority ?? existing?.priority ?? 100,
    ...tokensNow.extras,
    accessToken: tokensNow.accessToken,
    refreshToken: tokensNow.refreshToken,
    expiresAtMs: tokensNow.expiresAtMs,
  } as OAuthAccount;
  store.upsert(account);

  const count = store.load().length;
  info("");
  ok(`Signed in: ${login.email ?? maskSecret(login.accountId)}${login.note ? ` (${login.note})` : ""}`);
  if (login.defaultModel) {
    info(`  suggested defaultModel: ${CYAN}${login.defaultModel}${RESET} ${DIM}(first available model)${RESET}`);
  }
  if (login.models.length > 0) {
    info(`  model catalog: ${login.models.slice(0, 8).join(", ")}${login.models.length > 8 ? " …" : ""}`);
  }
  info(`  accounts on file: ${count} (priority ${account.priority ?? 100})`);
  if (args.autoConfig) {
    autoConfig(provider, login.defaultModel);
  } else if (login.defaultModel) {
    info(`  ${DIM}re-run with --auto-config to set ${provider}.defaultModel automatically${RESET}`);
  }
  info(`  ${BOLD}Restart the shim to apply:${RESET} npm start`);
}

async function runLogout(args: Args): Promise<void> {
  const provider = args.provider!;
  const store = storeFor(provider);
  const accounts = store.load();
  if (accounts.length === 0) {
    warn(`no ${provider} accounts — nothing to do`);
    return;
  }
  let selected = accounts;
  if (!args.all) {
    if (args.account) {
      selected = accounts.filter(
        (a) => a.accountId === args.account || maskSecret(a.accountId) === args.account,
      );
      if (selected.length === 0) {
        fail(`no ${provider} account matches "${args.account}". On file:\n${accounts.map((a) => `  ${a.accountId}`).join("\n")}`);
      }
    } else {
      summarize(provider);
      info(`\nUse ${BOLD}--all${RESET} to log out everywhere, or ${BOLD}--account <id>${RESET} for one.`);
      return;
    }
  }
  for (const account of selected) {
    info(`revoking ${provider} / ${maskSecret(account.accountId)}…`);
    const revoked = await revokeFor(provider, account.refreshToken);
    if (!revoked) warn(`  revocation not confirmed (removing locally anyway)`);
    store.remove(account.accountId);
    ok(`  removed ${maskSecret(account.accountId)}`);
  }
  info(`\n  ${BOLD}Restart the shim to apply:${RESET} npm start`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  argsGlobal = args;
  switch (args.command) {
    case "login":
      await runLogin(args);
      break;
    case "logout":
      await runLogout(args);
      break;
    case "status":
      info("");
      info(`${BOLD}Subscription accounts${RESET}`);
      info("");
      for (const provider of PROVIDERS) summarize(provider);
      info("");
      break;
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
