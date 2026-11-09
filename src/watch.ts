// watch — the daemon: poll → gate/assess → ingest → claim → execute → report → drain,
// one process, forever (or until SIGINT/SIGTERM — the current cycle finishes first).
// Interval gets jitter so a fleet of watchers doesn't thunder-herd the API; errors
// back off exponentially up to a 10-minute cap instead of dying.

import type { Policy, Trigger } from "./domain.js";
import type { Engine } from "./engine.js";
import type { ReplyChannel, Source, SourceState } from "./source.js";
import type { Executor } from "./executor.js";
import type { GitHubClient } from "./github/client.js";
import { interceptApprovalCommands, runApprovalSweep } from "./approval.js";
import { evaluateGate } from "./gate.js";
import { memoryPolicyOf } from "./domain.js";
import type { MemoryDistiller } from "./memory.js";
import { runMergeSweep } from "./merge.js";
import { runWatchdogSweep } from "./watchdog.js";
import { classify, formatOutcome } from "./runner.js";
import { runPromoteSweep, runWork, type WorkMemory } from "./work.js";

export type AssessmentFn = (t: Trigger) => Promise<"positive" | "negative"> | "positive" | "negative";

export interface WatchOptions {
  engine: Engine;
  /** All sources, polled each cycle (v0.8); each keeps its own read state in the engine. */
  sources: Source[];
  executor: Executor;
  client: GitHubClient | null;
  /** Reply routes by threadId prefix (v0.8). */
  channels: ReplyChannel[];
  repo: string;
  policy: Policy;
  assessment: AssessmentFn;
  /** v1.4: distill pass for two-tier memory. Absent = feature inert (policy gates it anyway). */
  memoryDistiller?: MemoryDistiller;
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
  const { engine, executor, client, channels, repo, policy } = opts;

  const batch = [];
  const nextBySource: Record<string, SourceState> = {};
  // Trigger batching (v0.9-3, issue #62): same-thread follow-ups bypass into one ticket, so the
  // Slow Path runs once per thread — on the first inferred trigger — and later inferred triggers
  // of that thread reuse the verdict. Explicit triggers never consult the Slow Path (docs/002).
  const verdictByThread = new Map<string, "positive" | "negative">();
  const assess = async (t: Trigger): Promise<"positive" | "negative"> => {
    const gate = evaluateGate(policy, t);
    if (gate.strength !== "inferred") return "positive";
    const cached = verdictByThread.get(t.threadId);
    if (cached) return cached;
    const verdict = await opts.assessment(t);
    verdictByThread.set(t.threadId, verdict);
    return verdict;
  };
  for (const source of opts.sources) {
    const { triggers, next } = await source.collect(engine.sourceState(source.kind), { exclude: engine.selfPosted() });
    nextBySource[source.kind] = next;
    // v1.1: digits in ops threads resolve pending approvals BEFORE anything is ticketed
    const { rest, applied } = interceptApprovalCommands(triggers, engine, policy);
    for (const a of applied) log(`[approval] ${a}`);
    for (const t of rest) batch.push(classify(t, policy, await assess(t)));
  }
  for (const outcome of batch) log(formatOutcome(outcome));
  const report = engine.ingest(batch, nextBySource);
  for (const refusal of report.refusals) log(`[REFUSED] ${refusal}`);

  // v1.4 two-tier memory: the policy gates the whole feature; the accept ladder is the mode
  // itself (observe records would-inject candidates, auto accepts at distill time).
  const mp = memoryPolicyOf(policy);
  const workMemory: WorkMemory | undefined =
    opts.memoryDistiller && mp.enabled
      ? { distiller: opts.memoryDistiller, autoAccept: policy.acceptMode === "auto", maxInject: mp.maxInject, maxAccepted: mp.maxAccepted }
      : undefined;

  const reports = await runWork(engine, executor, repo, client, channels, workMemory);
  for (const r of reports) log(`#${r.ticketId} [${r.outcome}] ${r.detail}`);

  // Auto-merge sweep (M6-1) — no-op unless policy.merge.enabled; structural brakes inside.
  const merged = client ? await runMergeSweep(engine, client, repo, policy, channels, (l) => log(`[merge] ${l}`)) : [];

  // v1.0 deliver gate: promoted speculative work gets delivered (person-authorized).
  const promoted = client ? await runPromoteSweep(engine, executor, client, repo, channels, (l) => log(`[promote] ${l}`)) : 0;

  // v1.1 approval surface: render requests for pending decisions into ops threads.
  const approvals = await runApprovalSweep(engine, policy, channels, (l) => log(`[approval] ${l}`));

  // Watchdog sweep (v0.9-1) — no-op unless policy.watchdog.enabled; observes, never admits.
  const watched = await runWatchdogSweep(engine, policy, channels, { log: (l) => log(`[watchdog] ${l}`) });

  if (batch.length > 0 || reports.length > 0 || report.refusals.length > 0 || merged.length > 0 || watched.length > 0 || promoted > 0 || approvals > 0) {
    log(`— cycle: fresh=${report.fresh} opened=${report.ticketsOpened} resumed=${report.resumed} joined=${report.joined} spec=${report.speculative} worked=${reports.length} merged=${merged.length} promoted=${promoted} nudged=${watched.length}`);
    return true;
  }
  return false;
}
