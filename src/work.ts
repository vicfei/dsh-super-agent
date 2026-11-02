// Work orchestration — claim queued tickets, run each in its worktree via the configured CLI,
// record the assignment, report into the thread (docs/003: reports; docs/004: report style).
// Runs after commit: the Engine state transitions first, the subprocess and posting after.

import { clipReply } from "./clip.js";
import type { Engine } from "./engine.js";
import { Executor, type ExecutorResult } from "./executor.js";
import type { GitHubClient } from "./github/client.js";
import { spawn } from "node:child_process";

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

export interface DeliveryOutcome {
  prUrl?: string;
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
    await git(result.worktree, ["push", "origin", `HEAD:refs/heads/${branch}`]);
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
    return { prUrl: pr.html_url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runWork(
  engine: Engine,
  executor: Executor,
  repo: string,
  client: GitHubClient | null,
): Promise<WorkReport[]> {
  const queued = engine.claimQueued(executor.cfg.maxWorkers); // slots
  const reports: WorkReport[] = [];

  for (const t of queued) {
    const assignmentId = engine.startAssignment(t.id, ""); // running — worktree filled on success
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

    engine.endAssignment(assignmentId, result.exitCode, result.timedOut, result.output);
    const ok = !result.timedOut && result.exitCode === 0;
    if (ok) {
      engine.completeTicket(t.id);
      const delivery = client ? await deliverPullRequest(client, repo, t, { body: t.body, author: t.author }, result) : {};
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

  if (client) await drainReplyEffects(engine, client, repo);
  return reports;
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

export async function drainReplyEffects(engine: Engine, client: GitHubClient, repo: string): Promise<void> {
  for (const fx of engine.takeDue()) {
    if (fx.kind !== "reply") {
      engine.completeEffect(fx.id);
      continue;
    }
    const p = fx.payload as { issueNumber: number | null; body: string };
    if (p.issueNumber === null) {
      engine.failEffect(fx.id, "cannot resolve issue number from thread", false);
      continue;
    }
    try {
      const { id } = await client.postIssueComment(repo, p.issueNumber, p.body);
      engine.completeEffect(fx.id);
      engine.markSelfPosted(id); // never re-ingest our own comment
      console.log(`[POSTED] ${fx.key} → ${repo}#${p.issueNumber}`);
    } catch (e) {
      engine.failEffect(fx.id, e instanceof Error ? e.message : String(e));
      console.error(`[POST-FAILED] ${fx.key}: ${e instanceof Error ? e.message : e} (will back off)`);
    }
  }
}
