/**
 * Unit tests for the Claude and Antigravity OAuth modules and the
 * priority (fill-first) account selection.
 */
import { describe, it, expect, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ClaudeTokenManager,
  buildClaudeAuthorizeUrl,
  exchangeClaudeCode,
  refreshClaudeToken,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URI,
  type ClaudeAccount,
} from "../src/providers/claude-oauth.js";
import {
  AntigravityTokenManager,
  buildAntigravityAuthorizeUrl,
  exchangeAntigravityCode,
  onboardAntigravity,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
} from "../src/providers/antigravity-oauth.js";
import { BaseProvider } from "../src/providers/base.js";
import { OAuthError } from "../src/providers/oauth-core.js";
import type { ProviderConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempTokenFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "byok-oauth2-")), name);
}

interface MockServer {
  server: http.Server;
  url: string;
  requests: { method: string; url: string; body: string }[];
}

function startMock(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse, requests: { method: string; url: string; body: string }[]) => void): Promise<MockServer> {
  const requests: { method: string; url: string; body: string }[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        handler(req, body, res, requests);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests });
    });
  });
}

const started: http.Server[] = [];
afterAll(() => {
  for (const server of started) server.close();
});

// ---------------------------------------------------------------------------
// Claude OAuth
// ---------------------------------------------------------------------------

