// IM remote approval surface (v1.1, issue #76; design: docs/designs/im-approval-surface.md).
// Digits in an operator's ops DM resolve PENDING human decisions — the command layer sits
// downstream of admission (stop-command semantics), can never change policy, and never forges
// GitHub approvals. Anti-mistouch: strict digit shape, double-key destructive acts, 60-min
// expiry, newest-wins single pending, receipts for every applied action.

import type { Policy, Trigger } from "./domain.js";
import { approvalNeeded, receiptNothingPending, receiptPromoted, receiptRequeued, receiptStopped, rehearsalReady } from "./locale.js";
import type { Engine } from "./engine.js";
import type { ReplyChannel } from "./source.js";
import { drainReplyEffects } from "./work.js";
import { lastKey, nextRoutineFire, routineDefinitions, routinesEnabled } from "./routines.js";

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

/** Strict shape: the whole trimmed body is a question mark (ASCII `?` or fullwidth `？`). */
export function isStatusQuery(body: string): boolean {
  const t = body.trim();
  return t === "?" || t === "？";
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
    const owner = engine.opsThreadLogin(t.threadId);
    const fromOwner = owner !== null && owner.toLowerCase() === t.author.login.toLowerCase();
    const digit = isApprovalDigit(t.body);
    if (digit !== null && fromOwner) {
      applied.push(applyApproval(engine, t.threadId, digit, now));
      continue;
    }
    if (isStatusQuery(t.body) && fromOwner) {
      engine.enqueueReply(`ops-status:${t.id}`, t.threadId, opsStatusCard(engine, policy, now));
      applied.push(`status-card → ${t.threadId.split(":")[0]} ops thread`);
      continue;
    }
    rest.push(t); // not a command: group chatter, wrong thread, wrong sender, or just words
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
    engine.enqueueReply(`approval-none:${now.getTime()}`, opsThread, receiptNothingPending());
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
      ? receiptStopped(req.ticketId)
      : `Ticket #${req.ticketId} was no longer open — nothing stopped.`);
    return stopped ? `stop:${req.ticketId}` : `stop-noop:${req.ticketId}`;
  }

  // digit 1 — approve: needs-person requeues for another run; speculative hits the deliver gate
  engine.resolveApproval(req.id);
  if (req.kind === "speculative") {
    const ok = engine.promoteTicket(req.ticketId, "im-approval");
    engine.enqueueReply(`approval-receipt:${req.id}`, opsThread, ok
      ? receiptPromoted(req.ticketId)
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
    ? receiptRequeued(req.ticketId)
    : `Ticket #${req.ticketId} was not awaiting a person — nothing requeued.`);
  return ok ? `requeue:${req.ticketId}` : `requeue-noop:${req.ticketId}`;
}

/**
 * The ops status card (v1.3): `?` in an ops thread answers with the whole picture —
 * what awaits the owner, ticket stages, outbox backlog, the clock's next fire. Reads only.
 */
