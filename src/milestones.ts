// Milestone gates (v1.11, issue #173) — a long task pauses for a person at milestone
// boundaries. The worker keeps a checklist at $DSH_MILESTONES_FILE (`- [x]` / `- [ ]` items);
// a run that succeeds while items remain HOLDS the ticket (needs-person, approval kind
// `milestone`): a person's `1` approves the segment and the ticket re-arms with the pending
// items as guidance. One-way like every worker file: a progress report, never a permission.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MilestoneState {
  done: string[];
  pending: string[];
}

const ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;

/** Parse a markdown checklist. Bare lines and headers are ignored. */
export function parseMilestones(markdown: string): MilestoneState {
  const done: string[] = [];
  const pending: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = ITEM.exec(line);
    if (!m) continue;
    (m[1] === " " ? pending : done).push(m[2]);
  }
  return { done, pending };
}

/** The worker's checklist from its worktree, or null when it wrote none. */
export function readMilestones(worktree: string): MilestoneState | null {
  const file = join(worktree, ".dsh", "milestones.md");
  if (!existsSync(file)) return null;
  const state = parseMilestones(readFileSync(file, "utf8"));
  return state.done.length + state.pending.length === 0 ? null : state;
}