describe("Claude OAuth", () => {
  it("builds the authorize URL with the native parameter order and PKCE", () => {
    const url = buildClaudeAuthorizeUrl({ state: "st", codeChallenge: "chal" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(parsed.searchParams.get("code")).toBe("true");
    expect(parsed.searchParams.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(CLAUDE_OAUTH_REDIRECT_URI);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.indexOf("code=true")).toBeLessThan(url.indexOf("client_id"));
  });

  it("exchanges codes with the native JSON field order", async () => {
    const mock = await startMock((_req, body, res) => {
      expect(body.startsWith('{"grant_type":"authorization_code","code":')).toBe(true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          account: { uuid: "acc-1", email_address: "u@example.com" },
          organization: { uuid: "org-1", name: "Org" },
        }),
      );
    });
    started.push(mock.server);
    const tokens = await exchangeClaudeCode({
      code: "c1",
      state: "st",
      codeVerifier: "v1",
      endpoints: { tokenUrl: `${mock.url}/token` },
    });
    expect(tokens.access_token).toBe("at-1");
    expect(tokens.account?.uuid).toBe("acc-1");
  });

  it("keeps the old refresh token when the grant omits one", async () => {
    const mock = await startMock((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "at-2", expires_in: 3600 }));
    });
    started.push(mock.server);
    const file = tempTokenFile("claude.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: "acc-1",
            accessToken: "at-1",
            refreshToken: "rt-old",
            expiresAtMs: Date.now() + 30_000,
            obtainedAtMs: Date.now(),
            enabled: true,
          },
        ],
      }),
    );
    const manager = new ClaudeTokenManager({
      tokenFile: file,
      endpoints: { tokenUrl: `${mock.url}/token` },
    });
    const { accessToken } = await manager.getValidAccessToken("acc-1");
    expect(accessToken).toBe("at-2");
    // Persisted entry keeps the original refresh token.
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")).accounts[0];
    expect(persisted.refreshToken).toBe("rt-old");
    expect(persisted.accessToken).toBe("at-2");
  });

  it("attaches Bearer + anthropic-version + oauth beta headers", async () => {
    const file = tempTokenFile("claude2.json");
    const account: ClaudeAccount = {
      accountId: "acc-9",
      accessToken: "tok",
      refreshToken: "rt",
      expiresAtMs: Date.now() + 55 * 60 * 1000,
      obtainedAtMs: Date.now(),
      enabled: true,
    };
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [account] }));
    const manager = new ClaudeTokenManager({ tokenFile: file });
    const headers = await manager.buildUpstreamHeaders("acc-9");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  });

  it("disables the account on invalid_grant refreshes", async () => {
    const mock = await startMock((_req, _body, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
    });
    started.push(mock.server);
    const file = tempTokenFile("claude3.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: "acc-1",
            accessToken: "at",
            refreshToken: "rt-dead",
            expiresAtMs: Date.now() + 30_000,
            obtainedAtMs: Date.now(),
            enabled: true,
          },
        ],
      }),
    );
    const manager = new ClaudeTokenManager({
      tokenFile: file,
      endpoints: { tokenUrl: `${mock.url}/token` },
    });
    await expect(manager.getValidAccessToken("acc-1")).rejects.toThrow(/re-login|disabled/i);
    expect(manager.hasEnabledAccount()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Antigravity OAuth
// ---------------------------------------------------------------------------

describe("Antigravity OAuth", () => {
  it("builds the Google authorize URL with offline access + consent", () => {
    const url = buildAntigravityAuthorizeUrl({ state: "st" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(ANTIGRAVITY_REDIRECT_URI);
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("scope")).toBe(ANTIGRAVITY_SCOPES.join(" "));
  });

  it("exchanges codes with the installed-app secret (form body)", async () => {
    const mock = await startMock((req, body, res) => {
      expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(body);
      expect(params.get("client_secret")).toBeDefined();
      expect(params.get("grant_type")).toBe("authorization_code");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    });
    started.push(mock.server);
    const tokens = await exchangeAntigravityCode({
      code: "c",
      tokenEndpoint: `${mock.url}/token`,
    });
    expect(tokens.refresh_token).toBe("rt");
  });

  it("onboards via loadCodeAssist when the project already exists", async () => {
    const mock = await startMock((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ cloudaicompanionProject: "proj-77", allowedTiers: [] }),
      );
    });
    started.push(mock.server);
    const { projectId, tier } = await onboardAntigravity({
      accessToken: "tok",
      apiBase: mock.url,
    });
    expect(projectId).toBe("proj-77");
    expect(mock.requests[0].url).toContain("loadCodeAssist");
    expect(tier).toBe("free-tier");
  });

  it("onboards via onboardUser polling when loadCodeAssist has no project", async () => {
    let onboardCalls = 0;
    const mock = await startMock((req, _body, res) => {
      if (req.url?.includes("loadCodeAssist")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ allowedTiers: [{ id: "solo-tier", isDefault: true }] }));
        return;
      }
      onboardCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (onboardCalls === 1) {
        res.end(JSON.stringify({ done: false }));
      } else {
        res.end(JSON.stringify({ done: true, response: { projectId: "proj-88" } }));
      }
    });
    started.push(mock.server);
    const { projectId, tier } = await onboardAntigravity({
      accessToken: "tok",
      apiBase: mock.url,
    });
    expect(projectId).toBe("proj-88");
    expect(tier).toBe("solo-tier");
    expect(onboardCalls).toBe(2);
  });

  it("serves dialect context (projectId) and the hub User-Agent", async () => {
    const file = tempTokenFile("ag.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: "u@example.com",
            accessToken: "tok",
            refreshToken: "rt",
            expiresAtMs: Date.now() + 55 * 60 * 1000,
            obtainedAtMs: Date.now(),
            enabled: true,
            projectId: "proj-1",
          },
        ],
      }),
    );
    const manager = new AntigravityTokenManager({ tokenFile: file });
    const headers = await manager.buildUpstreamHeaders("u@example.com");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["User-Agent"]).toMatch(/^antigravity\/hub\/\d+\.\d+\.\d+/);
    expect(await manager.accountContext?.("u@example.com")).toEqual({ projectId: "proj-1" });
    expect(manager.requestDispatcher?.()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Priority (fill-first) selection
// ---------------------------------------------------------------------------

describe("priority account selection", () => {
  const config: ProviderConfig = {
    baseUrl: "https://example.com",
    apiKey: "",
    defaultModel: "m",
    models: { m: "m" },
    keySelection: "priority",
  };

  it("always picks the preferred account and fails down without a cursor", () => {
    const provider = new BaseProvider("p", config, undefined);
    // Simulate OAuth-provided, priority-ordered keys.
    (provider as unknown as { keys: { value: string; weight: number; enabled: boolean }[] }).keys = [
      { value: "primary", weight: 1, enabled: true },
      { value: "secondary", weight: 1, enabled: true },
    ];
    expect(provider.selectKey().value).toBe("primary");
    expect(provider.selectKey().value).toBe("primary"); // no rotation
    provider.markKeyFailed(provider.keys[0]);
    expect(provider.selectKey().value).toBe("secondary");
    provider.resetKeyFailures();
    expect(provider.selectKey().value).toBe("primary");
  });

  it("managers return priority-ordered key infos", async () => {
    const file = tempTokenFile("prio.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: [
          { accountId: "b", accessToken: "t", refreshToken: "r", expiresAtMs: 1, obtainedAtMs: 1, enabled: true, priority: 200 },
          { accountId: "a", accessToken: "t", refreshToken: "r", expiresAtMs: 1, obtainedAtMs: 1, enabled: true, priority: 10 },
          { accountId: "c", accessToken: "t", refreshToken: "r", expiresAtMs: 1, obtainedAtMs: 1, enabled: true }, // default 100
          { accountId: "dead", accessToken: "t", refreshToken: "r", expiresAtMs: 1, obtainedAtMs: 1, enabled: false, priority: 1 },
        ],
      }),
    );
    const manager = new AntigravityTokenManager({ tokenFile: file });
    expect(manager.getKeyInfos().map((k) => k.value)).toEqual(["a", "c", "b"]);
  });
});

// Suppress an unused-import lint nag for OAuthError (used indirectly).
void OAuthError;
void refreshClaudeToken;
