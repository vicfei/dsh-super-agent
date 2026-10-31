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
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
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
}
