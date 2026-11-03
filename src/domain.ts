// Domain types — adapted from dsh-superagent-prototype docs/001 & docs/002 (MIT, DeepSeek).
// Flow: Source → Trigger → Gate (host-enforced admission) → [assessment] → Ticket → Executor → Channel.

/** Who the request came from, as the host sees it. Messages feed the decision; they cannot change permissions. */
export interface Actor {
  login: string;
  /** GitHub Apps / [bot] logins / app slugs. Bots can produce inferred candidates, never explicit requests. */
  isBot: boolean;
}

/** One immutable event with the Source's own metadata. Unit of audit and idempotence. */
export interface Trigger {
  /** Source-scoped unique id; accepting twice yields one Ticket. */
  id: string;
  source: "github" | "feishu" | "slack" | "wechat" | "telegram";
  /** Receiving scope — the admission table's row key. */
  scope: Scope;
  /** Triggers of one conversation, as defined by the Source (e.g. `github:owner/repo/issues/42`). */
  threadId: string;
  author: Actor;
  /** Did the message address the agent (@mention, reply-to-agent)? */
  addressing: boolean;
  body: string;
  /** UTC ISO8601. */
  ts: string;
}

export type Scope =
  | "issue"
  | "issue_comment"
  | "pr"
  | "pr_comment"
  | "review_comment"
  | "ci"
  /** IM direct message (WeChat/Feishu/Slack DM) — shared row for all IM sources. */
  | "im_dm"
  /** IM group chat / channel message — shared row for all IM sources. */
  | "im_group";

/** Strength of an admitted Trigger. Explicit works in every accept mode; inferred is mode-gated. */
export type Strength = "explicit" | "inferred";

/** Progressive-trust ladder for inferred requests. Start in observe; switch to auto after reviewing records. */
export type AcceptMode = "off" | "observe" | "auto";

/**
 * Admission table cell. Defaults per docs/002:
 *   listed-not-addressing  → "inferred"
 *   unlisted-addressing    → "ignore"
 *   unlisted-not-addressing→ "ignore"
 * Cells are data, not code: weakening a cell does not immediately stop Tickets accepted under it
 * (revalidation-before-resume handles that in the Engine — future milestone).
 */
export type Cell = "inferred" | "ignore";

export interface AdmissionRow {
  scope: Scope;
  listedNotAddressing: Cell;
  unlistedAddressing: Cell;
  unlistedNotAddressing: Cell;
}

/** Versioned assessment rules + each Source's part. */
export interface Policy {
  version: number;
  /** Human logins allowed to produce requests. */
  allowedList: string[];
  /** Recognized bots; produce inferred candidates at most. */
  botList: string[];
  acceptMode: AcceptMode;
  /** One row per scope; a missing row means all cells "ignore". */
  table: AdmissionRow[];
  /** Delivery-side brakes for auto-merge (M6). Absent = disabled — nothing merges by default. */
  merge?: Partial<MergePolicy>;
  /** Watchdog thresholds (v0.9). Absent = disabled — nothing nudges by default. */
  watchdog?: Partial<WatchdogPolicy>;
  /** Speculative execution (v1.0). Absent = disabled — observe stays silent. */
  speculation?: Partial<SpeculationPolicy>;
}

/**
 * Speculative execution (v1.0, issue #68): in observe mode, positive inferred candidates may
 * rehearse — the work runs in the worktree but in total silence (no push, no PR, no reply).
 * The deliver gate is a HUMAN promote; nothing is ever delivered without it.
 */
export interface SpeculationPolicy {
  enabled: boolean;
  /** Open speculative tickets at once; overflow stays shadow-only. */
  maxSpeculative: number;
}

export function defaultSpeculationPolicy(): SpeculationPolicy {
  return { enabled: false, maxSpeculative: 1 };
}

export function speculationPolicyOf(policy: Policy): SpeculationPolicy {
  return { ...defaultSpeculationPolicy(), ...(policy.speculation ?? {}) };
}

/**
 * Structural merge brakes (docs/ROADMAP M6): every condition is a checkable fact about the PR,
 * never model judgment — fail-closed, each miss recorded as a reason.
 */
export interface MergePolicy {
  /** Auto-merge is opt-in; false means the sweep only reports. */
  enabled: boolean;
  /** An approval counts only if its commit_id equals the PR head SHA (stale approvals never merge). */
  requireApprovalCoveringHead: boolean;
  /** additions + deletions above this never merge. */
  maxChangedLines: number;
  /** Merge method for the SHA-pinned merge PUT. */
  method: "squash" | "merge" | "rebase";
  /** Delete the `dsh/ticket-N` branch after a successful merge. */
  deleteBranch: boolean;
  /** v0.7-2: hold while the head commit has no CI, failing CI, or CI still running. Default off —
   * a repo without checks would otherwise never merge. */
  requireCi: boolean;
}

export function defaultMergePolicy(): MergePolicy {
  return {
    enabled: false,
    requireApprovalCoveringHead: true,
    maxChangedLines: 200,
    method: "squash",
    deleteBranch: true,
    requireCi: false,
  };
}

/** Policy.merge is partial in the config file; fill the rest from defaults. */
export function mergePolicyOf(policy: Policy): MergePolicy {
  return { ...defaultMergePolicy(), ...(policy.merge ?? {}) };
}

/**
 * Watchdog policy (v0.9-1): the outside control loop observes and nudges — it never touches
 * admission; "should this continue" stays with the human approval surface. Default off.
 */
export interface WatchdogPolicy {
  enabled: boolean;
  /** An assignment running longer than this gets one nudge. */
  stuckWorkingNudgeMs: number;
  /** A needs-person ticket waiting longer than this gets one reminder. */
  needsPersonReminderMs: number;
  /** Consult the assessment endpoint before nudging stuck work (fail-closed to the rule). */
  consultLlm: boolean;
}

export function defaultRow(scope: Scope): AdmissionRow {
  return { scope, listedNotAddressing: "inferred", unlistedAddressing: "ignore", unlistedNotAddressing: "ignore" };
}

/** The state an accepted Trigger's Ticket reports. */
export type Report = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

/** Eval's output. */
export type DecisionKind = "accept" | "stop" | "ignore" | "unavailable";

export interface Decision {
  kind: DecisionKind;
  strength?: Strength;
  /** Why — every recorded fact carries its basis. */
  basis: string;
  /** observe mode: a positive assessment recorded as ignore marked "would accept". */
  wouldAccept?: boolean;
  ts: string;
}
