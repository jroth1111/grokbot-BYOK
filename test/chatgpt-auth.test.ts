/**
 * Unit tests for the "Sign in with ChatGPT" OAuth module
 * (src/providers/chatgpt-oauth.ts): PKCE, JWT claim parsing, the
 * multi-account token store, and the token manager's refresh lifecycle
 * against a mock token endpoint.
 */
import { describe, it, expect, afterAll } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  buildAuthorizeUrl,
  ChatGptTokenManager,
  ChatGptTokenStore,
  extractChatgptAuthClaim,
  generatePkce,
  parseJwtClaims,
  type ChatGptAccount,
} from "../src/providers/chatgpt-oauth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Unsigned JWT carrying the OpenAI auth claim (signature irrelevant — we
 *  only parse claims, never verify). */
function fakeAccessJwt(accountId: string, expiresInSeconds = 3600): string {
  return [
    b64url({ alg: "none", typ: "JWT" }),
    b64url({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan: "plus" },
      email: `${accountId}@example.com`,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
    "sig",
  ].join(".");
}

function makeAccount(overrides: Partial<ChatGptAccount> = {}): ChatGptAccount {
  return {
    accountId: "acct-1",
    accessToken: fakeAccessJwt("acct-1"),
    refreshToken: "rt-1",
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    obtainedAtMs: Date.now(),
    enabled: true,
    ...overrides,
  };
}

function tempTokenFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "byok-oauth-")), name);
}

/** Mock OAuth token endpoint. Refresh tokens containing "revoked" get
 *  invalid_grant; everything else rotates to a fresh access token. */
interface TokenMock {
  server: http.Server;
  url: string;
  calls: { refreshToken: string; grantType: string }[];
}

function startTokenMock(): Promise<TokenMock> {
  return new Promise((resolve, reject) => {
    const calls: TokenMock["calls"] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const refreshToken = params.get("refresh_token") ?? "";
        const grantType = params.get("grant_type") ?? "";
        calls.push({ refreshToken, grantType });
        if (refreshToken.includes("revoked")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        // Echo back the account encoded in the refresh token ("rt-ok-acct-1").
        const accountMatch = refreshToken.match(/acct-\d+/);
        const accountId = accountMatch ? accountMatch[0] : "acct-1";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: fakeAccessJwt(accountId),
            refresh_token: `${refreshToken}-rotated`,
            id_token: undefined,
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, url: `http://127.0.0.1:${addr.port}/oauth/token`, calls });
      } else {
        reject(new Error("token mock did not bind"));
      }
    });
  });
}

