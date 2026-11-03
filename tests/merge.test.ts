// Auto-merge with delivery requirements (M6-1, issue #25) — the structural brakes:
// evaluateMerge is pure and exhaustively matrix-tested like the gate; the sweep is exercised
// against a fetch-mocked client (merge / hold / disabled / closed sync / decline / errors).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultMergePolicy } from "../src/domain.js";
import type { Policy } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { GitHubClient } from "../src/github/client.js";
import type { GhPullDetail, GhReview } from "../src/github/client.js";
import { evaluateMerge, runMergeSweep } from "../src/merge.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STALE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function pr(over: Partial<GhPullDetail> = {}): GhPullDetail {
  return {
    number: 42, state: "open", draft: false, merged: false, mergeable: true,
    head: { ref: "dsh/ticket-1", sha: HEAD }, additions: 30, deletions: 12,
    ...over,
  };
}

function review(login: string, state: string, commitId: string, opts: { at?: string; type?: string; id?: number } = {}): GhReview {
  return {
    id: opts.id ?? Math.floor(Math.random() * 100000),
    user: { login, type: opts.type ?? "User" },
    state, commit_id: commitId, submitted_at: opts.at ?? "2026-11-03T00:00:00Z",
  };
}

const mp = defaultMergePolicy(); // enabled only gates the sweep; evaluate checks the brakes
const allowed = ["alice", "bob"];

describe("evaluateMerge (structural brakes, fail-closed)", () => {
  it("happy path: allowed-list approval covering head, under cap", () => {
    const c = evaluateMerge(pr(), [review("alice", "APPROVED", HEAD)], mp, allowed);
    expect(c.ok).toBe(true);
    expect(c.reasons).toEqual([]);
    expect(c.approvedBy).toBe("alice");
    expect(c.changedLines).toBe(42);
  });

  it("no reviews → no approving review", () => {
    const c = evaluateMerge(pr(), [], mp, allowed);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual(["no approving review from an allowed-list member"]);
  });

  it("stale approval (approved at an older SHA) never merges", () => {
    const c = evaluateMerge(pr(), [review("alice", "APPROVED", STALE)], mp, allowed);
    expect(c.ok).toBe(false);
    expect(c.reasons.join(" ")).toContain("stale approvals do not count");
  });

  it("a stale approval is fine when another reviewer covers the head", () => {
    const c = evaluateMerge(pr(), [review("alice", "APPROVED", STALE), review("bob", "APPROVED", HEAD)], mp, allowed);
    expect(c.ok).toBe(true);
    expect(c.approvedBy).toBe("bob");
  });

  it("over the line cap holds", () => {
    const c = evaluateMerge(pr({ additions: 180, deletions: 40 }), [review("alice", "APPROVED", HEAD)], mp, allowed);
    expect(c.ok).toBe(false);
    expect(c.reasons.join(" ")).toContain("220 lines > cap 200");
  });

  it("CHANGES_REQUESTED by an allowed-list member vetoes despite an approval", () => {
    const c = evaluateMerge(pr(), [review("alice", "APPROVED", HEAD), review("bob", "CHANGES_REQUESTED", HEAD)], mp, allowed);
    expect(c.ok).toBe(false);
    expect(c.reasons.join(" ")).toContain("changes requested by @bob");
  });

  it("veto cleared when the same reviewer re-approves later", () => {
    const c = evaluateMerge(pr(), [
      review("bob", "CHANGES_REQUESTED", HEAD, { at: "2026-11-03T01:00:00Z", id: 2 }),
      review("bob", "APPROVED", HEAD, { at: "2026-11-03T02:00:00Z", id: 3 }),
    ], mp, allowed);
    expect(c.ok).toBe(true);
    expect(c.approvedBy).toBe("bob");
  });

  it("DISMISSAL clears a veto (stance vacated, not flipped)", () => {
    const c = evaluateMerge(pr(), [
      review("bob", "CHANGES_REQUESTED", HEAD, { at: "2026-11-03T01:00:00Z", id: 2 }),
      review("bob", "DISMISSED", HEAD, { at: "2026-11-03T02:00:00Z", id: 3 }),
      review("alice", "APPROVED", HEAD, { at: "2026-11-03T03:00:00Z", id: 4 }),
    ], mp, allowed);
    expect(c.ok).toBe(true);
  });

  it("COMMENTED reviews never become stances", () => {
    const c = evaluateMerge(pr(), [review("alice", "COMMENTED", HEAD)], mp, allowed);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual(["no approving review from an allowed-list member"]);
  });

  it("approvals from outside the allowed list do not count", () => {
    const c = evaluateMerge(pr(), [review("stranger", "APPROVED", HEAD)], mp, allowed);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual(["no approving review from an allowed-list member"]);
  });

  it("bot approvals do not count (no standing)", () => {
    const c = evaluateMerge(pr(), [review("codecov[bot]", "APPROVED", HEAD, { type: "Bot" })], mp, allowed);
    expect(c.ok).toBe(false);
  });

  it("draft / conflict / unknown-mergeability / foreign branch each hold with a reason", () => {
    expect(evaluateMerge(pr({ draft: true }), [review("alice", "APPROVED", HEAD)], mp, allowed).reasons).toContain("draft PR");
    expect(evaluateMerge(pr({ mergeable: false }), [review("alice", "APPROVED", HEAD)], mp, allowed).reasons).toContain("merge conflict");
    expect(evaluateMerge(pr({ mergeable: null }), [review("alice", "APPROVED", HEAD)], mp, allowed).reasons).toContain("mergeability not computed yet");
    expect(evaluateMerge(pr({ head: { ref: "feature/x", sha: HEAD } }), [review("alice", "APPROVED", HEAD)], mp, allowed).reasons.join(" ")).toContain("not a ticket branch");
  });

  it("requireApprovalCoveringHead=false accepts any approval stance-wise", () => {
    const c = evaluateMerge(pr(), [review("alice", "APPROVED", STALE)], { ...mp, requireApprovalCoveringHead: false }, allowed);
    expect(c.ok).toBe(true);
  });
});

