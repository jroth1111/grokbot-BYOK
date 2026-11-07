/**
 * ChatGPT ("Sign in with ChatGPT") login/logout/status CLI.
 *
 *   npm run chatgpt:login     # browser OAuth flow (repeat to add accounts)
 *   npm run chatgpt:logout    # revoke + remove accounts (all or --account <id>)
 *   npm run chatgpt:status    # list signed-in accounts
 *
 * The login flow mirrors the Codex CLI: PKCE (S256) against
 * auth.openai.com with the public Codex client id, callback on the fixed
 * loopback port 1455. Tokens land in the shared token-store file the shim
 * reads (config/chatgpt-tokens.json by default, or whatever the chatgpt
 * provider's auth.tokenFile says in config/config.json). After logging in
 * or out, restart the shim (`npm start`) so routing picks up the change.
 *
 * Non-interactive import for migrations:
 *   node dist/scripts/chatgpt-login.js --refresh-token <rt>
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import {
  CHATGPT_OAUTH_CALLBACK_PORT,
  ChatGptTokenStore,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  extractChatgptAuthClaim,
  generatePkce,
  generateState,
  maskSecret,
  refreshAccessToken,
  revokeRefreshToken,
  type ChatGptAccount,
} from "../src/providers/chatgpt-oauth.js";

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

interface Args {
  command: "login" | "logout" | "status" | "import";
  account?: string;
  all: boolean;
  refreshToken?: string;
  tokenFile?: string;
  noOpen: boolean;
  /** --models: also list the models this account may use on the backend. */
  models: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "login", all: false, noOpen: false, models: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--logout") args.command = "logout";
    else if (a === "--status") args.command = "status";
    else if (a === "--models") args.models = true;
    else if (a === "--refresh-token") {
      args.command = "import";
      args.refreshToken = argv[++i];
    } else if (a === "--account") args.account = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--token-file") args.tokenFile = argv[++i];
    else if (a === "--no-open") args.noOpen = true;
    else if (a === "login" || a === "logout" || a === "status") {
      args.command = a;
    } else {
      fail(`unknown argument: ${a}\n\nusage: chatgpt-login [login|--status [--models]|--logout [--all|--account <id>]|--refresh-token <rt>] [--token-file <path>] [--no-open]`);
    }
  }
  if (args.command === "import" && !args.refreshToken) {
    fail("--refresh-token requires a value");
  }
  return args;
}

/**
 * Resolve the token-store path: --token-file flag, else the chatgpt
 * provider's auth.tokenFile from config/config.json, else the default.
 */
function resolveTokenFile(flag?: string): string {
  if (flag) return flag;
  const envFile = process.env.CHATGPT_TOKEN_FILE;
  if (envFile) return envFile;
  try {
    const configPath = process.env.SHIM_CONFIG ?? "config/config.json";
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      providers?: { configs?: Record<string, { auth?: { tokenFile?: string } }> };
    };
    for (const provider of Object.values(raw.providers?.configs ?? {})) {
      if (provider?.auth?.tokenFile) return provider.auth.tokenFile;
    }
  } catch {
    // no config or no auth block — fall through to the default
  }
  return "config/chatgpt-tokens.json";
}

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

function summarizeAccount(account: ChatGptAccount): string {
  const expires = account.expiresAtMs > Date.now()
    ? `expires in ${Math.round((account.expiresAtMs - Date.now()) / 60000)} min`
    : `${YELLOW}expired${RESET}`;
  const state = account.enabled ? GREEN : RED;
  return [
    `  ${state}${maskSecret(account.accountId)}${RESET}`,
    account.email ? `<${account.email}>` : "",
    account.plan ? `[${account.plan}]` : "",
    account.enabled ? "enabled" : "DISABLED (re-login required)",
    expires,
  ]
    .filter(Boolean)
    .join("  ");
}

