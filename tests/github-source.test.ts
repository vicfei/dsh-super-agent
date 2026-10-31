import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { GitHubClient, type GhIssue, type GhIssueComment, type GhPull, type GhReviewComment } from "../src/github/client.js";
import { GitHubSource } from "../src/github/source.js";
import { FileSourceState } from "../src/github/state.js";
import { classify } from "../src/runner.js";

// ── fixtures: newest-first, as GitHub returns them ──────────────────────────

const issue: GhIssue = { id: 20, number: 5, user: { login: "alice", type: "User" }, title: "t", body: "help @agent please", created_at: "2026-11-01T01:00:00Z" };
const prLeak: GhIssue = { ...issue, id: 30, number: 7, pull_request: {} }; // PRs leak into /issues
const comment: GhIssueComment = { id: 300, user: { login: "alice", type: "User" }, body: "no mention here", created_at: "2026-11-01T02:00:00Z", issue_url: "https://api.github.com/repos/o/r/issues/5" };
const pull: GhPull = { id: 31, number: 7, user: { login: "bob", type: "User" }, title: "p", body: "draft", created_at: "2026-11-01T03:00:00Z" };
const review: GhReviewComment = { id: 400, user: { login: "x-bot[bot]", type: "User" }, body: "nit: @Agent check this", created_at: "2026-11-01T04:00:00Z", pull_request_url: "https://api.github.com/repos/o/r/pulls/7" };

const policy: Policy = {
  version: 1,
  allowedList: ["alice", "bob"],
  botList: [],
  acceptMode: "observe",
  table: ["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci"].map((s) => ({
    scope: s as never,
    listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const,
    unlistedNotAddressing: "ignore" as const,
  })),
};