export function opsStatusCard(engine: Engine, policy: Policy, now: Date = new Date()): string {
  const pending = engine.pendingApprovals();
  const need = pending.filter((p) => p.kind === "needs-person").length;
  const rehearsal = pending.filter((p) => p.kind === "speculative").length;
  const tickets = engine.tickets();
  const stages = { queued: 0, working: 0, "needs-person": 0, ended: 0 } as Record<string, number>;
  for (const t of tickets) stages[t.stage] = (stages[t.stage] ?? 0) + 1;
  const fx = engine.db.prepare("SELECT status, COUNT(*) c FROM effect GROUP BY status").all() as { status: string; c: number }[];
  const fxOf = (st: string) => Number(fx.find((r) => r.status === st)?.c ?? 0);
  const clock = routineCard(engine, policy, now);
  return [
    `📊 dsh status — acceptMode ${policy.acceptMode}`,
    `⏳ awaiting you: ${pending.length}${need ? ` (needs-person ${need}` : ""}${need && rehearsal ? " · " : ""}${rehearsal ? `rehearsal ${rehearsal}` : ""}${need || rehearsal ? ")" : ""}`,
    `🎫 tickets: queued ${stages.queued} · working ${stages.working} · needs-person ${stages["needs-person"]} · ended ${stages.ended}`,
    `📤 effects: pending ${fxOf("pending")} · failed ${fxOf("failed")}`,
    ...(clock ? [clock] : []),
  ].join("\n");
}

function routineCard(engine: Engine, policy: Policy, now: Date): string | null {
  if (!routinesEnabled(policy)) return null;
  const positions = engine.sourceState("timer").positions;
  const lines: string[] = [];
  for (const d of routineDefinitions(policy)) {
    try {
      const next = nextRoutineFire(d, positions[lastKey(d.id)], now.getTime());
      const inMin = Math.max(0, Math.round((next - now.getTime()) / 60_000));
      lines.push(`⏰ ${d.id}: ${next <= now.getTime() ? "overdue (fires next sweep)" : `next ${new Date(next).toISOString().slice(11, 16)}Z (in ${inMin >= 60 ? Math.round(inMin / 60) + "h" : inMin + "m"})`}`);
    } catch {
      lines.push(`⏰ ${d.id}: schedule error`);
    }
  }
  return lines.length ? lines.join("\n") : null;
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
 * Render-once guard, per ASSIGNMENT: a ticket's approval ask for one failed run is enqueued
 * exactly once (the outbox owns retries) — same assignment, same key, no matter how many
 * sweeps. Checking the approval_request row instead caused a render storm (live finding
 * 2026-11-06), but keying by ticket alone (#114, live finding 2026-11-10) swallowed the
 * NEXT ask forever: a requeued ticket that failed again never re-rendered (the owner's
 * digit got "Nothing pending"), and a speculative 🧪 promote was suppressed by an earlier
 * needs-person ask on the same ticket. The assignment that caused the state is part of the
 * key, so every new run earns exactly one fresh ask.
 */
const lastAssignmentOf = (ticketId: number): number =>
  Number((engine.db.prepare("SELECT MAX(id) AS m FROM assignment WHERE ticket_id = ?").get(ticketId) as { m: number | null }).m ?? 0);

const renderedOnce = (ticketId: number, assignmentId: number): boolean =>
  Boolean(engine.db.prepare("SELECT 1 FROM effect WHERE kind = 'reply' AND key = ?").get(`approval-req:${ticketId}:${assignmentId}`));


  const route = (opener: string): string | null =>
    engine.opsRoutes()[opener.toLowerCase()] ?? engine.firstOpsThread();

  for (const t of engine.tickets()) {
    if (t.stage !== "needs-person") continue;
    const aid = lastAssignmentOf(t.id);
    if (renderedOnce(t.id, aid)) continue;
    const thread = route(t.opener);
    if (!thread) continue;
    engine.openApprovalRequest(thread, t.id, "needs-person");
    engine.enqueueReply(`approval-req:${t.id}:${aid}`, thread,
      approvalNeeded(t.id, ticketLine(engine, t.id)));
    rendered++;
    log(`approval request rendered: #${t.id} → ${thread.split(":")[0]} ops thread`);
  }

  for (const t of engine.tickets()) {
    if (!(t.speculative && t.state === "ended")) continue;
    if (engine.db.prepare("SELECT 1 FROM delivery WHERE ticket_id = ?").get(t.id)) continue;
    const aid = lastAssignmentOf(t.id);
    if (renderedOnce(t.id, aid)) continue;
    const thread = route(t.opener);
    if (!thread) continue;
    engine.openApprovalRequest(thread, t.id, "speculative");
    engine.enqueueReply(`approval-req:${t.id}:${aid}`, thread,
      rehearsalReady(t.id, ticketLine(engine, t.id)));
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

