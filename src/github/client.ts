// GitHub REST client — thin, injectable fetch, credentials never persisted.
// v0 uses a PAT and polling; a GitHub App is a later Source-kind config, not a code path.

export interface GhActor {
  login: string;
  type: string; // "User" | "Bot" | "Organization"
}
interface GhItemBase {
  id: number;
  user: GhActor | null;
  body: string | null;
  created_at: string;
}
export interface GhIssue extends GhItemBase {
  number: number;
  title: string | null;
  /** Present ⇒ this entry is a PR that leaked into the issues feed. */
  pull_request?: unknown;
}
export interface GhIssueComment extends GhItemBase {
  /** api url of the parent issue (issues or PR conversation). */
  issue_url: string;
}
export interface GhPull extends GhItemBase {
  number: number;
  title: string | null;
}

/** Full pull detail for the merge gate (GET /repos/:o/:r/pulls/:n). */
export interface GhPullDetail {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  /** null while GitHub has not computed mergeability — treat as "not yet", fail-closed. */
  mergeable: boolean | null;
  head: { ref: string; sha: string };
  additions: number;
  deletions: number;
}

export interface GhReview {
  id: number;
  user: GhActor | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISMISSED — a reviewer's latest non-comment stance is their effective one. */
  state: string;
  commit_id: string;
  submitted_at: string;
}
export interface GhReviewComment extends GhItemBase {
  /** api url of the parent pull. */
  pull_request_url: string;
  in_reply_to_id?: number;
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: { token?: string; fetchImpl?: typeof fetch; apiBase?: string } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? "https://api.github.com";
    this.token = opts.token ?? "";
  }

  private readonly token: string;

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // The three failures a fresh install hits; the raw body alone is cryptic (M5-5).
      const hint =
        res.status === 401
          ? " — GITHUB_TOKEN was rejected: check its value / expiry"
          : res.status === 403 && /rate limit/i.test(text)
            ? " — rate limited: set GITHUB_TOKEN to raise the limit"
            : res.status === 403
              ? " — forbidden: the token may lack access to this repo"
              : "";
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}${hint}`);
    }
    return (await res.json()) as T;
  }

  /** Newest-first single page. Filtering by read position happens in the Source. */
  private list<T>(repo: string, path: string): Promise<T[]> {
    return this.request<T[]>("GET", `/repos/${repo}${path}?state=all&sort=created&direction=desc&per_page=50`);
  }

  listIssues(repo: string): Promise<GhIssue[]> {
    return this.list(repo, "/issues");
  }

  listIssueComments(repo: string): Promise<GhIssueComment[]> {
    return this.list(repo, "/issues/comments");
  }

  listPulls(repo: string): Promise<GhPull[]> {
    return this.list(repo, "/pulls");
  }

  listReviewComments(repo: string): Promise<GhReviewComment[]> {
    return this.list(repo, "/pulls/comments");
  }

  /** Delivery: write into the originating thread. */
  postIssueComment(repo: string, issueNumber: number, body: string): Promise<{ id: number }> {
    return this.request<{ id: number }>("POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body });
  }

  private defaultBranchCache = new Map<string, string>();

  async getDefaultBranch(repo: string): Promise<string> {
    const cached = this.defaultBranchCache.get(repo);
    if (cached) return cached;
    const data = await this.request<{ default_branch: string }>("GET", `/repos/${repo}`);
    this.defaultBranchCache.set(repo, data.default_branch);
    return data.default_branch;
  }

  /** Delivery: turn a pushed ticket branch into a pull request. */
  createPullRequest(repo: string, pr: { title: string; head: string; base: string; body: string }): Promise<{ number: number; html_url: string }> {
    return this.request<{ number: number; html_url: string }>("POST", `/repos/${repo}/pulls`, pr);
  }

  getPull(repo: string, number: number): Promise<GhPullDetail> {
    return this.request<GhPullDetail>("GET", `/repos/${repo}/pulls/${number}`);
  }

  listReviews(repo: string, number: number): Promise<GhReview[]> {
    return this.request<GhReview[]>("GET", `/repos/${repo}/pulls/${number}/reviews`);
  }

  /** SHA-pinned merge: if the head moved since evaluation, GitHub rejects — we never merge unreviewed bytes. */
  mergePullRequest(repo: string, number: number, opts: { sha: string; merge_method: "squash" | "merge" | "rebase" }): Promise<{ merged: boolean; sha?: string }> {
    return this.request<{ merged: boolean; sha?: string }>("PUT", `/repos/${repo}/pulls/${number}/merge`, opts);
  }

  deleteBranch(repo: string, branch: string): Promise<unknown> {
    return this.request<unknown>("DELETE", `/repos/${repo}/git/refs/heads/${branch}`);
  }
}