// ── engine delivery lifecycle ──────────────────────────────────────────────────

let dir: string;
let engine: Engine;
const policy: Policy = {
  version: 1, allowedList: ["alice", "bob"], botList: [], acceptMode: "auto",
  merge: { enabled: true },
  table: [],
};
const delivery = { repo: "o/r", prNumber: 42, ticketId: 1, threadId: "github:o/r/issues/5", branch: "dsh/ticket-1", headSha: HEAD };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-merge-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("engine deliveries", () => {
  it("record → open → finish(merged) with mergedAt, gone from open, visible in views", () => {
    engine.recordDelivery(delivery);
    expect(engine.openDeliveries("o/r")).toHaveLength(1);
    engine.finishDelivery(engine.openDeliveries("o/r")[0].id, "merged");
    expect(engine.openDeliveries("o/r")).toHaveLength(0);
    const all = engine.deliveries();
    expect(all[0]).toMatchObject({ prNumber: 42, state: "merged", branch: "dsh/ticket-1" });
    expect(all[0].mergedAt).toBeTruthy();
  });

  it("re-delivering the same PR re-opens it (resume → new delivery)", () => {
    engine.recordDelivery(delivery);
    engine.finishDelivery(engine.openDeliveries("o/r")[0].id, "closed");
    engine.recordDelivery({ ...delivery, headSha: STALE });
    const open = engine.openDeliveries("o/r");
    expect(open).toHaveLength(1);
    expect(open[0].headSha).toBe(STALE);
  });

  it("openDeliveries is repo-scoped", () => {
    engine.recordDelivery(delivery);
    expect(engine.openDeliveries("other/r")).toHaveLength(0);
  });
});

// ── sweep against a fetch-mocked client ────────────────────────────────────────

interface MockWorld {
  pull: GhPullDetail;
  reviews: GhReview[];
  mergeDeclines: boolean;
  mergedBodies: { sha: string; merge_method: string }[];
  branchesDeleted: string[];
  posted: string[];
  errors: { match: string; status: number } | null;
}

function mockClient(w: MockWorld): GitHubClient {
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = url.toString();
    const method = init?.method ?? "GET";
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (w.errors && u.includes(w.errors.match)) return json({ message: "boom" }, w.errors.status);
    if (u.endsWith("/repos/o/r/pulls/42") && method === "GET") return json(w.pull);
    if (u.endsWith("/repos/o/r/pulls/42/reviews") && method === "GET") return json(w.reviews);
    if (u.endsWith("/repos/o/r/pulls/42/merge") && method === "PUT") {
      if (w.mergeDeclines) return json({ merged: false }, 200);
      w.mergedBodies.push(JSON.parse(String(init.body)) as { sha: string; merge_method: string });
      return json({ merged: true, sha: HEAD });
    }
    if (/\/repos\/o\/r\/git\/refs\/heads\/(.+)$/.test(u) && method === "DELETE") {
      w.branchesDeleted.push(u.split("/refs/heads/")[1]);
      return json({});
    }
    if (u.endsWith("/repos/o/r/issues/5/comments") && method === "POST") {
      w.posted.push(JSON.parse(String(init.body)).body);
      return json({ id: 777 });
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  }) as unknown as typeof fetch;
  return new GitHubClient({ token: "t0", fetchImpl });
}

