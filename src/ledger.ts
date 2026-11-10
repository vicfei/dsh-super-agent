// The evidence ledger (v1.5, issue #119) — an append-only, hash-chained event log.
// Every state transition the engine performs emits one row; each row carries the hash of
// its predecessor, so `dsh events verify` can prove the audit trail was never edited or
// silently truncated after the fact. The ledger starts at adoption (no backfill); the
// normalized tables remain the source of truth for views — this is evidence, not state.
//
// Hashing: entry_hash = sha256(kind + "\u241f" + payload + "\u241f" + prev_hash), with the
// payload exactly as stored (JSON.stringify at emit time — the stored string is re-hashed
// at verify time, so serialization is stable by construction). The genesis row's
// prev_hash is 64 zeros.

import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";

export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE
);
`;

export interface LedgerRow {
  id: number;
  ts: string;
  kind: string;
  payload: string;
  prev_hash: string;
  entry_hash: string;
}

export interface LedgerEvent {
  id: number;
  ts: string;
  kind: string;
  payload: unknown;
}

const GENESIS = "0".repeat(64);
const SEP = "\u241f"; // field separator that cannot appear in kinds or hex hashes

function hashOf(kind: string, payload: string, prev: string): string {
  return createHash("sha256").update(`${kind}${SEP}${payload}${SEP}${prev}`).digest("hex");
}

export class EventLedger {
  constructor(private readonly db: Database) {
    this.db.exec(LEDGER_SCHEMA);
  }

  /** Append one transition. Called synchronously with the state change it describes. */
  emit(kind: string, payload: Record<string, unknown> = {}): number {
    const ts = new Date().toISOString();
    const body = JSON.stringify(payload);
    const prev = (this.db.prepare("SELECT entry_hash h FROM event_log ORDER BY id DESC LIMIT 1").get() as { h: string } | undefined)?.h ?? GENESIS;
    const entry = hashOf(kind, body, prev);
    const info = this.db
      .prepare("INSERT INTO event_log (ts, kind, payload, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?)")
      .run(ts, kind, body, prev, entry);
    return Number(info.lastInsertRowid);
  }

  /** Cursor read for the panel/CLI: rows after `afterId`, oldest first. */
  eventsAfter(afterId: number, limit = 50): LedgerEvent[] {
    const rows = this.db
      .prepare("SELECT id, ts, kind, payload FROM event_log WHERE id > ? ORDER BY id LIMIT ?")
      .all(afterId, limit) as { id: number; ts: string; kind: string; payload: string }[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload) }));
  }

  /** Recompute the whole chain. Returns the first broken row, or ok: true. */
  verify(): { ok: true; count: number } | { ok: false; count: number; firstBadId: number; reason: string } {
    const rows = this.db.prepare("SELECT id, kind, payload, prev_hash, entry_hash FROM event_log ORDER BY id").all() as LedgerRow[];
    let prev = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev) return { ok: false, count: rows.length, firstBadId: r.id, reason: `prev_hash does not chain (expected ${prev.slice(0, 12)}…, stored ${r.prev_hash.slice(0, 12)}…)` };
      const recomputed = hashOf(r.kind, r.payload, r.prev_hash);
      if (recomputed !== r.entry_hash) return { ok: false, count: rows.length, firstBadId: r.id, reason: `entry_hash mismatch — row was edited after the fact` };
      prev = r.entry_hash;
    }
    return { ok: true, count: rows.length };
  }
}
