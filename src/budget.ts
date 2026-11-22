// Budget gates (v1.11, issue #171) — long-task reliability as a policy slot. Every cap is a
// checkable fact about a ticket (assignments, outputs, worker-reported tokens); a ticket that
// reaches one is HELD, never killed silently — it waits for a person, whose approval is a
// waiver for that dimension. `budget.near` / `budget.exhausted` / `budget.waived` land on the
// hash-chained ledger. Without `policy.budget` nothing here runs.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { BudgetPolicy } from "./domain.js";
import type { Engine } from "./engine.js";

export type BudgetDimension = "wall" | "attempts" | "output" | "tokens";

export interface BudgetUsage {
  /** Cumulative across every assignment of the ticket. */
  wallMs: number;
  attempts: number;
  /** Largest single-run output. */
  outputBytes: number;
  /** Worker-reported ($DSH_USAGE_FILE), cumulative. */
  tokens: number;
}

/** What the ticket has consumed so far — every figure a query, none a guess. */
export function budgetUsageOf(engine: Engine, ticketId: number): BudgetUsage {
  const rows = engine.db
    .prepare("SELECT started_at, ended_at, output FROM assignment WHERE ticket_id = ?")
    .all(ticketId) as { started_at: string; ended_at: string | null; output: string | null }[];
  let wallMs = 0;
  let outputBytes = 0;
  for (const r of rows) {
    if (r.started_at && r.ended_at) wallMs += Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at));
    if (r.output) outputBytes = Math.max(outputBytes, r.output.length);
  }
  const tokens = engine.ticketTokens(ticketId);
  return { wallMs, attempts: rows.length, outputBytes, tokens: tokens.input + tokens.output };
}

export interface BudgetVerdict {
  exhausted: BudgetDimension[];
  near: BudgetDimension[];
  /** used / cap per dimension, for ledger detail and the approval surface. */
  detail: Partial<Record<BudgetDimension, { used: number; cap: number }>>;
}

export function evaluateBudget(usage: BudgetUsage, policy: BudgetPolicy, waived: string[] = []): BudgetVerdict {
  const caps: Partial<Record<BudgetDimension, number | undefined>> = {
    wall: policy.maxWallMs, attempts: policy.maxAttempts, output: policy.maxOutputBytes, tokens: policy.maxTokens,
  };
  const used: Partial<Record<BudgetDimension, number>> = {
    wall: usage.wallMs, attempts: usage.attempts, output: usage.outputBytes, tokens: usage.tokens,
  };
  const exhausted: BudgetDimension[] = [];
  const near: BudgetDimension[] = [];
  const detail: BudgetVerdict["detail"] = {};
  for (const dim of Object.keys(caps) as BudgetDimension[]) {
    const cap = caps[dim];
    if (cap === undefined || waived.includes(dim)) continue;
    const u = used[dim] ?? 0;
    detail[dim] = { used: u, cap };
    if (u >= cap) exhausted.push(dim);
    else if (u >= cap * policy.nearRatio) near.push(dim);
  }
  return { exhausted, near, detail };
}

function describe(verdict: BudgetVerdict, dims: BudgetDimension[]): string {
  return dims.map((d) => {
    const x = verdict.detail[d]!;
    const unit = d === "wall" ? "ms" : d === "attempts" ? " runs" : d === "output" ? " bytes" : " tokens";
    return `${d} ${Math.round(x.used)}${unit} ≥ cap ${Math.round(x.cap)}`;
  }).join("; ");
}

// ── $DSH_USAGE_FILE: the worker's token report (one-way, informative, optional) ───────

export interface UsageReport { input: number; output: number }

/** Read `.dsh/usage.json` from the worktree and move it aside (consumed once per run).
 *  Accepts OpenAI (`prompt_tokens` / `completion_tokens`), underscore (`input_tokens`) and
 *  camelCase names; anything unparseable is ignored — a malformed report never fails a run. */
export function consumeUsageFile(worktree: string): UsageReport | null {
  const file = join(worktree, ".dsh", "usage.json");
  if (!existsSync(file)) return null;
  let report: UsageReport | null = null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const input = num(raw.prompt_tokens) ?? num(raw.input_tokens) ?? num(raw.inputTokens);
    const output = num(raw.completion_tokens) ?? num(raw.output_tokens) ?? num(raw.outputTokens);
    if (input !== undefined || output !== undefined) report = { input: input ?? 0, output: output ?? 0 };
  } catch {
    report = null;
  }
  try {
    const done = join(worktree, ".dsh", "consumed");
    mkdirSync(done, { recursive: true });
    renameSync(file, join(done, `usage-${Date.now()}.json`));
  } catch { /* the file stays; a stale report is re-read and re-counted at most once more */ }
  return report;
}

// ── the two gates ────────────────────────────────────────────────────────────────

/** Before a run: a ticket already at a cap is held for a person (ledger row written).
 *  Returns the exhausted dimensions, or null when the ticket may run. */
export function budgetGateBeforeRun(engine: Engine, policy: BudgetPolicy, ticketId: number): BudgetDimension[] | null {
  const verdict = evaluateBudget(budgetUsageOf(engine, ticketId), policy, engine.budgetWaived(ticketId));
  if (verdict.exhausted.length === 0) return null;
  for (const dim of verdict.exhausted) engine.ledger.emit("budget.exhausted", { ticketId, dimension: dim, detail: describe(verdict, [dim]) });
  engine.holdTicketForBudget(ticketId, verdict.exhausted, describe(verdict, verdict.exhausted));
  return verdict.exhausted;
}

/** The run's timeout: the executor's, or what remains of the wall budget — whichever is less. */
export function budgetRunTimeoutMs(usage: BudgetUsage, policy: BudgetPolicy, defaultMs: number, waived: string[] = []): number {
  if (policy.maxWallMs === undefined || waived.includes("wall")) return defaultMs;
  const remaining = policy.maxWallMs - usage.wallMs;
  return remaining > 0 ? Math.min(defaultMs, remaining) : defaultMs;
}

/** After a run: consume the usage report, record `budget.near` once per dimension, and hold
 *  the ticket if a cap is reached and the ticket is still open. */
export function budgetGateAfterRun(engine: Engine, policy: BudgetPolicy, ticketId: number, worktree: string): BudgetVerdict {
  const report = consumeUsageFile(worktree);
  if (report) engine.addTicketTokens(ticketId, report.input, report.output);
  const waived = engine.budgetWaived(ticketId);
  const verdict = evaluateBudget(budgetUsageOf(engine, ticketId), policy, waived);
  for (const dim of verdict.near) {
    if (engine.markBudgetNear(ticketId, dim)) {
      engine.ledger.emit("budget.near", { ticketId, dimension: dim, ...verdict.detail[dim] });
    }
  }
  // evidence regardless of outcome: a cap reached on a completed ticket is still a fact
  for (const dim of verdict.exhausted) engine.ledger.emit("budget.exhausted", { ticketId, dimension: dim, detail: describe(verdict, [dim]) });
  // the hold only matters for a ticket that could run again
  if (verdict.exhausted.length > 0 && engine.tickets().some((t) => t.id === ticketId && t.state === "open")) {
    engine.holdTicketForBudget(ticketId, verdict.exhausted, describe(verdict, verdict.exhausted));
  }
  return verdict;
}
