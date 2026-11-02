// GitHubClient error-hint tests (M5-5, issue #19) — 401/403 get an actionable suffix;
// everything else stays a bare one-liner.

import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github/client.js";

function clientWith(status: number, body: string): GitHubClient {
  const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch;
  return new GitHubClient({ token: "t", fetchImpl, apiBase: "https://api.example" });
}

describe("GitHubClient error hints", () => {
  it("401 → token rejected hint", async () => {
    await expect(clientWith(401, '{"message":"Bad credentials"}').listIssues("a/b")).rejects.toThrow(
      /401.*GITHUB_TOKEN was rejected/,
    );
  });

  it("403 rate limit → raise-the-limit hint", async () => {
    await expect(
      clientWith(403, '{"message":"API rate limit exceeded for 1.2.3.4."}').listIssues("a/b"),
    ).rejects.toThrow(/rate limit.*set GITHUB_TOKEN to raise the limit/i);
  });

  it("403 other → repo-access hint", async () => {
    await expect(clientWith(403, '{"message":"Resource not accessible by integration"}').listIssues("a/b")).rejects.toThrow(
      /token may lack access to this repo/,
    );
  });

  it("404 stays a bare one-liner", async () => {
    await expect(clientWith(404, '{"message":"Not Found"}').listIssues("a/b")).rejects.toThrow(
      "GitHub API GET /repos/a/b/issues?state=all&sort=created&direction=desc&per_page=50 → 404: {\"message\":\"Not Found\"}",
    );
  });
});