function world(over: Partial<MockWorld> = {}): MockWorld {
  return {
    pull: pr(), reviews: [review("alice", "APPROVED", HEAD)], mergeDeclines: false,
    mergedBodies: [], branchesDeleted: [], posted: [], errors: null, ...over,
  };
}

describe("runMergeSweep", () => {
  it("disabled policy → complete no-op (no API traffic, no state change)", async () => {
    engine.recordDelivery(delivery);
    const w = world();
    const client = mockClient(w);
    const lines = await runMergeSweep(engine, client, "o/r", { ...policy, merge: undefined });
    expect(lines).toEqual([]);
    expect(w.mergedBodies).toHaveLength(0);
    expect(engine.openDeliveries("o/r")).toHaveLength(1);
  });

  it("zero-reason PR merges: SHA-pinned squash, reply via outbox, branch pruned", async () => {
    engine.recordDelivery(delivery);
    const w = world();
    await runMergeSweep(engine, mockClient(w), "o/r", policy);
    expect(w.mergedBodies).toEqual([{ sha: HEAD, merge_method: "squash" }]);
    expect(w.branchesDeleted).toEqual(["dsh/ticket-1"]);
    expect(w.posted.join(" ")).toContain("merged (squash)");
    expect(w.posted.join(" ")).toContain("approved by @alice");
    expect(engine.openDeliveries("o/r")).toHaveLength(0);
    expect(engine.deliveries()[0].state).toBe("merged");
  });

  it("holding PR: no merge, reasons surfaced, delivery stays open", async () => {
    engine.recordDelivery(delivery);
    const w = world({ reviews: [] });
    const lines = await runMergeSweep(engine, mockClient(w), "o/r", policy);
    expect(w.mergedBodies).toHaveLength(0);
    expect(lines[0]).toMatchObject({ pr: 42, action: "waiting" });
    expect(lines[0].reasons).toContain("no approving review from an allowed-list member");
    expect(engine.openDeliveries("o/r")).toHaveLength(1);
  });

  it("PR closed on GitHub (merged by hand) → delivery synced, no merge API call", async () => {
    engine.recordDelivery(delivery);
    const w = world({ pull: pr({ state: "closed", merged: true }) });
    const lines = await runMergeSweep(engine, mockClient(w), "o/r", policy);
    expect(w.mergedBodies).toHaveLength(0);
    expect(lines[0]).toMatchObject({ action: "merged" });
    expect(engine.deliveries()[0].state).toBe("merged");
  });

  it("PR closed without merging → delivery marked closed", async () => {
    engine.recordDelivery(delivery);
    const w = world({ pull: pr({ state: "closed", merged: false }) });
    const lines = await runMergeSweep(engine, mockClient(w), "o/r", policy);
    expect(lines[0]).toMatchObject({ action: "closed" });
    expect(engine.deliveries()[0].state).toBe("closed");
  });

  it("merge declined (head moved) → waiting, re-evaluated next cycle", async () => {
    engine.recordDelivery(delivery);
    const w = world({ mergeDeclines: true });
    const lines = await runMergeSweep(engine, mockClient(w), "o/r", policy);
    expect(lines[0]).toMatchObject({ action: "waiting" });
    expect(lines[0].reasons!.join(" ")).toContain("declined");
    expect(engine.openDeliveries("o/r")).toHaveLength(1);
  });

  it("branch deletion failure is tolerated — the merge stands", async () => {
    engine.recordDelivery(delivery);
    const w = world({ errors: { match: "/git/refs/heads/", status: 422 } });
    const lines = await runMergeSweep(engine, mockClient(w), "o/r", policy);
    expect(lines[0]).toMatchObject({ action: "merged" });
    expect(engine.deliveries()[0].state).toBe("merged");
  });

  it("getPull failure degrades to waiting with the error as reason", async () => {
    engine.recordDelivery(delivery);
    const w = world({ errors: { match: "/repos/o/r/pulls/42", status: 500 } });
    const lines = await runMergeSweep(engine, mockClient(w), "o/r", policy);
    expect(lines[0]).toMatchObject({ action: "waiting" });
    expect(lines[0].reasons!.join(" ")).toContain("500");
  });
});