let dir: string;
let posted: { url: string; auth?: string; body: unknown }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-src-"));
  posted = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeClient(items: { issues?: GhIssue[]; comments?: GhIssueComment[]; pulls?: GhPull[]; reviews?: GhReviewComment[] }) {
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = url.toString();
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    if (u.endsWith("/repos/o/r/issues?state=all&sort=created&direction=desc&per_page=50")) return json(items.issues ?? []);
    if (u.endsWith("/repos/o/r/issues/comments?state=all&sort=created&direction=desc&per_page=50")) return json(items.comments ?? []);
    if (u.endsWith("/repos/o/r/pulls?state=all&sort=created&direction=desc&per_page=50")) return json(items.pulls ?? []);
    if (u.endsWith("/repos/o/r/pulls/comments?state=all&sort=created&direction=desc&per_page=50")) return json(items.reviews ?? []);
    if (u.includes("/repos/o/r/issues/5/comments") && init?.method === "POST") {
      posted.push({ url: u, auth: init.headers ? (init.headers as Record<string, string>).authorization : undefined, body: JSON.parse(String(init.body)) });
      return json({ id: 999 });
    }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${u}`);
  });
  return new GitHubClient({ token: "t0", fetchImpl: fetchImpl as unknown as typeof fetch });
}

function makeSource(client: GitHubClient, stateFile = join(dir, "state.json")) {
  return { source: new GitHubSource({ repo: "o/r", agentLogin: "agent", client, state: new FileSourceState(stateFile) }), stateFile };
}

describe("GitHubSource.poll", () => {
  it("maps every feed to triggers with ids, threads, addressing, bots", async () => {
    const { source } = makeSource(makeClient({ issues: [prLeak, issue], comments: [comment], pulls: [pull], reviews: [review] }));
    const out = await source.poll();
    const byId = Object.fromEntries(out.map((t) => [t.id, t]));

    expect(out).toHaveLength(4); // PR leak filtered from issues feed
    expect(byId["github:issue:20"]).toMatchObject({ scope: "issue", threadId: "github:o/r/issues/5", addressing: true, author: { login: "alice", isBot: false } });
    expect(byId["github:issue_comment:300"]).toMatchObject({ scope: "issue_comment", threadId: "github:o/r/issues/5", addressing: false });
    expect(byId["github:pr:31"]).toMatchObject({ scope: "pr", threadId: "github:o/r/pulls/7" });
    expect(byId["github:review_comment:400"]).toMatchObject({ scope: "review_comment", threadId: "github:o/r/pulls/7", addressing: true, author: { login: "x-bot[bot]", isBot: true } }); // [bot] suffix + case-insensitive mention
  });

  it("second poll returns nothing (positions advanced)", async () => {
    const { source } = makeSource(makeClient({ issues: [issue], comments: [comment] }));
    expect(await source.poll()).toHaveLength(2);
    expect(await source.poll()).toHaveLength(0);
  });

  it("restart with same state file never replays", async () => {
    const client = makeClient({ issues: [issue], comments: [comment], pulls: [pull], reviews: [review] });
    const { source, stateFile } = makeSource(client);
    expect(await source.poll()).toHaveLength(4);
    const revived = new GitHubSource({ repo: "o/r", agentLogin: "agent", client, state: new FileSourceState(stateFile) });
    expect(await revived.poll()).toHaveLength(0);
  });

  it("only items newer than the position come through", async () => {
    const newer: GhIssueComment = { ...comment, id: 301, body: "fresh" };
    const { source } = makeSource(makeClient({ comments: [newer, comment] }));
    const first = await source.poll();
    expect(first.map((t) => t.id)).toEqual(["github:issue_comment:301", "github:issue_comment:300"]);
    const grown = makeSource(makeClient({ comments: [{ ...comment, id: 302 }, newer, comment] }));
    const second = await grown.source.poll();
    expect(second.map((t) => t.id)).toEqual(["github:issue_comment:302"]);
  });

  it("missing user maps to bot ghost (fail-closed author)", async () => {
    const anon: GhIssue = { ...issue, id: 21, user: null };
    const { source } = makeSource(makeClient({ issues: [anon] }));
    const out = await source.poll();
    expect(out[0].author).toMatchObject({ login: "ghost", isBot: true });
  });

  it("collect excludes the agent's own posted comments (self-echo filter)", async () => {
    const client = makeClient({ comments: [comment] });
    const source = new GitHubSource({ repo: "o/r", agentLogin: "agent", client });
    const from = { positions: { issue: 0, issue_comment: 0, pr: 0, review_comment: 0 } };
    const { triggers } = await source.collect(from, { exclude: new Set(["github:issue_comment:300"]) });
    expect(triggers).toHaveLength(0); // own comment dropped, position still advances
    const all = await source.collect(from);
    expect(all.triggers).toHaveLength(1);
  });
});

describe("gate integration through classify()", () => {
  const trig = (t: Partial<Trigger>): Trigger => ({
    id: "github:issue:1", source: "github", scope: "issue", threadId: "github:o/r/issues/5",
    author: { login: "alice", isBot: false }, addressing: false, body: "", ts: "2026-11-01T00:00:00Z", ...t,
  });

  it("listed addressing → explicit accept even in observe", () => {
    expect(classify(trig({ addressing: true }), policy, "negative").resolution).toMatchObject({ action: "accept", strength: "explicit" });
  });

  it("listed not addressing → inferred shadow in observe (nothing executes)", () => {
    expect(classify(trig({}), policy, "positive").resolution).toMatchObject({ action: "shadow", wouldAccept: true });
  });

  it("unlisted addressing → not admitted", () => {
    const r = classify(trig({ author: { login: "eve", isBot: false }, addressing: true }), policy, "positive");
    expect(r.resolution).toMatchObject({ action: "reject" });
  });
});

describe("delivery", () => {
  it("posts into the originating thread with auth and body", async () => {
    const client = makeClient({});
    await client.postIssueComment("o/r", 5, "recorded.");
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toContain("/repos/o/r/issues/5/comments");
    expect(posted[0].auth).toBe("Bearer t0");
    expect(posted[0].body).toEqual({ body: "recorded." });
  });
});
