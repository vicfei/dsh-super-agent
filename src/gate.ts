// Host-enforced admission gate — adapted from dsh-superagent-prototype docs/002 (MIT, DeepSeek).
// The gate is deterministic (Fast Path): sender + scope + addressing checked against the Policy's
// admission table. LLM assessment (Slow Path) only ever sees candidates that survive here, and
// only for inferred strength — natural language can never turn an ignore into an admit.

import type { Cell, Policy, Strength, Trigger } from "./domain.js";

export type GateResult =
  | { strength: Strength; basis: string }
  | { strength: null; basis: string };

const lc = (s: string) => s.toLowerCase();

/** Missing scope rows fail closed: every cell ignore. */
function rowOf(policy: Policy, trigger: Trigger) {
  const closed = { scope: trigger.scope, listedNotAddressing: "ignore", unlistedAddressing: "ignore", unlistedNotAddressing: "ignore" } as const;
  return policy.table.find((r) => r.scope === trigger.scope) ?? closed;
}

/** A listed bot can produce an inferred candidate, never an explicit request. */
export function evaluateGate(policy: Policy, trigger: Trigger): GateResult {
  const row = rowOf(policy, trigger);
  const listed = policy.allowedList.map(lc).includes(lc(trigger.author.login));
  const knownBot = trigger.author.isBot || policy.botList.map(lc).includes(lc(trigger.author.login));

  if (knownBot) {
    // Bots are checked against the bot list, not the allowed list; ceiling is "inferred".
    if (trigger.addressing) return { strength: "inferred", basis: `bot ${trigger.author.login} addressing agent` };
    const cell = row.unlistedNotAddressing; // bots never count as "listed" senders
    return cell === "inferred"
      ? { strength: "inferred", basis: `bot ${trigger.author.login} in receive-all scope` }
      : { strength: null, basis: `bot ${trigger.author.login} not admitted by cell` };
  }

  if (listed) {
    if (trigger.addressing) return { strength: "explicit", basis: `allowed ${trigger.author.login} addressing agent` };
    return row.listedNotAddressing === "inferred"
      ? { strength: "inferred", basis: `allowed ${trigger.author.login} not addressing` }
      : { strength: null, basis: `allowed ${trigger.author.login} ignored by cell` };
  }

  const cell: Cell = trigger.addressing ? row.unlistedAddressing : row.unlistedNotAddressing;
  return cell === "inferred"
    ? { strength: "inferred", basis: `unlisted ${trigger.author.login} admitted by cell` }
    : { strength: null, basis: `unlisted ${trigger.author.login} not admitted by cell` };
}

export type Assessment = "positive" | "negative";

export type Resolution =
  | { action: "accept"; strength: Strength; basis: string }
  /** observe mode: recorded, nothing accepted. */
  | { action: "shadow"; strength: "inferred"; basis: string; wouldAccept: true }
  | { action: "reject"; basis: string };

/**
 * Resolve a gated Trigger under the Policy's accept mode.
 * Invariants (docs/002):
 *   - explicit requests work in every mode;
 *   - nothing inferred becomes a candidate while mode is off;
 *   - accepting an inferred candidate always requires an assessment.
 */
export function resolveCandidate(
  policy: Policy,
  gate: GateResult,
  assessment: Assessment | undefined,
): Resolution {
  if (gate.strength === null) return { action: "reject", basis: gate.basis };

  if (gate.strength === "explicit") {
    // Explicit admission never waits on an assessment or a mode.
    return { action: "accept", strength: "explicit", basis: gate.basis };
  }

  if (assessment === undefined) {
    throw new Error("inferred candidate cannot be resolved without an assessment (direct accept refused)");
  }
  if (assessment === "negative") {
    return { action: "reject", basis: `inferred candidate assessed negative (${gate.basis})` };
  }

  switch (policy.acceptMode) {
    case "off":
      return { action: "reject", basis: "inferred strength has no effect while acceptMode is off" };
    case "observe":
      return { action: "shadow", strength: "inferred", basis: gate.basis, wouldAccept: true };
    case "auto":
      return { action: "accept", strength: "inferred", basis: gate.basis };
  }
}
