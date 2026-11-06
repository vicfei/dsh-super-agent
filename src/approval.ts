// IM remote approval surface (v1.1, issue #76; design: docs/designs/im-approval-surface.md).
// Digits in an operator's ops DM resolve PENDING human decisions — the command layer sits
// downstream of admission (stop-command semantics), can never change policy, and never forges
// GitHub approvals. Anti-mistouch: strict digit shape, double-key destructive acts, 60-min
// expiry, newest-wins single pending, receipts for every applied action.

import type { Policy, Trigger } from "./domain.js";
import type { Engine } from "./engine.js";
import type { ReplyChannel } from "./source.js";
import { drainReplyEffects } from "./work.js";

const EXPIRY_MS = 60 * 60_000;
const CONFIRM_MS = 5 * 60_000;

export function approvalEnabled(policy: Policy): boolean {
  return (policy.approval as { enabled?: boolean } | undefined)?.enabled === true;
}

/** Strict shape: the whole trimmed body is a single digit 1–3. Nothing else counts. */
export function isApprovalDigit(body: string): 1 | 2 | 3 | null {
  const t = body.trim();
  return t === "1" || t === "2" || t === "3" ? (Number(t) as 1 | 2 | 3) : null;
}

/**
 * Split a batch: digits from ops-thread owners become approval commands; everything else
 * flows through the gate untouched. Applied commands enqueue receipts in place.
 */
export function interceptApprovalCommands(
  triggers: Trigger[],
  engine: Engine,
  policy: Policy,
  now: Date = new Date(),
): { rest: Trigger[]; applied: string[] } {
  if (!approvalEnabled(policy)) return { rest: triggers, applied: [] };
  const rest: Trigger[] = [];
  const applied: string[] = [];
  for (const t of triggers) {
    const digit = isApprovalDigit(t.body);
    const owner = engine.opsThreadLogin(t.threadId);
    if (digit === null || owner === null || owner.toLowerCase() !== t.author.login.toLowerCase()) {
      rest.push(t); // not a command: group chatter, wrong thread, wrong sender, or just words
      continue;
    }
    applied.push(applyApproval(engine, t.threadId, digit, now));
  }
  return { rest, applied };
}

function excerpt(engine: Engine, ticketId: number): string {
  const t = engine.tickets().find((x) => x.id === ticketId);
  if (!t) return "(unknown ticket)";
  return `#${t.id} [${t.stage}] ${t.strength} opener=${t.opener}`;
}

/** The digit state machine. Every outcome enqueues a receipt — mistouches are visible. */
export function applyApproval(engine: Engine, opsThread: string, digit: 1 | 2 | 3, now: Date = new Date()): string {
  const req = engine.pendingApproval(opsThread);
  if (!req) {
    engine.enqueueReply(`approval-none:${now.getTime()}`, opsThread, "Nothing pending — no approval request is waiting for a number.");
    return "nothing-pending";
  }
  if (now.getTime() - Date.parse(req.createdAt) > EXPIRY_MS) {
    engine.resolveApproval(req.id);
    engine.enqueueReply(`approval-expired:${req.id}`, opsThread, `Request expired (ticket #${req.ticketId}) — nothing done. I will re-offer if the decision is still pending.`);
    return `expired:${req.ticketId}`;
  }

  if (digit === 3) {
    engine.enqueueReply(`approval-detail:${req.id}`, opsThread, `Detail — ${excerpt(engine, req.ticketId)}. 1 approve · 2 stop${req.kind === "speculative" ? "/discard" : ""} · 3 detail again.`);
    return `detail:${req.ticketId}`;
  }

  if (digit === 2) {
    if (!req.confirmAt) {
      engine.armDestructiveConfirm(req.id, now);
      engine.enqueueReply(`approval-confirm:${req.id}`, opsThread, `Reply 2 again within 5 minutes to confirm stopping ticket #${req.ticketId}. This is the safety double-key — no action taken yet.`);
      return `confirm:${req.ticketId}`;
    }
    if (now.getTime() - Date.parse(req.confirmAt) > CONFIRM_MS) {
      engine.resolveApproval(req.id);
      engine.enqueueReply(`approval-confirm-expired:${req.id}`, opsThread, `Confirmation window passed — ticket #${req.ticketId} untouched.`);
      return `confirm-expired:${req.ticketId}`;
    }
    engine.resolveApproval(req.id);
    const stopped = engine.stopTicket(req.ticketId, "im-approval");
    engine.enqueueReply(`approval-receipt:${req.id}`, opsThread, stopped
      ? `⛔ Ticket #${req.ticketId} stopped (by your confirmed 2).`
      : `Ticket #${req.ticketId} was no longer open — nothing stopped.`);
    return stopped ? `stop:${req.ticketId}` : `stop-noop:${req.ticketId}`;
  }

  // digit 1 — approve: needs-person requeues for another run; speculative hits the deliver gate
  engine.resolveApproval(req.id);
  if (req.kind === "speculative") {
    const ok = engine.promoteTicket(req.ticketId, "im-approval");
    engine.enqueueReply(`approval-receipt:${req.id}`, opsThread, ok
      ? `✅ Ticket #${req.ticketId} promoted — the rehearsed work will be pushed and a PR opened.`
      : `Ticket #${req.ticketId} was no longer speculative — nothing promoted.`);
    return ok ? `promote:${req.ticketId}` : `promote-noop:${req.ticketId}`;
  }
  const ok = engine.requeueTicket(req.ticketId);
  if (ok) {
    // v1.2 P2: approve = resume with the request as guidance — a note, never a capability token
    const request = engine.workerRequest(req.ticketId);
    if (request) engine.setTicketNote(req.ticketId, `The owner approved your earlier request:\n${request}`);
  }
  engine.enqueueReply(`approval-receipt:${req.id}`, opsThread, ok
    ? `✅ Ticket #${req.ticketId} requeued — the worker will take another run and report here.`
    : `Ticket #${req.ticketId} was not awaiting a person — nothing requeued.`);
  return ok ? `requeue:${req.ticketId}` : `requeue-noop:${req.ticketId}`;
}

