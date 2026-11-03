// Watchdog (v0.9-1, issue #58) — the article's §6 outside control loop: it observes and nudges,
// and NEVER touches admission — "should this continue" stays with the human approval surface
// (needs-person, stop, approvals). Deterministic thresholds are the guaranteed path; the optional
// LLM consult (any OpenAI-compatible endpoint, fail-closed to the rule) can only *skip* a nudge
// when it sees substantive progress in the worker's output. The executor's group-kill timeout
// remains the hard stop — the Watchdog never kills runs.

import type { Policy } from "./domain.js";
import type { Engine } from "./engine.js";
import type { ReplyChannel } from "./source.js";
import { drainReplyEffects } from "./work.js";

export interface WatchdogPolicy {
  enabled: boolean;
  /** An assignment running longer than this gets one nudge (default 30 min). */
  stuckWorkingNudgeMs: number;
  /** A needs-person ticket waiting longer than this gets one reminder (default 24 h). */
  needsPersonReminderMs: number;
  /** Consult the assessment endpoint before nudging stuck work (fail-closed to the rule). */
  consultLlm: boolean;
}

export function watchdogPolicyOf(policy: Policy): WatchdogPolicy {
  const w = policy.watchdog as Partial<WatchdogPolicy> | undefined;
  return {
    enabled: false,
    stuckWorkingNudgeMs: 30 * 60_000,
    needsPersonReminderMs: 24 * 3_600_000,
    consultLlm: false,
    ...(w ?? {}),
  };
}

export interface WatchdogLine {
  subject: string;
  action: "nudge" | "remind" | "skip-progress" | "hold";
  detail: string;
}

/** Deterministic progress check for tests; the LLM path wraps it (fail-closed to the rule). */
export type ProgressCheck = (ticketId: number, outputTail: string) => Promise<boolean>;

/**
 * One sweep: find stuck-running assignments and stale needs-person tickets, nudge/remind once
 * each (idempotent effect keys), then drain. `now` and `progress` are injected for tests.
 */
export async function runWatchdogSweep(
  engine: Engine,
  policy: Policy,
  channels: ReplyChannel[],
  opts: { now?: () => Date; progress?: ProgressCheck; log?: (l: string) => void } = {},
): Promise<WatchdogLine[]> {
  const wd = watchdogPolicyOf(policy);
  if (!wd.enabled) return [];
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const out: WatchdogLine[] = [];

  const alreadyPosted = (key: string) =>
    engine.db.prepare("SELECT 1 FROM effect WHERE kind = 'reply' AND key = ?").get(key) !== undefined;

  for (const a of engine.runningAssignments()) {
    const ageMs = now().getTime() - Date.parse(a.startedAt);
    if (ageMs < wd.stuckWorkingNudgeMs) continue;
    const key = `watchdog-nudge:${a.assignmentId}`;
    if (alreadyPosted(key)) continue;

    let nudge = true;
    if (wd.consultLlm && opts.progress) {
      try {
        const progress = await opts.progress(a.ticketId, a.outputTail);
        if (progress) {
          nudge = false;
          out.push({ subject: `ticket #${a.ticketId}`, action: "skip-progress", detail: `assignment ${a.assignmentId} running ${Math.round(ageMs / 60000)}min — model sees progress` });
        }
      } catch (e) {
        log(`watchdog consult failed (falling back to rule): ${e instanceof Error ? e.message : e}`);
      }
    }
    if (nudge) {
      engine.enqueueReply(key, a.threadId,
        `Ticket #${a.ticketId} has been running for ${Math.round(ageMs / 60000)} minutes — checking in. If it finishes, the report lands here; a person can stop it anytime. This is by an automated agent, not a human.`);
      out.push({ subject: `ticket #${a.ticketId}`, action: "nudge", detail: `assignment ${a.assignmentId} running ${Math.round(ageMs / 60000)}min` });
    }
  }

  for (const t of engine.needsPersonSince()) {
    const ageMs = now().getTime() - Date.parse(t.waitingSince);
    if (ageMs < wd.needsPersonReminderMs) continue;
    const key = `watchdog-remind:${t.ticketId}`;
    if (alreadyPosted(key)) continue;
    engine.enqueueReply(key, t.threadId,
      `Ticket #${t.ticketId} is still waiting for a person (${Math.round(ageMs / 3_600_000)}h). This is the only reminder. This is by an automated agent, not a human.`);
    out.push({ subject: `ticket #${t.ticketId}`, action: "remind", detail: `needs-person for ${Math.round(ageMs / 3_600_000)}h` });
  }

  if (out.length > 0) await drainReplyEffects(engine, channels);
  return out;
}

export interface HealthReport {
  tickets: { queued: number; working: number; "needs-person": number; ended: number };
  oldestWorkingMs: number | null;
  oldestNeedsPersonMs: number | null;
  failedEffects: number;
  pendingEffects: number;
}

/** Read-only体检 for the `health` command — no writes, no replies, safe at any time. */
export function healthReport(engine: Engine, now: Date = new Date()): HealthReport {
  const tickets = engine.tickets();
  const count = (stage: string) => tickets.filter((t) => t.stage === stage).length;
  const running = engine.runningAssignments();
  const waiting = engine.needsPersonSince();
  const age = (iso: string) => Math.max(0, now.getTime() - Date.parse(iso));
  const fx = engine.db.prepare("SELECT status, COUNT(*) c FROM effect GROUP BY status").all() as { status: string; c: number }[];
  const fxC = (s: string) => Number(fx.find((r) => r.status === s)?.c ?? 0);
  return {
    tickets: { queued: count("queued"), working: count("working"), "needs-person": count("needs-person"), ended: count("ended") },
    oldestWorkingMs: running.length ? Math.max(...running.map((a) => age(a.startedAt))) : null,
    oldestNeedsPersonMs: waiting.length ? Math.max(...waiting.map((t) => age(t.waitingSince))) : null,
    failedEffects: fxC("failed"),
    pendingEffects: fxC("pending"),
  };
}
