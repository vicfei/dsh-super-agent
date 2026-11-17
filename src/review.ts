// `dsh review` — the computable promotion review (v1.6, the earned-autonomy release).
// Pure reads over the engine's own tables: longitudinal trust per scope and per policy
// era, from the same decision rows `dsh stats` counts. Where stats answers "what
// happened", review answers "has this scope earned the next rung" — the Month-N review
// made computable, one command, no narrative required.

import type { Engine } from "./engine.js";

export interface ReviewWindow {
  /** ISO ts — window start (default: everything). */
  sinceIso?: string;
  /** Restrict to one admission scope. */
  scope?: string;
}

export interface ScopeEvidence {
  scope: string;
  /** observe-mode shadow decisions (would-accept) — evidence accumulated. */
  shadows: number;
  /** auto-mode inferred accepts — rungs already granted. */
  autoAccepts: number;
  /** inferred candidates the assessor rejected — evidence against. */
  assessorNegatives: number;
  /** distinct threads behind the shadows — breadth, not one noisy thread. */
  threads: number;
  /** shadows recorded under the CURRENT policy version — old-era shadows don't earn rungs. */
  shadowsCurrent: number;
  /** this scope already holds a per-scope auto rung (policy row override). */
  autoGranted: boolean;
  firstTs: string | null;
  lastTs: string | null;
  /** auto-candidate | hold | insufficient — a heuristic, the human decides. */
  suggestion: "auto-candidate" | "hold" | "insufficient";
}

export interface PolicyEra {
  version: number;
  decisions: number;
  wouldAccept: number;
}

export interface ThreadFocus {
  threadId: string;
  wouldAccept: number;
  lastTs: string;
}

export interface ReviewReport {
  window: { since: string | null; until: string; scope: string | null };
  /** the policy version this engine currently runs — the era suggestions count from. */
  currentVersion: number | null;
  overview: { decisions: number; shadows: number; autoAccepts: number; negatives: number };
  byScope: ScopeEvidence[];
  byPolicyVersion: PolicyEra[];
  topThreads: ThreadFocus[];
}

function currentPolicyRows(engine: Engine): unknown {
  const row = engine.db.prepare("SELECT v FROM kv WHERE k = 'policy'").get() as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as { table?: unknown }).table : undefined;
}

function suggest(shadowsCurrent: number, negatives: number, threads: number): ScopeEvidence["suggestion"] {
  if (negatives > 0) return "hold";
  if (shadowsCurrent >= 10 && threads >= 3) return "auto-candidate";
  return "insufficient";
}

