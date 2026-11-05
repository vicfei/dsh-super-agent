// Work orchestration — claim queued tickets, run each in its worktree via the configured CLI,
// record the assignment, report into the thread (docs/003: reports; docs/004: report style).
// Runs after commit: the Engine state transitions first, the subprocess and posting after.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clipReply } from "./clip.js";
import type { Engine, SpillFile } from "./engine.js";
import { Executor, type ExecutorResult } from "./executor.js";
import type { GitHubClient } from "./github/client.js";
import type { ReplyChannel } from "./source.js";
import { spawn } from "node:child_process";

/** GitHub's ReplyChannel: threads are `github:owner/repo/(issues|pulls)/N`, delivery is a comment. */
export class GitHubReplyChannel implements ReplyChannel {
  constructor(private readonly client: GitHubClient, private readonly repo: string) {}

  matches(threadId: string): boolean {
    return threadId.startsWith("github:");
  }

  async deliver(threadId: string, body: string): Promise<{ externalId: string }> {
    const n = threadId.match(/\/(issues|pulls)\/(\d+)$/);
    if (!n) throw new Error("cannot resolve issue number from thread");
    const { id } = await this.client.postIssueComment(this.repo, Number(n[2]), body);
    return { externalId: `issue_comment:${id}` };
  }
}

export interface WorkReport {
  ticketId: number;
  assignmentId: number;
  outcome: "done" | "failed" | "refused";
  detail: string;
}