/** Build an account entry from a fresh token response (login or import). */
async function accountFromTokens(tokens: {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}): Promise<ChatGptAccount> {
  const claims = extractChatgptAuthClaim(tokens.access_token);
  const idClaims = tokens.id_token
    ? extractChatgptAuthClaim(tokens.id_token)
    : undefined;
  const accountId = claims.accountId ?? idClaims?.accountId;
  const refreshToken = tokens.refresh_token;
  if (!accountId) {
    throw new Error("token response carries no chatgpt_account_id claim");
  }
  if (!refreshToken) {
    throw new Error("token response carries no refresh_token (offline_access missing?)");
  }
  return {
    accountId,
    email: claims.email ?? idClaims?.email,
    plan: claims.plan ?? idClaims?.plan,
    accessToken: tokens.access_token,
    refreshToken,
    idToken: tokens.id_token,
    expiresAtMs:
      claims.expiresAtMs ??
      Date.now() + (tokens.expires_in && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000,
    obtainedAtMs: Date.now(),
    enabled: true,
  };
}

async function runLogin(store: ChatGptTokenStore, noOpen: boolean): Promise<void> {
  const pkce = generatePkce();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({
    codeChallenge: pkce.codeChallenge,
    state,
    promptLogin: true,
  });

  // The callback server MUST bind the exact port the registered redirect
  // URI points at — a busy 1455 is a hard stop with actionable guidance.
  const callbackPromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404).end("waiting for /auth/callback");
          return;
        }
        const code = url.searchParams.get("code");
        const callbackState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<h3>Login failed: ${error}</h3>`);
          server.close();
          reject(new Error(`authorize error: ${error}`));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h3>Signed in to ChatGPT &#9989;</h3><p>You can close this tab and go back to the terminal.</p>",
        );
        server.close();
        if (!code || callbackState !== state) {
          reject(new Error("callback missing code or state mismatch"));
          return;
        }
        resolve({ code, state: callbackState });
      });
      server.on("error", (err) => {
        reject(
          new Error(
            `could not bind callback port ${CHATGPT_OAUTH_CALLBACK_PORT} (${(err as NodeJS.ErrnoException).code}). ` +
              `The redirect URI is fixed to localhost:${CHATGPT_OAUTH_CALLBACK_PORT} — free the port (or stop the running Codex login) and retry.`,
          ),
        );
      });
      server.listen(CHATGPT_OAUTH_CALLBACK_PORT, "localhost");
      setTimeout(() => {
        server.close();
        reject(new Error("login timed out after 5 minutes"));
      }, 5 * 60 * 1000).unref();
    },
  );

  info("");
  info(`${BOLD}Sign in with ChatGPT${RESET} — opening your browser…`);
  info("");
  info(`  ${CYAN}${authorizeUrl}${RESET}`);
  info("");
  info(`${DIM}Complete the sign-in there; this tool waits on http://localhost:${CHATGPT_OAUTH_CALLBACK_PORT}/auth/callback.${RESET}`);
  if (!noOpen) openBrowser(authorizeUrl);

  const { code } = await callbackPromise;
  ok("authorization code received — exchanging tokens…");
  const tokens = await exchangeAuthorizationCode({
    code,
    codeVerifier: pkce.codeVerifier,
  });
  const account = await accountFromTokens(tokens);
  store.upsert(account);

  const accounts = store.load();
  info("");
  ok(`Signed in as ${account.email ?? maskSecret(account.accountId)}${account.plan ? ` (${account.plan})` : ""}`);
  if (account.plan === "free") {
    info(`  ${DIM}Free plan: a smaller model catalog (gpt-reserve / gpt-5.6 / gpt-6 family) and lower quotas apply.${RESET}`);
  }
  summarizeAccounts(accounts);
  info("");
  info(`  Token store: ${DIM}${store.filePath}${RESET} (mode 0600)`);
  info(`  ${BOLD}Restart the shim to activate:${RESET} npm start`);
  if (accounts.length > 1) {
    info(`  ${DIM}Multiple accounts rotate automatically like API keys; add more by re-running this command in another browser profile.${RESET}`);
  }
}

function summarizeAccounts(accounts: ChatGptAccount[]): void {
  if (accounts.length === 0) {
    warn("  No signed-in ChatGPT accounts. Run: npm run chatgpt:login");
    return;
  }
  info(`  Signed-in accounts (${accounts.length}):`);
  for (const account of accounts) {
    info(summarizeAccount(account));
  }
}

