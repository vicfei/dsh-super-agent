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
  /** rejections recorded under the CURRENT policy version — old-era negatives don't hold a
   *  scope at "hold" forever, the same era logic shadows already follow (#148 follow-up). */
  negativesCurrent: number;
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

/** Per-judge calibration summary (#133): verdict mix and mean confidence for each judge
 *  that left scored decisions (`· <judge> <score>` in the basis). Ground-truth labeling
 *  (promote/stop outcomes per shadow) is the follow-up that upgrades this to real ECE. */
export interface JudgeStat {
  judge: string;
  positive: number;
  negative: number;
  /** fail-closed rejections — the judge never answered (endpoint error / no mass). */
  unreachable: number;
  /** mean P(admit) across the judge's scored decisions, rounded to 2dp; null = no scores. */
  meanScore: number | null;
}

export interface ReviewReport {
  window: { since: string | null; until: string; scope: string | null };
  /** the policy version this engine currently runs — the era suggestions count from. */
  currentVersion: number | null;
  overview: { decisions: number; shadows: number; autoAccepts: number; negatives: number };
  byScope: ScopeEvidence[];
  byPolicyVersion: PolicyEra[];
  topThreads: ThreadFocus[];
  byJudge: JudgeStat[];
}

function currentPolicyRows(engine: Engine): unknown {
  const row = engine.db.prepare("SELECT v FROM kv WHERE k = 'policy'").get() as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as { table?: unknown }).table : undefined;
}

function suggest(shadowsCurrent: number, negativesCurrent: number, threads: number): ScopeEvidence["suggestion"] {
  if (negativesCurrent > 0) return "hold";
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
           SUM(d.basis LIKE '%assessed negative%' AND d.policy_version = ${currentVersion ?? -1}) negativesCurrent,
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
      negativesCurrent: Number(r.negativesCurrent ?? 0),
      firstTs: r.firstTs ? String(r.firstTs) : null,
      lastTs: r.lastTs ? String(r.lastTs) : null,
      suggestion: suggest(shadowsCurrent, Number(r.negativesCurrent ?? 0), threads),
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

  // Judge stats from scored bases (decisionAssessor writes `· <judge> <score>`); SQL picks
  // the suffix out, the aggregation happens here — basis format is engine-owned, one spelling.
  const judgeRows = engine.db.prepare(`
    SELECT
      CASE WHEN d.basis LIKE '%· %' THEN SUBSTR(d.basis, INSTR(d.basis, '· ') + 2) ELSE '' END AS judge_raw,
      d.would_accept,
      d.basis
    FROM decision d JOIN trigger t ON t.id=d.trigger_id
    WHERE d.strength='inferred' AND d.basis LIKE '%· %' ${since} ${scope}`).all() as { judge_raw: string; would_accept: number; basis: string }[];
  const judges = new Map<string, { positive: number; negative: number; unreachable: number; scores: number[] }>();
  for (const r of judgeRows) {
    const raw = r.judge_raw.trim().replace(/\)$/, "");
    const m = /^([A-Za-z0-9._\/-]+) (0\.\d\d|1\.00)$/.exec(raw) ?? /^([A-Za-z0-9._\/-]+) (unreachable)$/.exec(raw);
    if (!m) continue; // foreign basis text that happens to contain '·' — skip, not ours
    const j = judges.get(m[1]) ?? { positive: 0, negative: 0, unreachable: 0, scores: [] };
    if (m[2] === "unreachable") { j.unreachable++; judges.set(m[1], j); continue; }
    if (r.basis.includes("assessed negative")) j.negative++; else j.positive++;
    j.scores.push(Number(m[2]));
    judges.set(m[1], j);
  }
  const byJudge: JudgeStat[] = [...judges.entries()]
    .map(([judge, j]) => ({ judge, positive: j.positive, negative: j.negative, unreachable: j.unreachable, meanScore: j.scores.length ? Math.round((100 * j.scores.reduce((a, b) => a + b, 0)) / j.scores.length) / 100 : null }))
    .sort((a, b) => (b.positive + b.negative + b.unreachable) - (a.positive + a.negative + a.unreachable));

  return {
    currentVersion,
    window: { since: opts.sinceIso ?? null, until: new Date().toISOString(), scope: opts.scope ?? null },
    overview: { decisions: Number(overview.decisions ?? 0), shadows: Number(overview.shadows ?? 0), autoAccepts: Number(overview.autoAccepts ?? 0), negatives: Number(overview.negatives ?? 0) },
    byScope, byPolicyVersion, topThreads, byJudge,
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
  if (r.byJudge.length > 0) {
    L.push(`## judges (BYO-judge calibration — verdict mix and mean confidence)`);
    for (const j of r.byJudge) L.push(`- ${j.judge}: ${j.positive} admit / ${j.negative} reject · mean P(admit) ${j.meanScore ?? "—"}${j.unreachable > 0 ? ` · ⚠ ${j.unreachable} unreachable` : ""}`);
    L.push(``);
  }
  L.push(`> suggestion is a heuristic from recorded evidence only; the rung is granted by a person, by policy.`);
  return L.join("\n");
}