/** git, quietly — resolves with stdout or throws with stderr context. */
function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(" ")} → ${code}: ${err.trim().slice(0, 200)}`))));
  });
}

/**
 * Git-over-https auth for the ticket-branch push (M6-2): installation tokens and PATs both
 * authenticate as x-access-token. Scoped to https://github.com, so local file remotes (tests)
 * and ssh remotes are untouched — those keep their ambient credentials.
 */
export function pushAuthArgs(token: string | undefined): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

export interface DeliveryOutcome {
  prUrl?: string;
  /** Set when a PR opened — enough for the engine to track it for the merge sweep. */
  prNumber?: number;
  branch?: string;
  headSha?: string;
  error?: string;
}

/**
 * PR delivery (docs/003: results return via the Source): if the worker committed anything
 * beyond its base, push the ticket branch and open a pull request. Delivery failures
 * degrade gracefully — the work is done; only the packaging failed.
 */
export async function deliverPullRequest(
  client: GitHubClient,
  repo: string,
  ticket: { id: number; threadId: string },
  trigger: { body: string; author: string },
  result: ExecutorResult,
): Promise<DeliveryOutcome> {
  try {
    const count = Number(await git(result.worktree, ["rev-list", "--count", `${result.baseSha}..HEAD`]));
    if (count === 0) return {}; // nothing to deliver
    const branch = `dsh/ticket-${ticket.id}`;
    const headSha = await git(result.worktree, ["rev-parse", "HEAD"]);
    await git(result.worktree, [...pushAuthArgs(await client.currentToken()), "push", "origin", `HEAD:refs/heads/${branch}`]);
    const base = await client.getDefaultBranch(repo);
    const firstLine = trigger.body.trim().split("\n")[0].slice(0, 72) || "ticket work";
    const pr = await client.createPullRequest(repo, {
      title: `Ticket #${ticket.id}: ${firstLine}`,
      head: branch,
      base,
      body: [
        `This is by an automated agent, not a human.`,
        ``,
        `Ticket #${ticket.id} — opened by @${trigger.author} in ${ticket.threadId}.`,
        ``,
        `**Request**`,
        ``,
        trigger.body.trim().slice(0, 500) || "(no body)",
        ``,
        `Worker output excerpt:`,
        ``,
        "```",
        result.output.trim().slice(-600),
        "```",
      ].join("\n"),
    });
    return { prUrl: pr.html_url, prNumber: pr.number, branch, headSha };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runWork(
  engine: Engine,
  executor: Executor,
  repo: string,
  client: GitHubClient | null,
  channels: ReplyChannel[] = [],
): Promise<WorkReport[]> {
  const queued = engine.claimQueued(executor.cfg.maxWorkers); // slots
  const reports: WorkReport[] = [];

  for (const t of queued) {
    const assignmentId = engine.startAssignment(t.id, ""); // running — worktree filled on success
    if (t.spills.length > 0) writeSpills(executor.worktreeOf(t.id), t.spills); // before the run: recall must be readable
    let result: ExecutorResult | undefined;
    try {
      result = await executor.run({ id: t.id, threadId: t.threadId }, { body: t.body, author: t.author }, repo);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      engine.endAssignment(assignmentId, null, false, detail);
      engine.enqueueReply(`ticket-report:${t.id}:${assignmentId}`, t.threadId,
        clipReply(`Ticket #${t.id} could not run: ${detail}. Awaiting a person. This is by an automated agent, not a human.`, 150));
      reports.push({ ticketId: t.id, assignmentId, outcome: "refused", detail });
      continue;
    }

    const ok = !result.timedOut && result.exitCode === 0;
    // v1.2 P2: the worker asked for a person — the run "did not complete" whatever its exit
    // code says (a clean exit still lands in needs-person); the request becomes the
    // structured approval ask, rendered on the surface.
    const request = consumeApprovalRequest(result.worktree);
    if (request) {
      engine.endAssignment(assignmentId, ok ? null : result.exitCode, result.timedOut, result.output);
      engine.recordWorkerRequest(t.id, request.content);
      engine.enqueueReply(`ticket-report:${t.id}:${assignmentId}`, t.threadId,
        clipReply(`Ticket #${t.id}: the worker asked for a person.\n\n${request.content}\n\nThis is by an automated agent, not a human.`, 150));
      reports.push({ ticketId: t.id, assignmentId, outcome: "failed", detail: "worker requested a person (approval file)" });
      continue;
    }
    engine.endAssignment(assignmentId, result.exitCode, result.timedOut, result.output);
    if (ok && t.speculative) {
      // v1.0: rehearsal completes in total silence — no push, no PR, no reply. The deliver
      // gate is a human promote; until then nothing is said and nothing leaves the worktree.
      engine.completeTicket(t.id);
      reports.push({ ticketId: t.id, assignmentId, outcome: "done", detail: "exit 0 · speculative (silent, awaiting promote)" });
    } else if (ok) {
      engine.completeTicket(t.id);
      const delivery = client ? await deliverPullRequest(client, repo, t, { body: t.body, author: t.author }, result) : {};
      if (delivery.prNumber !== undefined) {
        engine.recordDelivery({
          repo, prNumber: delivery.prNumber, ticketId: t.id, threadId: t.threadId,
          branch: delivery.branch!, headSha: delivery.headSha!,
        });
      }
      let body = reportBody(t.id, result);
      if (delivery.prUrl) body += `\n\nPR: ${delivery.prUrl}`;
      if (delivery.error) body += `\n\n(delivery failed: ${delivery.error})`;
      engine.enqueueReply(`ticket-report:${t.id}:${assignmentId}`, t.threadId, body);
      reports.push({ ticketId: t.id, assignmentId, outcome: "done", detail: delivery.prUrl ? `exit 0 · PR opened` : "exit 0" });
    } else {
      engine.enqueueReply(`ticket-report:${t.id}:${assignmentId}`, t.threadId, reportBody(t.id, result));
      reports.push({
        ticketId: t.id, assignmentId, outcome: "failed",
        detail: result.timedOut ? "timeout" : `exit ${result.exitCode}`,
      });
    }
  }

  const deliver = channels.length > 0 ? channels : client ? [new GitHubReplyChannel(client, repo)] : [];
  if (deliver.length > 0) await drainReplyEffects(engine, deliver);
  return reports;
}

/** Materialize spilled context inside the worktree — the worker's chain of recall (v0.9.x). */
function writeSpills(worktree: string, spills: SpillFile[]): void {
  for (const sp of spills) {
    const p = join(worktree, sp.file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, sp.content, "utf8");
  }
}

/**
 * v1.2 P2 — the approval-request file protocol: a worker that wants permission writes
 * title/reason/requested-action to $DSH_APPROVAL_FILE and stops. The request is
 * informative, never authoritative — the engine still owns every transition; the file
 * is one-way (worker writes, engine reads; nothing in it can flip a gate by itself).
 * Consumed here: moved under .dsh/approval-requested/ so a re-run starts clean.
 */