export function reviewReport(engine: Engine, opts: ReviewWindow = {}): ReviewReport {
  const since = opts.sinceIso ? `AND d.ts >= '${opts.sinceIso}'` : "";
  const scope = opts.scope ? `AND t.scope = '${opts.scope}'` : "";
  const row = (sql: string) => engine.db.prepare(sql).get() as Record<string, unknown> ?? {};

  const overview = row(`
    SELECT COUNT(*) decisions,
           SUM(d.kind='ignore' AND d.would_accept=1) shadows,
           SUM(d.kind='accept' AND d.strength='inferred') autoAccepts,
           SUM(d.basis LIKE '%assessed negative%') negatives
    FROM decision d JOIN trigger t ON t.id=d.trigger_id WHERE 1=1 ${since} ${scope}`);

  const currentVersion = (engine.db.prepare("SELECT v FROM kv WHERE k = 'policy'").get() as { v: string } | undefined)
    ? (JSON.parse((engine.db.prepare("SELECT v FROM kv WHERE k = 'policy'").get() as { v: string }).v) as { version: number }).version
    : null;

  const scopeRows = engine.db.prepare(`
    SELECT t.scope, 
           SUM(d.kind='ignore' AND d.would_accept=1) shadows,
           SUM(d.kind='ignore' AND d.would_accept=1 AND d.policy_version = ${currentVersion ?? -1}) shadowsCurrent,
           SUM(d.kind='accept' AND d.strength='inferred') autoAccepts,
           SUM(d.basis LIKE '%assessed negative%') negatives,
           COUNT(DISTINCT CASE WHEN d.would_accept=1 THEN t.thread_id END) threads,
           MIN(d.ts) firstTs, MAX(d.ts) lastTs
    FROM decision d JOIN trigger t ON t.id=d.trigger_id WHERE 1=1 ${since} ${scope}
    GROUP BY t.scope ORDER BY shadows + autoAccepts DESC`).all() as Record<string, unknown>[];

  const grantedScopes = new Set(
    ((currentPolicyRows(engine) ?? []) as { scope: string; acceptMode?: string }[])
      .filter((row) => row.acceptMode === "auto")
      .map((row) => row.scope),
  );
  const byScope: ScopeEvidence[] = scopeRows.map((r) => {
    const shadows = Number(r.shadows ?? 0), negatives = Number(r.negatives ?? 0), threads = Number(r.threads ?? 0);
    const shadowsCurrent = Number(r.shadowsCurrent ?? 0);
    return {
      scope: String(r.scope),
      shadows,
      shadowsCurrent,
      autoAccepts: Number(r.autoAccepts ?? 0),
      assessorNegatives: negatives,
      threads,
      firstTs: r.firstTs ? String(r.firstTs) : null,
      lastTs: r.lastTs ? String(r.lastTs) : null,
      suggestion: suggest(shadowsCurrent, negatives, threads),
      autoGranted: grantedScopes.has(String(r.scope)),
    };
  });

  const byPolicyVersion = (engine.db.prepare(`
    SELECT policy_version version, COUNT(*) decisions, SUM(would_accept=1) wouldAccept
    FROM decision WHERE 1=1 ${since} GROUP BY policy_version ORDER BY policy_version`).all() as Record<string, unknown>[])
    .map((r) => ({ version: Number(r.version), decisions: Number(r.decisions), wouldAccept: Number(r.wouldAccept ?? 0) }));

  const topThreads = (engine.db.prepare(`
    SELECT t.thread_id, SUM(d.would_accept=1) wa, MAX(d.ts) lastTs
    FROM decision d JOIN trigger t ON t.id=d.trigger_id
    WHERE d.would_accept=1 ${since} ${scope}
    GROUP BY t.thread_id ORDER BY wa DESC LIMIT 5`).all() as Record<string, unknown>[])
    .map((r) => ({ threadId: String(r.thread_id), wouldAccept: Number(r.wa), lastTs: String(r.lastTs) }));

  return {
    currentVersion,
    window: { since: opts.sinceIso ?? null, until: new Date().toISOString(), scope: opts.scope ?? null },
    overview: { decisions: Number(overview.decisions ?? 0), shadows: Number(overview.shadows ?? 0), autoAccepts: Number(overview.autoAccepts ?? 0), negatives: Number(overview.negatives ?? 0) },
    byScope, byPolicyVersion, topThreads,
  };
}

export function formatReview(r: ReviewReport): string {
  const L: string[] = [];
  L.push(`# review — the computable promotion review`);
  L.push(`window: ${r.window.since ?? "(all)"} → ${r.window.until}${r.window.scope ? ` · scope=${r.window.scope}` : ""}`);
  L.push(``);
  L.push(`overview: ${r.overview.decisions} decisions · ${r.overview.shadows} shadows (would-accept) · ${r.overview.autoAccepts} auto-accepts · ${r.overview.negatives} assessor rejections`);
  L.push(``);
  L.push(`## scope evidence (the ladder rungs)`);
  L.push(`| scope | shadows (current era) | threads | auto-accepts | rejections | span | suggestion |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const s of r.byScope) {
    const sc = s.shadows === s.shadowsCurrent ? `${s.shadows}` : `${s.shadows} (${s.shadowsCurrent} under v${r.currentVersion ?? "?"})`;
    const mark = s.autoGranted ? "🟢 GRANTED " : "";
    L.push(`| ${s.scope} | ${sc} | ${s.threads} | ${s.autoAccepts} | ${s.assessorNegatives} | ${s.firstTs?.slice(0, 10) ?? "—"}→${s.lastTs?.slice(0, 10) ?? "—"} | ${mark}**${s.suggestion}** |`);
  }
  L.push(``);
  L.push(`## policy eras (admission learning, one row per version)`);
  for (const p of r.byPolicyVersion) L.push(`- v${p.version}: ${p.decisions} decisions, ${p.wouldAccept} would-accept (${p.decisions ? Math.round((100 * p.wouldAccept) / p.decisions) : 0}%)`);
  L.push(``);
  L.push(`## thread focus (top would-accept)`);
  for (const t of r.topThreads) L.push(`- ${t.threadId} — ${t.wouldAccept}× (last ${t.lastTs.slice(0, 10)})`);
  L.push(``);
  L.push(`> suggestion is a heuristic from recorded evidence only; the rung is granted by a person, by policy.`);
  return L.join("\n");
}
