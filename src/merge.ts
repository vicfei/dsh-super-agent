// Auto-merge with delivery requirements (docs/ROADMAP M6-1) — the structural brakes:
// every merge condition is a checkable fact about the PR, never model judgment. Fail-closed:
// any miss is a recorded reason, ok requires zero reasons, and the merge PUT is pinned to the
// exact SHA that was approved — if the head moved, GitHub rejects and the next cycle re-evaluates.

import { clipReply } from "./clip.js";
import { mergePolicyOf } from "./domain.js";
import type { MergePolicy, Policy } from "./domain.js";
import type { Engine } from "./engine.js";
import type { GitHubClient, GhPullDetail, GhReview } from "./github/client.js";
import { drainReplyEffects } from "./work.js";

export interface MergeCheck {
  ok: boolean;
  reasons: string[];
  /** Set when ok: the allowed-list reviewer whose approval covers the head. */
  approvedBy?: string;
  changedLines: number;
}

const TICKET_BRANCH = /^dsh\/ticket-\d+$/;

function isBotReview(r: GhReview): boolean {
  return !r.user || r.user.type === "Bot" || r.user.login.endsWith("[bot]");
}

/**
 * Pure evaluation (unit-tested like the gate): would this PR merge under this policy?
 * Structural first (draft / conflict / branch / size), then review stances — a reviewer's
 * latest APPROVED | CHANGES_REQUESTED | DISMISSED review is their effective stance
 * (COMMENTED/PENDING don't move it; a dismissal clears it).
 */
export function evaluateMerge(pr: GhPullDetail, reviews: GhReview[], policy: MergePolicy, allowedList: string[]): MergeCheck {
  const reasons: string[] = [];
  const changedLines = pr.additions + pr.deletions;
  let approvedBy: string | undefined;

  if (pr.merged) reasons.push("already merged");
  if (pr.draft) reasons.push("draft PR");
  if (pr.mergeable === false) reasons.push("merge conflict");
  else if (pr.mergeable === null) reasons.push("mergeability not computed yet");
  if (!TICKET_BRANCH.test(pr.head.ref)) reasons.push(`not a ticket branch: ${pr.head.ref}`);
  if (changedLines > policy.maxChangedLines) reasons.push(`±${changedLines} lines > cap ${policy.maxChangedLines}`);

  if (reasons.length === 0) {
    const allowed = new Set(allowedList.map((s) => s.toLowerCase()));
    const stance = new Map<string, { state: string; commitId: string; at: string; id: number }>();
    for (const r of reviews) {
      if (isBotReview(r)) continue; // bots have no standing — neither approve nor veto
      const login = r.user!.login;
      if (!allowed.has(login.toLowerCase())) continue; // only allowed-list reviewers count
      if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED" && r.state !== "DISMISSED") continue;
      const prev = stance.get(login);
      if (!prev || r.submitted_at > prev.at || (r.submitted_at === prev.at && r.id > prev.id)) {
        stance.set(login, { state: r.state, commitId: r.commit_id, at: r.submitted_at, id: r.id });
      }
    }

    let hasApproval = false;
    let hasCoveringApproval = false;
    for (const [login, s] of stance) {
      if (s.state === "CHANGES_REQUESTED") reasons.push(`changes requested by @${login} — blocks until re-reviewed`);
      if (s.state === "APPROVED") {
        hasApproval = true;
        if (!policy.requireApprovalCoveringHead || s.commitId === pr.head.sha) {
          hasCoveringApproval = true;
          approvedBy = login;
        }
      }
    }
    if (!hasApproval) reasons.push("no approving review from an allowed-list member");
    else if (!hasCoveringApproval) reasons.push(`no approval covers head ${pr.head.sha.slice(0, 7)} — stale approvals do not count`);
  }

  return { ok: reasons.length === 0, reasons, ...(approvedBy ? { approvedBy } : {}), changedLines };
}

export interface MergeSweepLine {
  pr: number;
  action: "merged" | "waiting" | "closed" | "already-merged";
  reasons?: string[];
}

/**
 * Idempotent sweep over our open deliveries: sync PRs closed on GitHub, evaluate the rest,
 * merge only zero-reason PRs, post a clipped merge reply through the outbox, prune the branch.
 * Per-delivery errors degrade to "waiting" — the next cycle retries (fail-closed).
 */
export async function runMergeSweep(
  engine: Engine,
  client: GitHubClient,
  repo: string,
  policy: Policy,
  log: (l: string) => void = () => {},
): Promise<MergeSweepLine[]> {
  const merge = mergePolicyOf(policy);
  if (!merge.enabled) return [];
  const out: MergeSweepLine[] = [];

  for (const d of engine.openDeliveries(repo)) {
    try {
      const pr = await client.getPull(repo, d.prNumber);
      if (pr.state === "closed") {
        engine.finishDelivery(d.id, pr.merged ? "merged" : "closed");
        out.push({ pr: d.prNumber, action: pr.merged ? "merged" : "closed" });
        log(`#${d.prNumber} ${pr.merged ? "merged" : "closed"} on GitHub — delivery synced`);
        continue;
      }
      if (pr.merged) {
        engine.finishDelivery(d.id, "merged");
        out.push({ pr: d.prNumber, action: "already-merged" });
        continue;
      }

      const reviews = await client.listReviews(repo, d.prNumber);
      const check = evaluateMerge(pr, reviews, merge, policy.allowedList);
      if (!check.ok) {
        out.push({ pr: d.prNumber, action: "waiting", reasons: check.reasons });
        log(`#${d.prNumber} holds: ${check.reasons.join("; ")}`);
        continue;
      }

      const m = await client.mergePullRequest(repo, pr.number, { sha: pr.head.sha, merge_method: merge.method });
      if (!m.merged) {
        out.push({ pr: d.prNumber, action: "waiting", reasons: ["merge API declined (head moved?) — will re-evaluate"] });
        log(`#${d.prNumber} merge declined — re-evaluating next cycle`);
        continue;
      }

      engine.enqueueReply(
        `merge-report:${d.prNumber}`,
        d.threadId,
        clipReply(
          `PR #${pr.number} merged (${merge.method}) — approved by @${check.approvedBy} covering ${pr.head.sha.slice(0, 7)} · ±${check.changedLines} lines. This is by an automated agent, not a human.`,
          150,
        ),
      );
      engine.finishDelivery(d.id, "merged");
      if (merge.deleteBranch) {
        try {
          await client.deleteBranch(repo, d.branch);
        } catch {
          log(`#${d.prNumber} branch ${d.branch} not deleted (best effort)`);
        }
      }
      out.push({ pr: d.prNumber, action: "merged" });
      log(`#${d.prNumber} merged (${merge.method}) — approved by @${check.approvedBy}`);
    } catch (e) {
      out.push({ pr: d.prNumber, action: "waiting", reasons: [e instanceof Error ? e.message : String(e)] });
      log(`#${d.prNumber} sweep error: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (out.length > 0) await drainReplyEffects(engine, client, repo);
  return out;
}
