// Runner — poll → gate → resolution. Assessment is a placeholder flag until milestone 3 wires the
// real OpenAI-compatible layer; observe mode still shadows instead of accepting, so nothing runs.

import type { Policy, Trigger } from "./domain.js";
import { evaluateGate, resolveCandidate, type Assessment, type GateResult, type Resolution } from "./gate.js";

export interface PollOutcome {
  trigger: Trigger;
  gate: GateResult;
  resolution: Resolution;
}

export function classify(trigger: Trigger, policy: Policy, assessment: Assessment): PollOutcome {
  const gate = evaluateGate(policy, trigger);
  const resolution = resolveCandidate(policy, gate, assessment);
  return { trigger, gate, resolution };
}

const LABEL = { accept: "ACCEPT", shadow: "WOULD-ACCEPT", reject: "IGNORE" } as const;

export function formatOutcome(o: PollOutcome): string {
  const who = `${o.trigger.author.login}${o.trigger.author.isBot ? "(bot)" : ""}`;
  const strength = o.gate.strength ? o.gate.strength.toUpperCase() : "NOT-ADMITTED";
  const head = `[${LABEL[o.resolution.action]}] ${strength} ${o.trigger.scope} ${o.trigger.threadId} by ${who}`;
  switch (o.resolution.action) {
    case "accept":
      return `${head} → accepted (${o.resolution.basis})`;
    case "shadow":
      return `${head} → shadow record only, nothing executed (${o.resolution.basis})`;
    case "reject":
      return `${head} (${o.resolution.basis})`;
  }
}
