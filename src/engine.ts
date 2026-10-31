// Engine — the sole writer of domain aggregates, following dsh-superagent-prototype docs/007:
// synchronous methods, one transaction per command, external work enqueued as durable effects
// (outbox) inside the transaction and executed after commit. Domain semantics from docs/001–003:
//   - a Trigger accepted twice yields one Ticket (ingest idempotence)
//   - accept creates a Mandate; a person's stop withdraws it; failed revalidation revokes it
//   - a person's message on their own thread resumes an ended (person-stopped) Ticket
//   - weakening policy does not kill open Tickets; resume revalidates against current policy

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { clipReply } from "./clip.js";
import type { Policy, Strength, Trigger } from "./domain.js";
import type { GateResult, Resolution } from "./gate.js";
import type { Feed, SourceState } from "./github/state.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS trigger (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL, scope TEXT NOT NULL, thread_id TEXT NOT NULL,
  author_login TEXT NOT NULL, author_is_bot INTEGER NOT NULL,
  addressing INTEGER NOT NULL, body TEXT NOT NULL, ts TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trigger_thread ON trigger(thread_id);

CREATE TABLE IF NOT EXISTS decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL REFERENCES trigger(id),
  kind TEXT NOT NULL,                 -- accept | ignore | unavailable
  strength TEXT, basis TEXT NOT NULL, would_accept INTEGER NOT NULL DEFAULT 0,
  policy_version INTEGER NOT NULL, ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL REFERENCES trigger(id),
  opener_login TEXT NOT NULL,
  strength TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  basis TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', -- open | ended
  stopped_by TEXT, stopped_at TEXT,
  revoked_reason TEXT,
  resumed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_thread ON ticket(thread_id);

