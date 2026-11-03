// GitHub App auth (M6-2, issue #28) — real RSA keypair generated in-test: the JWT is
// signature-verified, the token exchange/cache/refresh cycle is driven against a mocked
// fetch (including installation discovery), and the client/provider integration covers
// the 401-invalidate-retry path.

import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppTokenProvider, appAuthFromEnv, signAppJwt } from "../src/github/app-auth.js";
import { GitHubClient, type TokenProvider } from "../src/github/client.js";
import { pushAuthArgs } from "../src/work.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function b64urlToJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("signAppJwt (zero-dependency RS256)", () => {
  it("carries iss=appId, a ≤10-minute window, and a verifiable signature", () => {
    const jwt = signAppJwt("123456", privateKey, new Date("2026-11-03T00:00:00Z"));
    const [header, claims, sig] = jwt.split(".");
    expect(b64urlToJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const c = b64urlToJson(claims);
    expect(c.iss).toBe("123456");
    expect(Number(c.exp) - Number(c.iat)).toBe(180);
    expect(
      createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(sig, "base64url")),
    ).toBe(true);
  });
});

interface ExchangeWorld {
  tokensIssued: number;
  expiresInSeconds: number;
  authHeaders: string[];
  discoveryCalls: number;
  failDiscoveryWith: number | null;
}

function mockFetch(w: ExchangeWorld): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = url.toString();
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    w.authHeaders.push(String((init?.headers as Record<string, string>)?.authorization ?? ""));
    if (u.endsWith("/repos/o/r/installation")) {
      w.discoveryCalls++;
      if (w.failDiscoveryWith) return json({ message: "not installed" }, w.failDiscoveryWith);
      return json({ id: 99 });
    }
    if (/\/app\/installations\/(\d+)\/access_tokens$/.test(u)) {
      w.tokensIssued++;
      return json({ token: `ghs_${w.tokensIssued}`, expires_at: new Date(Date.now() + w.expiresInSeconds * 1000).toISOString() });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
}

function world(over: Partial<ExchangeWorld> = {}): ExchangeWorld {
  return { tokensIssued: 0, expiresInSeconds: 3600, authHeaders: [], discoveryCalls: 0, failDiscoveryWith: null, ...over };
}

describe("AppTokenProvider", () => {
  it("exchanges a JWT for an installation token and caches it (one exchange, many gets)", async () => {
    const w = world();
    const p = new AppTokenProvider({ appId: "123", privateKeyPem: privateKey, installationId: 7, fetchImpl: mockFetch(w) });
    expect(await p.get()).toBe("ghs_1");
    expect(await p.get()).toBe("ghs_1");
    expect(await p.get()).toBe("ghs_1");
    expect(w.tokensIssued).toBe(1);
    // every exchange is JWT-authenticated
    expect(w.authHeaders[0].startsWith("Bearer ")).toBe(true);
    expect(w.authHeaders[0].split(" ")[1].split(".")).toHaveLength(3);
  });

  it("refreshes early: a token inside the 5-minute margin triggers a new exchange", async () => {
    const w = world({ expiresInSeconds: 60 }); // already inside the margin after caching
    const p = new AppTokenProvider({ appId: "123", privateKeyPem: privateKey, installationId: 7, fetchImpl: mockFetch(w) });
    await p.get();
    await p.get(); // 60s < margin ⇒ treated as stale
    expect(w.tokensIssued).toBe(2);
  });

  it("onAuthFailure drops the cache — the next get exchanges fresh", async () => {
    const w = world();
    const p = new AppTokenProvider({ appId: "123", privateKeyPem: privateKey, installationId: 7, fetchImpl: mockFetch(w) });
    await p.get();
    p.onAuthFailure();
    await p.get();
    expect(w.tokensIssued).toBe(2);
  });

  it("discovers the installation from the repo once, then reuses it", async () => {
    const w = world();
    const p = new AppTokenProvider({ appId: "123", privateKeyPem: privateKey, repo: "o/r", fetchImpl: mockFetch(w) });
    expect(await p.get()).toBe("ghs_1");
    p.onAuthFailure();
    expect(await p.get()).toBe("ghs_2"); // re-exchange, but no second discovery
    expect(w.discoveryCalls).toBe(1);
    expect(w.tokensIssued).toBe(2);
  });

  it("discovery failure → actionable error mentioning installation", async () => {
    const w = world({ failDiscoveryWith: 404 });
    const p = new AppTokenProvider({ appId: "123", privateKeyPem: privateKey, repo: "o/r", fetchImpl: mockFetch(w) });
    await expect(p.get()).rejects.toThrow(/is the App installed/);
  });

  it("no installation id and no repo → actionable error", async () => {
    const p = new AppTokenProvider({ appId: "123", privateKeyPem: privateKey });
    await expect(p.get()).rejects.toThrow(/GITHUB_APP_INSTALLATION_ID/);
  });
});