export function consumeApprovalRequest(worktree: string): { content: string } | null {
  const file = join(worktree, ".dsh", "approval-request.md");
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8").trim();
  const done = join(worktree, ".dsh", "approval-requested");
  mkdirSync(done, { recursive: true });
  renameSync(file, join(done, `${Date.now()}.md`));
  return content ? { content } : null;
}

function reportBody(ticketId: number, r: ExecutorResult): string {
  const failed = r.timedOut || r.exitCode !== 0;
  const status = r.timedOut ? "timed out after the background cap" : `exit ${r.exitCode}`;
  const tail = r.output.trim().slice(-400);
  const excerpt = tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : "";
  return clipReply(
    `Ticket #${ticketId} ${failed ? "failed" : "done"} (${status}).${failed ? " Awaiting a person." : ""} This is by an automated agent, not a human.${excerpt}`,
    150,
  );
}

/** Drain due reply effects, routing each by threadId prefix to its channel (v0.8 multi-source). */
/**
 * v1.0 deliver gate, delivery half: promoted tickets whose work ended cleanly get their
 * branch pushed and PR opened now — the human already authorized it. Idempotent: the
 * delivery row's presence takes a ticket out of the pending list.
 */
export async function runPromoteSweep(
  engine: Engine,
  executor: Executor,
  client: GitHubClient,
  repo: string,
  channels: ReplyChannel[] = [],
  log: (l: string) => void = () => {},
): Promise<number> {
  let delivered = 0;
  for (const t of engine.promotedPendingDelivery()) {
    try {
      const worktree = executor.worktreeOf(t.id);
      const base = await client.getDefaultBranch(repo);
      await git(worktree, ["fetch", "--quiet", "origin", base]);
      const baseSha = await git(worktree, ["merge-base", "HEAD", `origin/${base}`]);
      const count = Number(await git(worktree, ["rev-list", "--count", `${baseSha}..HEAD`]));
      if (count === 0) {
        log(`#${t.id} promoted but the worktree has no commits — nothing to deliver`);
        engine.markPromoteEmpty(t.id); // settled: logged once, out of the sweep for good
        continue;
      }
      const result = { worktree, baseSha, exitCode: 0, timedOut: false, output: "" } as ExecutorResult;
      const delivery = await deliverPullRequest(client, repo, t, { body: "(promoted speculative work)", author: t.opener }, result);
      if (delivery.prNumber !== undefined) {
        engine.recordDelivery({
          repo, prNumber: delivery.prNumber, ticketId: t.id, threadId: t.threadId,
          branch: delivery.branch!, headSha: delivery.headSha!,
        });
        engine.enqueueReply(`promote-report:${t.id}`, t.threadId,
          clipReply(`Promoted speculative ticket #${t.id} — the rehearsed work is now up for review: ${delivery.prUrl}. This is by an automated agent, not a human.`, 150));
        delivered++;
        log(`#${t.id} delivered after promote → ${delivery.prUrl}`);
      }
    } catch (e) {
      log(`#${t.id} promote delivery failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (delivered > 0) {
    await drainReplyEffects(engine, channels.length > 0 ? channels : [new GitHubReplyChannel(client, repo)]);
  }
  return delivered;
}

export async function drainReplyEffects(engine: Engine, channels: ReplyChannel[]): Promise<void> {
  for (const fx of engine.takeDue()) {
    if (fx.kind !== "reply") {
      engine.completeEffect(fx.id);
      continue;
    }
    const p = fx.payload as { threadId: string; body: string };
    const channel = channels.find((c) => c.matches(p.threadId));
    if (!channel) {
      engine.failEffect(fx.id, `no reply channel for thread ${p.threadId}`, false);
      continue;
    }
    try {
      const { externalId } = await channel.deliver(p.threadId, p.body);
      engine.completeEffect(fx.id);
      engine.markSelfPosted(`${p.threadId.split(":")[0]}:${externalId}`); // never re-ingest our own
      console.log(`[POSTED] ${fx.key} → ${p.threadId}`);
    } catch (e) {
      engine.failEffect(fx.id, e instanceof Error ? e.message : String(e));
      console.error(`[POST-FAILED] ${fx.key}: ${e instanceof Error ? e.message : e} (will back off)`);
    }
  }
}
