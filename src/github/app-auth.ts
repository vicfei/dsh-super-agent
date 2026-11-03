// GitHub App auth (M6-2, issue #28) — installation access tokens without a runtime dependency:
// the RS256 JWT is signed with node:crypto, exchanged for a 1-hour installation token, cached
// with an expiry margin, and re-exchanged transparently. A PAT stays as fallback (client just
// gets a static token); replies posted with an App token carry the app[bot] identity, which the
// gate already caps at inferred strength and the self-echo filter never re-ingests.
//
// Credentials live in the environment only (repo discipline):
//   GITHUB_APP_ID                — the App's numeric id
//   GITHUB_APP_PRIVATE_KEY       — the PEM, \n-escaped inline (or GITHUB_APP_PRIVATE_KEY_PATH)
//   GITHUB_APP_INSTALLATION_ID   — optional; discovered from --repo when absent

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // refresh a 60-minute token 5 minutes early

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** RS256 JWT for the App — GitHub accepts a maximum 10-minute window (docs: /apps/creating). */
export function signAppJwt(appId: string, privateKeyPem: string, now: Date = new Date()): string {
  const iat = Math.floor((now.getTime() - 60_000) / 1000); // 60s clock-skew allowance
  const exp = iat + 180; // 3 minutes, well under the 10-minute cap
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat, exp, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKeyPem);
  return `${header}.${claims}.${b64url(signature)}`;
}

export interface AppAuthOptions {
  appId: string;
  /** Full PEM text (BEGIN RSA PRIVATE KEY / BEGIN PRIVATE KEY). */
  privateKeyPem: string;
  /** Omit to auto-discover from `repo` on first use. */
  installationId?: number;
  /** owner/repo — used for installation discovery when installationId is absent. */
  repo?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class AppTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private installationId: number | null;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly opts: AppAuthOptions) {
    this.installationId = opts.installationId ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? "https://api.github.com";
  }

  /** Current token, exchanging/refreshing as needed. Throws with actionable messages. */
  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return this.cached.token;
    const installationId = await this.resolveInstallation();
    const res = await this.fetchImpl(`${this.apiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${signAppJwt(this.opts.appId, this.opts.privateKeyPem)}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub App token exchange failed (${res.status}): ${text.slice(0, 200)} — check GITHUB_APP_ID and the private key`);
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    this.cached = { token: data.token, expiresAt: Date.parse(data.expires_at) };
    return data.token;
  }

  /** Client 401 hook — drop the cached token so the retry exchanges a fresh one. */
  onAuthFailure(): void {
    this.cached = null;
  }

  private async resolveInstallation(): Promise<number> {
    if (this.installationId !== null) return this.installationId;
    if (!this.opts.repo) {
      throw new Error("GitHub App auth needs GITHUB_APP_INSTALLATION_ID (or a --repo to discover it from)");
    }
    const res = await this.fetchImpl(`${this.apiBase}/repos/${this.opts.repo}/installation`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${signAppJwt(this.opts.appId, this.opts.privateKeyPem)}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`cannot find an installation of this App on ${this.opts.repo} (${res.status}): ${text.slice(0, 200)} — is the App installed on the repo?`);
    }
    const data = (await res.json()) as { id: number };
    this.installationId = data.id;
    return data.id;
  }
}

export interface AppAuthEnv {
  appId: string;
  privateKeyPem: string;
  installationId?: number;
}

/** Read App credentials from the environment. Null when not configured (PAT/anonymous path). */
export function appAuthFromEnv(env: NodeJS.ProcessEnv = process.env): AppAuthEnv | null {
  const appId = env.GITHUB_APP_ID;
  const inlineKey = env.GITHUB_APP_PRIVATE_KEY;
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId) return null;
  const key = inlineKey ? inlineKey.replace(/\\n/g, "\n") : keyPath ? readFileSync(keyPath, "utf8") : undefined;
  if (!key || !key.includes("PRIVATE KEY")) {
    throw new Error("GITHUB_APP_ID is set but no private key — set GITHUB_APP_PRIVATE_KEY (\\n-escaped PEM) or GITHUB_APP_PRIVATE_KEY_PATH");
  }
  const installationId = env.GITHUB_APP_INSTALLATION_ID ? Number(env.GITHUB_APP_INSTALLATION_ID) : undefined;
  if (installationId !== undefined && !Number.isFinite(installationId)) {
    throw new Error("GITHUB_APP_INSTALLATION_ID must be a number");
  }
  return { appId, privateKeyPem: key, ...(installationId !== undefined ? { installationId } : {}) };
}
