// GitHub Source — turns repo events into domain Triggers (docs/001: "A Source produces Triggers").
// Four feeds polled newest-first; an item is new iff its id exceeds the feed's read position.
// PRs leak into the issues listing (same id space) and are skipped there — the pulls feed owns them.

import type { Trigger, Scope } from "../domain.js";
import { GitHubClient } from "./client.js";
import type { Feed, SourceState, StateStore } from "./state.js";
import type { GhIssue, GhIssueComment, GhPull, GhReviewComment } from "./client.js";

const SCOPE_OF_FEED: Record<Feed, Scope> = {
  issue: "issue",
  issue_comment: "issue_comment",
  pr: "pr",
  review_comment: "review_comment",
};

export interface GitHubSourceOptions {
  /** owner/repo */
  repo: string;
  /** The agent's own login — addressing is an @mention of it (case-insensitive). */
  agentLogin: string;
  client: GitHubClient;
  /** Required only for poll(); collect() is stateless. */
  state?: StateStore;
}

/** True for App accounts and `[bot]` logins — bots cap at inferred strength in the gate. */
export function isBotActor(login: string, type: string): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

function issueNumberFromUrl(url: string): string {
  const m = url.match(/\/(?:issues|pulls)\/(\d+)$/);
  return m ? m[1] : "unknown";
}

export class GitHubSource {
  constructor(private readonly opts: GitHubSourceOptions) {}

  /**
   * Pure collection: compute triggers newer than `from` and the next state, persisting nothing.
   * The Engine ingests triggers + positions in one transaction (exactly-once); poll() is the
   * file-backed convenience wrapper kept for standalone use. `exclude` drops the agent's own
   * posted comments (docs/001: a Source "filters its own messages").
   */
  async collect(from: SourceState, opts: { exclude?: ReadonlySet<string> } = {}): Promise<{ triggers: Trigger[]; next: SourceState }> {
    const state: SourceState = { positions: { ...from.positions } };
    const out: Trigger[] = [];
    const wanted = (id: string) => !opts.exclude?.has(id);

    // Each feed compares against its position AT COLLECT START (frozen) and advances once at the
    // end — comparing against a mid-loop maximum would swallow older-but-new items (newest-first).
    const issues = await this.opts.client.listIssues(this.opts.repo);
    let start = state.positions.issue;
    let maxSeen = start;
    for (const it of issues) {
      if (it.id <= start) break;
      if (it.pull_request !== undefined) continue; // pulls feed owns PRs
      if (wanted(`github:issue:${it.id}`)) out.push(this.toTrigger("issue", it.id, it.user, it.body, it.created_at,
        `github:${this.opts.repo}/issues/${it.number}`, SCOPE_OF_FEED.issue));
      maxSeen = Math.max(maxSeen, it.id);
    }
    state.positions.issue = maxSeen;

    const comments = await this.opts.client.listIssueComments(this.opts.repo);
    start = state.positions.issue_comment;
    maxSeen = start;
    for (const it of comments) {
      if (it.id <= start) break;
      const n = issueNumberFromUrl(it.issue_url);
      if (wanted(`github:issue_comment:${it.id}`)) out.push(this.toTrigger("issue_comment", it.id, it.user, it.body, it.created_at,
        `github:${this.opts.repo}/issues/${n}`, SCOPE_OF_FEED.issue_comment));
      maxSeen = Math.max(maxSeen, it.id);
    }
    state.positions.issue_comment = maxSeen;

    const pulls = await this.opts.client.listPulls(this.opts.repo);
    start = state.positions.pr;
    maxSeen = start;
    for (const it of pulls) {
      if (it.id <= start) break;
      if (wanted(`github:pr:${it.id}`)) out.push(this.toTrigger("pr", it.id, it.user, it.body, it.created_at,
        `github:${this.opts.repo}/pulls/${it.number}`, SCOPE_OF_FEED.pr));
      maxSeen = Math.max(maxSeen, it.id);
    }
    state.positions.pr = maxSeen;

    const reviews = await this.opts.client.listReviewComments(this.opts.repo);
    start = state.positions.review_comment;
    maxSeen = start;
    for (const it of reviews) {
      if (it.id <= start) break;
      const n = issueNumberFromUrl(it.pull_request_url);
      if (wanted(`github:review_comment:${it.id}`)) out.push(this.toTrigger("review_comment", it.id, it.user, it.body, it.created_at,
        `github:${this.opts.repo}/pulls/${n}`, SCOPE_OF_FEED.review_comment));
      maxSeen = Math.max(maxSeen, it.id);
    }
    state.positions.review_comment = maxSeen;

    return { triggers: out, next: state };
  }

  /** File-backed wrapper: collect + persist positions (at-most-once across a crash). */
  async poll(): Promise<Trigger[]> {
    if (!this.opts.state) throw new Error("poll() requires a StateStore; use collect() otherwise");
    const from = this.opts.state.load();
    const { triggers, next } = await this.collect(from);
    this.opts.state.save(next); // persist before handing out — see state.ts note
    return triggers;
  }

  private toTrigger(
    feed: Feed,
    id: number,
    user: { login: string; type: string } | null,
    body: string | null,
    ts: string,
    threadId: string,
    scope: Scope,
  ): Trigger {
    const login = user?.login ?? "ghost";
    const mention = `@${this.opts.agentLogin.toLowerCase()}`;
    const addressing = (body ?? "").toLowerCase().includes(mention);
    return {
      id: `github:${feed}:${id}`,
      source: "github",
      scope,
      threadId,
      author: { login, isBot: user ? isBotActor(login, user.type) : true },
      addressing,
      body: body ?? "",
      ts,
    };
  }
}
