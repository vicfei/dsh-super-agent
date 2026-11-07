// `dsh stats` — the numbers behind the trust story (v1.3). Pure reads over the engine's
// own tables: what the gate decided, what the clock honored, how long decisions waited.
// No new state — every figure is a query, every figure is auditable in the decision log.

import type { Engine } from "./engine.js";

export interface StatsWindow {
  /** ISO ts — the window's start (default: everything). */
  sinceIso?: string;
}

export interface GateStats {
  decisions: number;
  accepted: number;
  wouldAccept: number;
  rejected: number;
  bySource: Record<string, number>;
}

export interface RoutineStats {
  id: string;
  fires: number;
  firstTs: string | null;
  lastTs: string | null;
}

export interface StatsReport {
  window: { since: string | null; until: string };
  gate: GateStats;
  tickets: { opened: number; resumed: number; joined: number; needsPerson: number; ended: number };
  /** median minutes from ticket creation to its first completed assignment (cycle time) */
  medianCycleMin: number | null;
  approvalTurnaroundMin: number | null;
  routines: RoutineStats[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export function runStats(engine: Engine, opts: StatsWindow = {}): StatsReport {
  const until = new Date().toISOString();
  const since = opts.sinceIso ?? null;
  const inWindow = (ts: string) => (since ? ts >= since : true);

  // gate: decisions + their shapes (source from the trigger row)
  const decisions = (
    engine.db.prepare(`
      SELECT d.kind, d.would_accept, t.source, d.ts FROM decision d
      JOIN trigger t ON t.id = d.trigger_id ${since ? "WHERE d.ts >= ?" : ""}
      ORDER BY d.id`).all(...(since ? [since] : [])) as { kind: string; would_accept: number; source: string; ts: string }[]
  ).filter((r) => inWindow(r.ts));
  const bySource: Record<string, number> = {};
  for (const d of decisions) bySource[d.source] = (bySource[d.source] ?? 0) + 1;
  const gate: GateStats = {
    decisions: decisions.length,
    accepted: decisions.filter((d) => d.kind === "accept").length,
    wouldAccept: decisions.filter((d) => d.would_accept === 1).length,
    rejected: decisions.filter((d) => d.kind === "ignore" && d.would_accept === 0).length,
    bySource,
  };

  // tickets: lifecycle counters from the tickets table itself
  const tickets = engine.tickets().filter((t) => inWindow(t.createdAt));
  const needsPerson = (
    engine.db.prepare(`
      SELECT t.id, t.created_at FROM ticket t
      LEFT JOIN assignment la ON la.ticket_id = t.id AND la.id = (SELECT MAX(b.id) FROM assignment b WHERE b.ticket_id = t.id)
      WHERE t.state = 'open' AND la.state = 'ended' AND (la.exit_code IS NULL OR la.exit_code != 0)`).all() as { id: number }[]
  ).map((r) => r.id);

  // cycle time: creation → first clean (exit 0) assignment end, in minutes
  const cycles = (
    engine.db.prepare(`
      SELECT t.created_at, MIN(a.ended_at) AS done FROM ticket t
      JOIN assignment a ON a.ticket_id = t.id AND a.exit_code = 0 AND a.ended_at IS NOT NULL
      ${since ? "WHERE t.created_at >= ?" : ""}
      GROUP BY t.id`).all(...(since ? [since] : [])) as { created_at: string; done: string }[]
  ).filter((r) => inWindow(r.created_at));
  const medianCycleMin = median(cycles.map((c) => (Date.parse(c.done) - Date.parse(c.created_at)) / 60_000));

  // approval turnaround: request created → resolved, minutes
  const turns = (
    engine.db.prepare(`
      SELECT created_at, resolved_at FROM approval_request
      WHERE resolved_at IS NOT NULL ${since ? "AND created_at >= ?" : ""}`).all(...(since ? [since] : [])) as { created_at: string; resolved_at: string }[]
  ).filter((r) => inWindow(r.created_at));
  const approvalTurnaroundMin = median(turns.map((t) => (Date.parse(t.resolved_at) - Date.parse(t.created_at)) / 60_000));

  // the clock: timer triggers honored per routine
  const timerRows = (
    engine.db.prepare(`SELECT id, ts FROM trigger WHERE source = 'timer' ${since ? "AND ts >= ?" : ""} ORDER BY ts`).all(...(since ? [since] : [])) as { id: string; ts: string }[]
  ).filter((r) => inWindow(r.ts));
  const groups = new Map<string, { ts: string }[]>();
  for (const row of timerRows) {
    const id = row.id.split(":")[1] ?? "(unknown)";
    (groups.get(id) ?? groups.set(id, []).get(id)!).push({ ts: row.ts });
  }
  const routines: RoutineStats[] = [...groups.entries()].map(([id, rows]) => ({
    id,
    fires: rows.length,
    firstTs: rows[0]?.ts ?? null,
    lastTs: rows[rows.length - 1]?.ts ?? null,
  }));

  return {
    window: { since, until },
    gate,
    tickets: {
      opened: tickets.length,
      resumed: tickets.reduce((n, t) => n + t.resumedCount, 0),
      joined: tickets.reduce((n, t) => n + t.followUps, 0),
      needsPerson: needsPerson.length,
      ended: tickets.filter((t) => t.state === "ended").length,
    },
    medianCycleMin,
    approvalTurnaroundMin,
    routines,
  };
}

/** One line per section — the digest/panel rendering. */
export function formatStats(r: StatsReport): string {
  const src = Object.entries(r.gate.bySource).map(([k, v]) => `${k}:${v}`).join(" ") || "—";
  const clock = r.routines.map((x) => `${x.id} ×${x.fires}${x.lastTs ? ` (last ${x.lastTs.slice(5, 16).replace("T", " ")})` : ""}`).join(" · ") || "off";
  return [
    `window: ${r.window.since ? r.window.since.slice(0, 16).replace("T", " ") : "all time"} → ${r.window.until.slice(0, 16).replace("T", " ")}`,
    `gate: ${r.gate.decisions} decisions (${src}) — ${r.gate.accepted} accepted · ${r.gate.wouldAccept} would-accept · ${r.gate.rejected} gated out`,
    `tickets: ${r.tickets.opened} opened · ${r.tickets.resumed} resumed · ${r.tickets.joined} follow-ups joined · ${r.tickets.needsPerson} awaiting a person`,
    `cycle: median ${r.medianCycleMin ?? "—"} min ticket→done · approval turnaround ${r.approvalTurnaroundMin ?? "—"} min`,
    `clock: ${clock}`,
  ].join("\n");
}