describe("GitHubClient with a TokenProvider", () => {
  it("every request carries the provider's token", async () => {
    const seen: string[] = [];
    const provider: TokenProvider = {
      get: async () => "ghs_static",
      onAuthFailure: () => {},
    };
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      seen.push(String((init?.headers as Record<string, string>)?.authorization));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new GitHubClient({ tokenProvider: provider, fetchImpl, apiBase: "https://api.example" });
    await client.listIssues("o/r");
    await client.listIssues("o/r");
    expect(seen).toEqual(["Bearer ghs_static", "Bearer ghs_static"]);
    await expect(client.currentToken()).resolves.toBe("ghs_static");
  });

  it("401 → invalidate once and retry; a fresh token succeeds", async () => {
    let failures = 0;
    let authFailures = 0;
    const provider: TokenProvider = {
      get: async () => (failures === 0 ? "ghs_stale" : "ghs_fresh"),
      onAuthFailure: () => { authFailures++; failures = 1; },
    };
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const auth = String((init?.headers as Record<string, string>)?.authorization);
      if (auth === "Bearer ghs_stale") return new Response("{\"message\":\"Bad credentials\"}", { status: 401 });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new GitHubClient({ tokenProvider: provider, fetchImpl, apiBase: "https://api.example" });
    await expect(client.listIssues("o/r")).resolves.toEqual([]);
    expect(authFailures).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("401 twice (PAT-style static token) still fails with the hint", async () => {
    const fetchImpl = vi.fn(async () => new Response("{\"message\":\"Bad credentials\"}", { status: 401 })) as unknown as typeof fetch;
    const client = new GitHubClient({ token: "bad", fetchImpl, apiBase: "https://api.example" });
    await expect(client.listIssues("o/r")).rejects.toThrow(/was rejected/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry without a provider
  });
});

// ── git push auth ───────────────────────────────────────────────────────────────

describe("pushAuthArgs (branch push rides the API credential)", () => {
  it("builds the x-access-token extraheader, scoped to github.com https", () => {
    const args = pushAuthArgs("tok123");
    expect(args).toEqual([
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from("x-access-token:tok123").toString("base64")}`,
    ]);
  });

  it("no token → no args (ambient git credentials, local/ssh remotes)", () => {
    expect(pushAuthArgs(undefined)).toEqual([]);
  });
});

// ── env parsing ─────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-appauth-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("appAuthFromEnv", () => {
  it("null when nothing is configured", () => {
    expect(appAuthFromEnv({})).toBeNull();
  });

  it("inline PEM with \\n escapes is restored", () => {
    const escaped = privateKey.replace(/\n/g, "\\n");
    const env = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: escaped };
    expect(appAuthFromEnv(env)).toEqual({ appId: "123", privateKeyPem: privateKey });
  });

  it("key file path works, installation id parsed", () => {
    const keyPath = join(dir, "app.pem");
    writeFileSync(keyPath, privateKey);
    const env = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: keyPath, GITHUB_APP_INSTALLATION_ID: "42" };
    expect(appAuthFromEnv(env)).toEqual({ appId: "123", privateKeyPem: privateKey, installationId: 42 });
  });

  it("half-configured (id without key) throws a setup hint", () => {
    expect(() => appAuthFromEnv({ GITHUB_APP_ID: "123" })).toThrow(/private key/);
  });

  it("non-numeric installation id throws", () => {
    const env = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_INSTALLATION_ID: "abc" };
    expect(() => appAuthFromEnv(env)).toThrow(/number/);
  });
});
