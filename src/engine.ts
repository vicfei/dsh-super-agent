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
  /** Display stage per docs/003: no Assignment yet ⇒ queued. */
  stage: "queued" | "ended";
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
          // ticket (docs/001–002): person-stopped resumes after revalidation; a revoked mandate
          // takes none of its waiting messages; otherwise this is new work.
          const ended = t.author.isBot ? undefined : this.db
            .prepare("SELECT * FROM ticket WHERE thread_id = ? AND opener_login = ? AND state = 'ended' ORDER BY id DESC LIMIT 1")
            .get(t.threadId, t.author.login) as Record<string, unknown> | undefined;

          if (ended && ended.stopped_by !== null && ended.revoked_reason === null) {
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

  // ── views ────────────────────────────────────────────────────────────────

  tickets(): TicketView[] {
    const rows = this.db.prepare("SELECT * FROM ticket ORDER BY id DESC").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      threadId: String(r.thread_id),
      triggerId: String(r.trigger_id),
      opener: String(r.opener_login),
      strength: r.strength as Strength,
      policyVersion: Number(r.policy_version),
      state: r.state as "open" | "ended",
      stage: r.state === "open" ? "queued" : "ended",
      ...(r.stopped_by !== null ? { stoppedBy: String(r.stopped_by) } : {}),
      ...(r.revoked_reason !== null ? { revokedReason: String(r.revoked_reason) } : {}),
      resumedCount: Number(r.resumed_count),
      createdAt: String(r.created_at),
    }));
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