const startedServers: http.Server[] = [];
afterAll(() => {
  for (const server of startedServers) {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// PKCE + authorize URL
// ---------------------------------------------------------------------------

describe("PKCE", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    const expected = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    expect(codeChallenge).toBe(expected);
  });

  it("builds the authorize URL with Codex client id + fixed redirect", () => {
    const url = buildAuthorizeUrl({ codeChallenge: "chal", state: "st" });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://auth.openai.com");
    expect(parsed.pathname).toBe("/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("chal");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("st");
    expect(parsed.searchParams.get("scope")).toContain("offline_access");
    expect(parsed.searchParams.get("prompt")).toBe("login");
  });
});

// ---------------------------------------------------------------------------
// JWT claims
// ---------------------------------------------------------------------------

describe("parseJwtClaims / extractChatgptAuthClaim", () => {
  it("extracts account id, email, plan and expiry", () => {
    const token = fakeAccessJwt("acct-42");
    const claims = extractChatgptAuthClaim(token);
    expect(claims.accountId).toBe("acct-42");
    expect(claims.email).toBe("acct-42@example.com");
    expect(claims.plan).toBe("plus");
    expect(claims.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("prefers chatgpt_plan_type and falls back to legacy chatgpt_plan", () => {
    const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const jwt = (auth: object) =>
      [b64({ alg: "none" }), b64({ "https://api.openai.com/auth": auth }), "s"].join(".");
    expect(
      extractChatgptAuthClaim(jwt({ chatgpt_account_id: "a1", chatgpt_plan_type: "pro" })).plan,
    ).toBe("pro");
    expect(
      extractChatgptAuthClaim(jwt({ chatgpt_account_id: "a1", chatgpt_plan: "team" })).plan,
    ).toBe("team");
    expect(
      extractChatgptAuthClaim(jwt({ chatgpt_account_id: "a1", chatgpt_plan_type: "free" })).plan,
    ).toBe("free");
  });

  it("returns undefined for malformed tokens", () => {
    expect(parseJwtClaims("not-a-jwt")).toBeUndefined();
    expect(parseJwtClaims("a.!!!.c")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

describe("ChatGptTokenStore", () => {
  it("hydrates email/plan/expiry from the stored access token on load", () => {
    const file = tempTokenFile("tokens.json");
    const account = makeAccount();
    // Email already present, plan missing — plan must STILL be derived
    // (this is the shape the login CLI writes before plan capture existed).
    const stripped = { ...account, email: "known@example.com", plan: undefined };
    new ChatGptTokenStore(file).upsert(stripped);
    const loaded = new ChatGptTokenStore(file).load()[0];
    expect(loaded.plan).toBe("plus");
    expect(loaded.email).toBe("known@example.com");
    expect(loaded.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("round-trips accounts and replaces by accountId on upsert", () => {
    const file = tempTokenFile("tokens.json");
    const store = new ChatGptTokenStore(file);
    store.upsert(makeAccount());
    store.upsert(makeAccount({ accountId: "acct-2", refreshToken: "rt-2" }));
    store.upsert(makeAccount({ accessToken: "new-token" }));
    const accounts = store.load();
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.accountId === "acct-1")?.accessToken).toBe("new-token");
  });

  it("writes mode 0600 and drops corrupt entries on load", () => {
    const file = tempTokenFile("tokens.json");
    const store = new ChatGptTokenStore(file);
    store.upsert(makeAccount());
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [{ garbage: true }] }));
    expect(new ChatGptTokenStore(file).load()).toEqual([]);
  });

  it("removes accounts by id", () => {
    const file = tempTokenFile("tokens.json");
    const store = new ChatGptTokenStore(file);
    store.upsert(makeAccount());
    expect(store.remove("acct-1")).toBe(true);
    expect(store.remove("acct-1")).toBe(false);
    expect(store.load()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Token manager (against the mock token endpoint)
// ---------------------------------------------------------------------------

describe("ChatGptTokenManager", () => {
  it("refreshes near-expiry tokens, rotates the refresh token, and persists", async () => {
    const tokenMock = await startTokenMock();
    startedServers.push(tokenMock.server);
    const file = tempTokenFile("tokens.json");
    new ChatGptTokenStore(file).upsert(
      makeAccount({ refreshToken: "rt-ok-acct-1", expiresAtMs: Date.now() + 30_000 }),
    );
    const manager = new ChatGptTokenManager({ tokenFile: file, endpoints: { tokenUrl: tokenMock.url } });

    const { accessToken } = await manager.getValidAccessToken("acct-1");
    expect(accessToken).not.toBe("");
    expect(tokenMock.calls).toHaveLength(1);
    expect(tokenMock.calls[0].grantType).toBe("refresh_token");
    // Rotated refresh token persisted; new expiry pushed out.
    const persisted = new ChatGptTokenStore(file).load()[0];
    expect(persisted.refreshToken).toBe("rt-ok-acct-1-rotated");
    expect(persisted.expiresAtMs).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
  });

  it("skips refresh when the token is comfortably valid", async () => {
    const tokenMock = await startTokenMock();
    startedServers.push(tokenMock.server);
    const file = tempTokenFile("tokens.json");
    const account = makeAccount({ expiresAtMs: Date.now() + 55 * 60 * 1000 });
    new ChatGptTokenStore(file).upsert(account);
    const manager = new ChatGptTokenManager({ tokenFile: file, endpoints: { tokenUrl: tokenMock.url } });

    const { accessToken } = await manager.getValidAccessToken("acct-1");
    expect(accessToken).toBe(account.accessToken);
    expect(tokenMock.calls).toHaveLength(0);
  });

  it("single-flights concurrent refreshes into one token call", async () => {
    const tokenMock = await startTokenMock();
    startedServers.push(tokenMock.server);
    const file = tempTokenFile("tokens.json");
    new ChatGptTokenStore(file).upsert(
      makeAccount({ refreshToken: "rt-ok-acct-1", expiresAtMs: Date.now() + 30_000 }),
    );
    const manager = new ChatGptTokenManager({ tokenFile: file, endpoints: { tokenUrl: tokenMock.url } });

    const [a, b] = await Promise.all([
      manager.getValidAccessToken("acct-1"),
      manager.getValidAccessToken("acct-1"),
    ]);
    expect(a.accessToken).toBe(b.accessToken);
    expect(tokenMock.calls).toHaveLength(1);
  });

  it("disables the account on invalid_grant and persists the state", async () => {
    const tokenMock = await startTokenMock();
    startedServers.push(tokenMock.server);
    const file = tempTokenFile("tokens.json");
    new ChatGptTokenStore(file).upsert(
      makeAccount({ refreshToken: "rt-revoked-acct-1", expiresAtMs: Date.now() + 30_000 }),
    );
    const manager = new ChatGptTokenManager({ tokenFile: file, endpoints: { tokenUrl: tokenMock.url } });

    expect(manager.hasEnabledAccount()).toBe(true);
    await expect(manager.getValidAccessToken("acct-1")).rejects.toThrow(/re-login|disabled/i);
    expect(manager.hasEnabledAccount()).toBe(false);
    expect(manager.getKeyInfos()).toEqual([]);
    const persisted = new ChatGptTokenStore(file).load()[0];
    expect(persisted.enabled).toBe(false);
  });

  it("force-refresh works regardless of expiry and surfaces transient failures as false", async () => {
    const tokenMock = await startTokenMock();
    startedServers.push(tokenMock.server);
    const file = tempTokenFile("tokens.json");
    new ChatGptTokenStore(file).upsert(
      makeAccount({ refreshToken: "rt-ok-acct-1", expiresAtMs: Date.now() + 55 * 60 * 1000 }),
    );
    const manager = new ChatGptTokenManager({ tokenFile: file, endpoints: { tokenUrl: tokenMock.url } });
    expect(await manager.forceRefresh("acct-1")).toBe(true);
    expect(tokenMock.calls).toHaveLength(1);

    // Unknown endpoint port → network error → false, account stays enabled.
    const deadManager = new ChatGptTokenManager({
      tokenFile: file,
      endpoints: { tokenUrl: "http://127.0.0.1:9/oauth/token" },
    });
    expect(await deadManager.forceRefresh("acct-1")).toBe(false);
    expect(deadManager.hasEnabledAccount()).toBe(true);
  });

  it("exposes enabled accounts as KeyInfos for rotation", () => {
    const file = tempTokenFile("tokens.json");
    new ChatGptTokenStore(file).upsert(makeAccount());
    new ChatGptTokenStore(file).upsert(
      makeAccount({ accountId: "acct-2", refreshToken: "rt-2", weight: 5 }),
    );
    new ChatGptTokenStore(file).upsert(
      makeAccount({ accountId: "acct-3", refreshToken: "rt-3", enabled: false }),
    );
    const manager = new ChatGptTokenManager({ tokenFile: file });
    const keys = manager.getKeyInfos();
    expect(keys.map((k) => k.value).sort()).toEqual(["acct-1", "acct-2"]);
    expect(keys.find((k) => k.value === "acct-2")?.weight).toBe(5);
  });

  it("includes free-tier accounts in rotation (backend serves them a smaller catalog, not a block)", () => {
    const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const planJwt = (id: string, plan: string) =>
      [
        b64({ alg: "none" }),
        b64({ "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: plan } }),
        "s",
      ].join(".");
    const base = {
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      obtainedAtMs: Date.now(),
      enabled: true,
    };

    const file = tempTokenFile("tokens.json");
    new ChatGptTokenStore(file).upsert({
      accountId: "free-1",
      accessToken: planJwt("free-1", "free"),
      refreshToken: "rt-free-1",
      ...base,
    });
    new ChatGptTokenStore(file).upsert(
      makeAccount({ accountId: "plus-1", refreshToken: "rt-plus-1" }),
    );
    const manager = new ChatGptTokenManager({ tokenFile: file });
    // Both rotate — plan only affects the backend-side catalog/quotes.
    expect(manager.getKeyInfos().map((k) => k.value).sort()).toEqual(["free-1", "plus-1"]);
    expect(manager.hasEnabledAccount()).toBe(true);

    // Disabled accounts (re-login required) stay excluded regardless of plan.
    new ChatGptTokenStore(file).upsert({
      accountId: "dead-1",
      accessToken: planJwt("dead-1", "pro"),
      refreshToken: "rt-dead-1",
      ...base,
      enabled: false,
    });
    const reloaded = new ChatGptTokenManager({ tokenFile: file });
    expect(reloaded.getKeyInfos().map((k) => k.value).sort()).toEqual(["free-1", "plus-1"]);
  });
});
