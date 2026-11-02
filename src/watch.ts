// watch — the daemon: poll → gate/assess → ingest → claim → execute → report → drain,
// one process, forever (or until SIGINT/SIGTERM — the current cycle finishes first).
// Interval gets jitter so a fleet of watchers doesn't thunder-herd the API; errors
// back off exponentially up to a 10-minute cap instead of dying.

import type { Policy, Trigger } from "./domain.js";
import type { Engine } from "./engine.js";
import type { GitHubSource } from "./github/source.js";
import type { Executor } from "./executor.js";
import type { GitHubClient } from "./github/client.js";
import { classify, formatOutcome } from "./runner.js";
import { runWork } from "./work.js";

export type AssessmentFn = (t: Trigger) => Promise<"positive" | "negative"> | "positive" | "negative";

export interface WatchOptions {
  engine: Engine;
  source: GitHubSource;
  executor: Executor;
  client: GitHubClient | null;
  repo: string;
  policy: Policy;
  assessment: AssessmentFn;
  intervalMs?: number; // default 30s, ±20% jitter
  cycles?: number; // test hook: run N cycles then return (undefined = forever)
  log?: (line: string) => void;
}

const MAX_BACKOFF_MS = 10 * 60 * 1000;

export async function runWatch(opts: WatchOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const base = opts.intervalMs ?? 30_000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let backoffMs = 0;
  for (let cycle = 1; !stopped && (opts.cycles === undefined || cycle <= opts.cycles); cycle++) {
    try {
      const hadEvents = await runCycle(opts, log);
      backoffMs = 0; // any completed cycle means the world still works
      if (hadEvents) continue; // no sleep after a busy cycle — go again immediately
    } catch (e) {
      backoffMs = backoffMs === 0 ? base : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      log(`[watch] cycle ${cycle} failed: ${e instanceof Error ? e.message : e} — backing off ${Math.round(backoffMs / 1000)}s`);
    }
    if (stopped || opts.cycles !== undefined && cycle >= opts.cycles) break;
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    await new Promise((r) => setTimeout(r, Math.round((backoffMs || base) * jitter)));
  }
}

async function runCycle(opts: WatchOptions, log: (l: string) => void): Promise<boolean> {
  const { engine, source, executor, client, repo, policy } = opts;
  const { triggers, next } = await source.collect(engine.positions(), { exclude: engine.selfPosted() });

  const batch = [];
  for (const t of triggers) batch.push(classify(t, policy, await opts.assessment(t)));
  for (const outcome of batch) log(formatOutcome(outcome));
  const report = engine.ingest(batch, next);
  for (const refusal of report.refusals) log(`[REFUSED] ${refusal}`);

  const reports = await runWork(engine, executor, repo, client);
  for (const r of reports) log(`#${r.ticketId} [${r.outcome}] ${r.detail}`);

  if (batch.length > 0 || reports.length > 0 || report.refusals.length > 0) {
    log(`— cycle: fresh=${report.fresh} opened=${report.ticketsOpened} resumed=${report.resumed} worked=${reports.length}`);
    return true;
  }
  return false;
}