/** Render requests for pending decisions into ops threads (the watch cycle calls this). */
export async function runApprovalSweep(
  engine: Engine,
  policy: Policy,
  channels: ReplyChannel[],
  log: (l: string) => void = () => {},
): Promise<number> {
  if (!approvalEnabled(policy)) return 0;
  let rendered = 0;
/**
 * Render-once guard: a ticket gets its approval ask enqueued exactly one time (the outbox
 * owns retries). Checking the approval_request row instead caused a render storm — with
 * several eligible tickets, each openApprovalRequest() supersedes the previous one's row
 * (newest-wins is per-thread by design), so the next sweep re-rendered the others, which
 * superseded again, forever (live finding 2026-11-06: 4 tickets × every 15s cycle).
 */
const renderedOnce = (ticketId: number): boolean =>
  Boolean(engine.db.prepare("SELECT 1 FROM effect WHERE kind = 'reply' AND key = ?").get(`approval-req:${ticketId}`));


  const route = (opener: string): string | null =>
    engine.opsRoutes()[opener.toLowerCase()] ?? engine.firstOpsThread();

  for (const t of engine.tickets()) {
    if (t.stage !== "needs-person") continue;
    if (renderedOnce(t.id)) continue;
    const thread = route(t.opener);
    if (!thread) continue;
    engine.openApprovalRequest(thread, t.id, "needs-person");
    engine.enqueueReply(`approval-req:${t.id}`, thread,
      `🔑 [approval needed] Ticket #${t.id} is waiting for a person.\n${ticketLine(engine, t.id)}\n1 requeue (run again) · 2 stop · 3 detail\n(reply with just the number)`);
    rendered++;
    log(`approval request rendered: #${t.id} → ${thread.split(":")[0]} ops thread`);
  }

  for (const t of engine.tickets()) {
    if (!(t.speculative && t.state === "ended")) continue;
    if (engine.db.prepare("SELECT 1 FROM delivery WHERE ticket_id = ?").get(t.id)) continue;
    if (renderedOnce(t.id)) continue;
    const thread = route(t.opener);
    if (!thread) continue;
    engine.openApprovalRequest(thread, t.id, "speculative");
    engine.enqueueReply(`approval-req:${t.id}`, thread,
      `🧪 [rehearsal ready] Ticket #${t.id} was silently rehearsed and awaits the deliver gate.\n${ticketLine(engine, t.id)}\n1 promote (push + PR) · 2 discard · 3 detail\n(reply with just the number)`);
    rendered++;
    log(`promote request rendered: #${t.id} → ${thread.split(":")[0]} ops thread`);
  }

  if (rendered > 0) await drainReplyEffects(engine, channels);
  return rendered;
}

function ticketLine(engine: Engine, ticketId: number): string {
  const t = engine.tickets().find((x) => x.id === ticketId);
  if (!t) return "(unknown)";
  // v1.2 P2: a worker-written approval request outranks the trigger excerpt — it IS the ask
  const request = engine.workerRequest(ticketId);
  if (request) return `opener @${t.opener} · worker requested: ${request.replace(/\s+/g, " ").slice(0, 200)}`;
  const row = engine.db.prepare("SELECT substr(body, 1, 120) AS excerpt FROM trigger WHERE id = ?").get(t.triggerId) as { excerpt?: string } | undefined;
  return `opener @${t.opener} · ${(row?.excerpt ?? "").replace(/\n/g, " ")}`;
}

