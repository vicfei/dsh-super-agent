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
  source: "github";
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
  | "ci";

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
