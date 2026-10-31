// Work orchestration — claim queued tickets, run each in its worktree via the configured CLI,
// record the assignment, report into the thread (docs/003: reports; docs/004: report style).
// Runs after commit: the Engine state transitions first, the subprocess and posting after.

import { clipReply } from "./clip.js";
import type { Engine } from "./engine.js";
import { Executor, type ExecutorResult } from "./executor.js";
import type { GitHubClient } from "./github/client.js";

export interface WorkReport {
  ticketId: number;
  assignmentId: number;
  outcome: "done" | "failed" | "refused";
  detail: string;
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
      engine.enqueueReply(`ticket-report:${t.id}:${assignmentId}`, t.threadId, reportBody(t.id, result));
      reports.push({ ticketId: t.id, assignmentId, outcome: "done", detail: "exit 0" });
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