async function runLogout(store: ChatGptTokenStore, args: Args): Promise<void> {
  const accounts = store.load();
  if (accounts.length === 0) {
    warn("No signed-in accounts — nothing to do.");
    return;
  }
  let selected: ChatGptAccount[];
  if (args.all) {
    selected = accounts;
  } else if (args.account) {
    const match = accounts.filter(
      (a) => a.accountId === args.account || maskSecret(a.accountId) === args.account,
    );
    if (match.length === 0) {
      fail(`no account matches "${args.account}". Signed-in:\n${accounts.map((a) => `  ${a.accountId}`).join("\n")}`);
    }
    selected = match;
  } else {
    info("Signed-in accounts:");
    summarizeAccounts(accounts);
    info("");
    info(`Use ${BOLD}--all${RESET} to log out everywhere, or ${BOLD}--account <id>${RESET} for one.`);
    return;
  }
  for (const account of selected) {
    info(`Revoking ${maskSecret(account.accountId)}…`);
    const revoked = await revokeRefreshToken({ refreshToken: account.refreshToken });
    if (!revoked) warn(`  revocation endpoint did not confirm (removing locally anyway)`);
    store.remove(account.accountId);
    ok(`  removed ${maskSecret(account.accountId)}`);
  }
  summarizeAccounts(store.load());
  info("");
  info(`  ${BOLD}Restart the shim to apply:${RESET} npm start`);
}

async function runStatus(store: ChatGptTokenStore, listModels: boolean): Promise<void> {
  const accounts = store.load();
  info("");
  info(`${BOLD}ChatGPT accounts${RESET} — token store: ${store.filePath}`);
  info("");
  summarizeAccounts(accounts);
  const usable = accounts.filter((a) => a.enabled).length;
  const free = accounts.filter((a) => a.enabled && a.plan === "free").length;
  info("");
  if (usable > 0) {
    info(`  ${GREEN}${usable} usable${RESET} — the chatgpt provider is ${usable > 1 ? "rotating across" : "using"} these account(s).`);
    if (free > 0) {
      info(`  ${DIM}Free-plan account(s): a smaller model catalog (gpt-reserve / gpt-5.6 / gpt-6 family) and lower quotas apply — but they work.${RESET}`);
    }
  } else {
    warn(`  No usable accounts. Run: npm run chatgpt:login`);
  }
  if (listModels && accounts.some((a) => a.enabled)) {
    await listBackendModels(accounts.find((a) => a.enabled)!);
  }
}

/** Best-effort: list the models this account may use on the Codex backend. */
async function listBackendModels(account: ChatGptAccount): Promise<void> {
  info("");
  info(`${BOLD}Models available to ${account.email ?? maskSecret(account.accountId)}:${RESET}`);
  try {
    const resp = await fetch(
      // client_version gates the catalog: old versions return an empty list.
      "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      {
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "chatgpt-account-id": account.accountId,
          Accept: "application/json",
        },
      },
    );
    if (!resp.ok) {
      warn(`  model list unavailable (HTTP ${resp.status})`);
      return;
    }
    const data = (await resp.json()) as { models?: Array<{ slug?: string; title?: unknown }> };
    const models = data.models ?? [];
    if (models.length === 0) {
      warn("  model list empty");
      return;
    }
    for (const m of models) {
      const title = typeof m.title === "string" && m.title !== m.slug ? ` — ${m.title}` : "";
      info(`  ${CYAN}${m.slug ?? "?"}${RESET}${DIM}${title}${RESET}`);
    }
    info(`${DIM}  Map these ids in the chatgpt provider's models block of config/config.json.${RESET}`);
  } catch (err) {
    warn(`  model list unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function runImport(store: ChatGptTokenStore, refreshToken: string): Promise<void> {
  info("Validating refresh token against the token endpoint…");
  const tokens = await refreshAccessToken({ refreshToken });
  const account = await accountFromTokens(tokens);
  store.upsert(account);
  ok(`Imported ${account.email ?? maskSecret(account.accountId)}`);
  summarizeAccounts(store.load());
  info(`  ${BOLD}Restart the shim to activate:${RESET} npm start`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new ChatGptTokenStore(resolveTokenFile(args.tokenFile));

  switch (args.command) {
    case "login":
      await runLogin(store, args.noOpen);
      break;
    case "logout":
      await runLogout(store, args);
      break;
    case "status":
      await runStatus(store, args.models);
      break;
    case "import":
      await runImport(store, args.refreshToken!);
      break;
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