CREATE TABLE IF NOT EXISTS effect (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_due_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS idx_effect_due ON effect(status, next_due_at);

CREATE TABLE IF NOT EXISTS assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES ticket(id),
  state TEXT NOT NULL DEFAULT 'running', -- running | ended
  worktree TEXT,
  exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignment_ticket ON assignment(ticket_id);
`;

export interface IngestItem {
  trigger: Trigger;
  gate: GateResult;
  resolution: Resolution;
}

export interface IngestReport {
  fresh: number;
  duplicates: number;
  ticketsOpened: number;
  resumed: number;
  refusals: string[];
}

export interface TicketView {
  id: number;
  threadId: string;
  triggerId: string;
  opener: string;
  strength: Strength;
  policyVersion: number;
  state: "open" | "ended";
  /** queued (no assignment) / working / needs-person (failed assignment) / ended. */
  stage: "queued" | "working" | "needs-person" | "ended";
  stoppedBy?: string;
  revokedReason?: string;
  resumedCount: number;
  createdAt: string;
}

export interface EffectRow {
  id: number;
  kind: string;
  key: string;
  payload: unknown;
  attempts: number;
}

export interface DecisionView {
  id: number;
  kind: "accept" | "ignore" | "unavailable";
  strength?: Strength;
  basis: string;
  wouldAccept: boolean;
  policyVersion: number;
  ts: string;
  threadId: string;
  author: string;
  isBot: boolean;
  scope: string;
  addressing: boolean;
  excerpt: string;
}

const MAX_EFFECT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 300_000;

export class Engine {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000"); // panel's quick writes alongside poll
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── policy (kv) ──────────────────────────────────────────────────────────

  /** Store the current Policy if its version differs — open Tickets keep their mandate. */
  setPolicyIfChanged(policy: Policy): boolean {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = 'policy'").get() as { v: string } | undefined;
    if (row && (JSON.parse(row.v) as Policy).version === policy.version) return false;
    this.db
      .prepare("INSERT INTO kv (k, v) VALUES ('policy', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(JSON.stringify(policy));
    return true;
  }

  /** Panel command acting directly: switch acceptMode, versioned. */
  setAcceptMode(mode: Policy["acceptMode"]): Policy | undefined {
    const current = this.policy();
    if (!current) return undefined;
    if (current.acceptMode === mode) return current;
    const next: Policy = { ...current, acceptMode: mode, version: current.version + 1 };
    this.setPolicyIfChanged(next);
    return next;
  }

  policy(): Policy | undefined {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = 'policy'").get() as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as Policy) : undefined;
  }

  positions(): SourceState {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = 'positions'").get() as { v: string } | undefined;
    const zeros: Record<Feed, number> = { issue: 0, issue_comment: 0, pr: 0, review_comment: 0 };
    return { positions: row ? { ...zeros, ...(JSON.parse(row.v) as Record<Feed, number>) } : zeros };
  }

  /** Comment ids the agent itself posted — the Source must never re-ingest them (self-echo). */
  selfPosted(): Set<string> {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = 'self_posted'").get() as { v: string } | undefined;
    return new Set<string>(row ? (JSON.parse(row.v) as string[]) : []);
  }

  markSelfPosted(commentId: number): void {
    const all = this.selfPosted();
    all.add(`github:issue_comment:${commentId}`);
    this.db
      .prepare("INSERT INTO kv (k, v) VALUES ('self_posted', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(JSON.stringify([...all]));
  }

  // ── ingest (one transaction: triggers + decisions + tickets + resume + positions) ──

  ingest(batch: IngestItem[], nextPositions?: SourceState): IngestReport {
    const now = new Date().toISOString();
    const report: IngestReport = { fresh: 0, duplicates: 0, ticketsOpened: 0, resumed: 0, refusals: [] };
    const policy = this.policy();
    const policyVersion = policy?.version ?? 0;

    const insertTrigger = this.db.prepare(`INSERT OR IGNORE INTO trigger
      (id, source, scope, thread_id, author_login, author_is_bot, addressing, body, ts, ingested_at)
      VALUES (@id, @source, @scope, @threadId, @login, @isBot, @addressing, @body, @ts, @now)`);
    const insertDecision = this.db.prepare(`INSERT INTO decision
      (trigger_id, kind, strength, basis, would_accept, policy_version, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertTicket = this.db.prepare(`INSERT INTO ticket
      (thread_id, trigger_id, opener_login, strength, policy_version, basis, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const enqueue = this.db.prepare(`INSERT INTO effect (kind, key, payload, status, attempts, next_due_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload, status = 'pending',
        attempts = 0, next_due_at = excluded.next_due_at, last_error = NULL, updated_at = excluded.updated_at`);
    const savePositions = this.db.prepare(
      "INSERT INTO kv (k, v) VALUES ('positions', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );

    this.db.transaction(() => {
      for (const item of batch) {
        const t = item.trigger;
        const known = insertTrigger.run({
          id: t.id, source: t.source, scope: t.scope, threadId: t.threadId,
          login: t.author.login, isBot: t.author.isBot ? 1 : 0,
          addressing: t.addressing ? 1 : 0, body: t.body, ts: t.ts, now,
        });
        if (known.changes === 0) {
          report.duplicates++; // accepting one Trigger twice yields one Ticket — and one decision
          continue;
        }
        report.fresh++;

        const kind = item.resolution.action === "accept" ? "accept"
          : item.resolution.action === "shadow" ? "ignore" : "ignore";
        const strength = item.gate.strength ?? null;
        const wouldAccept = item.resolution.action === "shadow" ? 1 : 0;
        const basis = "basis" in item.resolution ? item.resolution.basis : item.gate.basis;
        insertDecision.run(t.id, kind, strength, basis, wouldAccept, policyVersion, now);

        if (item.resolution.action === "accept") {
          // An admitted message from an opener with an ended ticket on this thread goes to that
          // ticket (docs/002: "Ended Tickets keep Mandates; a person's message on their own
          // Threads resumes them"); a revoked mandate takes none of its waiting messages;
          // otherwise this is new work.
          const ended = t.author.isBot ? undefined : this.db
            .prepare("SELECT * FROM ticket WHERE thread_id = ? AND opener_login = ? AND state = 'ended' ORDER BY id DESC LIMIT 1")
            .get(t.threadId, t.author.login) as Record<string, unknown> | undefined;

          if (ended && ended.revoked_reason === null) {
            const failReason = this.revalidateFailReason(ended, policy, t.author.login);
            if (failReason) {
              this.db.prepare("UPDATE ticket SET revoked_reason = ?, updated_at = ? WHERE id = ?").run(failReason, now, ended.id);
              report.refusals.push(`ticket #${ended.id} stays ended — ${failReason}`);
            } else {
              this.db
                .prepare("UPDATE ticket SET state = 'open', resumed_count = resumed_count + 1, updated_at = ? WHERE id = ?")
                .run(now, ended.id);
              report.resumed++;
              enqueue.run("reply", `ticket-resume:${ended.id}:${Number(ended.resumed_count) + 1}`,
                JSON.stringify(replyPayload(t, Number(ended.id), "resumed", ended.strength as Strength)), now, now, now);
            }
          } else if (ended && ended.revoked_reason !== null) {
            report.refusals.push(`ticket #${ended.id} stays ended — mandate revoked`);
          } else {
            const info = insertTicket.run(t.threadId, t.id, t.author.login, strength, policyVersion, basis, now, now);
            const ticketId = Number(info.lastInsertRowid);
            report.ticketsOpened++;
            enqueue.run("reply", `ticket-open:${ticketId}`, JSON.stringify(replyPayload(t, ticketId, "opened", strength as Strength)), now, now, now);
          }
        }
      }
      if (nextPositions) savePositions.run(JSON.stringify(nextPositions.positions));
    })();

    return report;
  }

  /** Revalidation before resume (docs/002): inferred additionally requires auto; an
   *  allowed-list-based basis additionally requires the author to still be listed. */
  private revalidateFailReason(ticket: Record<string, unknown>, policy: Policy | undefined, authorLogin: string): string | undefined {
    if (ticket.strength === "inferred" && policy?.acceptMode !== "auto") {
      return "revalidation failed: inferred mandate requires acceptMode=auto";
    }
    if (String(ticket.basis).includes("allowed")) {
      const allowed = (policy?.allowedList ?? []).map((s) => s.toLowerCase());
      if (!allowed.includes(authorLogin.toLowerCase())) {
        return `revalidation failed: ${authorLogin} no longer allowed`;
      }
    }
    return undefined;
  }

  // ── person commands (panel command acting directly — docs/002) ───────────

  /** A person's stop withdraws the Mandate and ends the Ticket. */
  stopTicket(id: number, byLogin: string): boolean {
    const now = new Date().toISOString();
    const r = this.db
      .prepare("UPDATE ticket SET state = 'ended', stopped_by = ?, stopped_at = ?, updated_at = ? WHERE id = ? AND state = 'open'")
      .run(byLogin, now, now, id);
    return r.changes > 0;
  }

  // ── assignments (docs/001: the binding of a Ticket to one Executor instance) ──

  /** Open tickets claimable by work: never assigned, or last assignment ended cleanly
   *  (a resumed ticket is re-claimable; a failed one waits for a person). */
  claimQueued(limit: number): { id: number; threadId: string; body: string; author: string }[] {
    const rows = this.db.prepare(`
      SELECT t.id, t.thread_id, tr.body, tr.author_login
      FROM ticket t JOIN trigger tr ON tr.id = t.trigger_id
      LEFT JOIN assignment la ON la.ticket_id = t.id
        AND la.id = (SELECT MAX(b.id) FROM assignment b WHERE b.ticket_id = t.id)
      WHERE t.state = 'open' AND (la.id IS NULL OR (la.state = 'ended' AND la.exit_code = 0))
      ORDER BY t.id LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), threadId: String(r.thread_id),
      body: String(r.body), author: String(r.author_login),
    }));
  }

  startAssignment(ticketId: number, worktree: string): number {
    const r = this.db
      .prepare("INSERT INTO assignment (ticket_id, worktree, started_at) VALUES (?, ?, ?)")
      .run(ticketId, worktree, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  endAssignment(id: number, exitCode: number | null, timedOut: boolean, output: string): void {
    this.db
      .prepare("UPDATE assignment SET state = 'ended', exit_code = ?, timed_out = ?, output = ?, ended_at = ? WHERE id = ?")
      .run(exitCode, timedOut ? 1 : 0, output.slice(0, 65536), new Date().toISOString(), id);
  }

  /** A ready report ends the Ticket completed (stopped_by stays NULL ⇒ new work opens a new ticket). */
  completeTicket(id: number): boolean {
    const r = this.db
      .prepare("UPDATE ticket SET state = 'ended', updated_at = ? WHERE id = ? AND state = 'open'")
      .run(new Date().toISOString(), id);
    return r.changes > 0;
  }

  /** Public reply enqueue for adapters acting after commit (work reports, notices). */
  enqueueReply(key: string, threadId: string, body: string): void {
    const now = new Date().toISOString();
    const n = threadId.match(/\/(issues|pulls)\/(\d+)$/);
    this.db.prepare(`INSERT INTO effect (kind, key, payload, status, attempts, next_due_at, created_at, updated_at)
      VALUES ('reply', ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload, status = 'pending',
        attempts = 0, next_due_at = excluded.next_due_at, last_error = NULL, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify({ threadId, issueNumber: n ? Number(n[2]) : null, body }), now, now, now);
  }

  // ── views ────────────────────────────────────────────────────────────────

  /** Recent decisions with trigger context — the audit trail (panel + observe records). */
  decisions(limit = 50): DecisionView[] {
    const rows = this.db.prepare(`
      SELECT d.id, d.kind, d.strength, d.basis, d.would_accept, d.policy_version, d.ts,
             t.thread_id, t.author_login, t.author_is_bot, t.scope, t.addressing,
             substr(t.body, 1, 160) AS excerpt
      FROM decision d JOIN trigger t ON t.id = d.trigger_id
      ORDER BY d.id DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind) as "accept" | "ignore" | "unavailable",
      strength: (r.strength as Strength | null) ?? undefined,
      basis: String(r.basis),
      wouldAccept: r.would_accept === 1,
      policyVersion: Number(r.policy_version),
      ts: String(r.ts),
      threadId: String(r.thread_id),
      author: String(r.author_login),
      isBot: r.author_is_bot === 1,
      scope: String(r.scope),
      addressing: r.addressing === 1,
      excerpt: String(r.excerpt ?? ""),
    }));
  }

  tickets(): TicketView[] {
    const rows = this.db.prepare("SELECT * FROM ticket ORDER BY id DESC").all() as Record<string, unknown>[];
    const lastAssignment = new Map<number, { state: string; exitCode: number | null }>();
    for (const a of this.db.prepare("SELECT ticket_id, state, exit_code FROM assignment ORDER BY id").all() as Record<string, unknown>[]) {
      lastAssignment.set(Number(a.ticket_id), { state: String(a.state), exitCode: a.exit_code === null ? null : Number(a.exit_code) });
    }
    return rows.map((r) => {
      const id = Number(r.id);
      const state = r.state as "open" | "ended";
      const a = lastAssignment.get(id);
      const stage: TicketView["stage"] = state === "ended"
        ? "ended"
        : !a ? "queued"
        : a.state === "running" ? "working"
        : a.exitCode === 0 ? "queued" // ended cleanly but ticket reopened (resume) — re-claimable
        : "needs-person"; // failed assignment awaits a person (docs/003 person stage)
      return {
        id,
        threadId: String(r.thread_id),
        triggerId: String(r.trigger_id),
        opener: String(r.opener_login),
        strength: r.strength as Strength,
        policyVersion: Number(r.policy_version),
        state,
        stage,
        ...(r.stopped_by !== null ? { stoppedBy: String(r.stopped_by) } : {}),
        ...(r.revoked_reason !== null ? { revokedReason: String(r.revoked_reason) } : {}),
        resumedCount: Number(r.resumed_count),
        createdAt: String(r.created_at),
      };
    });
  }

  // ── effects (outbox) ─────────────────────────────────────────────────────

  takeDue(now = new Date()): EffectRow[] {
    const rows = this.db
      .prepare("SELECT * FROM effect WHERE status = 'pending' AND (next_due_at IS NULL OR next_due_at <= ?) ORDER BY id")
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), kind: String(r.kind), key: String(r.key),
      payload: JSON.parse(String(r.payload)), attempts: Number(r.attempts),
    }));
  }

  completeEffect(id: number): void {
    this.db.prepare("UPDATE effect SET status = 'done', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  /** Retryable failures back off exponentially (5s→300s cap); the 5th failure is terminal. */
  failEffect(id: number, error: string, retryable = true): void {
    const now = new Date();
    const row = this.db.prepare("SELECT attempts FROM effect WHERE id = ?").get(id) as { attempts: number } | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    if (!retryable || attempts >= MAX_EFFECT_ATTEMPTS) {
      this.db.prepare("UPDATE effect SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, error, now.toISOString(), id);
      return;
    }
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
    this.db.prepare("UPDATE effect SET attempts = ?, next_due_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(attempts, new Date(now.getTime() + delay).toISOString(), error, now.toISOString(), id);
  }
}

function replyPayload(t: Trigger, ticketId: number, verb: "opened" | "resumed", strength: Strength): unknown {
  const n = t.threadId.match(/\/(issues|pulls)\/(\d+)$/);
  return {
    threadId: t.threadId,
    issueNumber: n ? Number(n[2]) : null,
    body: clipReply(`Ticket #${ticketId} ${verb} (${strength}). This is by an automated agent, not a human.`),
  };
}
