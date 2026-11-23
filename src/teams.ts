// Worker-spawned teams (v2.0 Phase 3, #176) — the worker asks for sub-work through the
// one-way file protocol (.dsh/delegate.md, the approval-request pattern): informative,
// never authoritative. The ENGINE opens the child tickets (gated by policy.teams caps,
// parent-linked, inheriting the parent's scope admission) — never a raw subprocess from
// inside the worker. Team expansion goes through a gate; the ledger makes the org chart
// of a ticket tree computable.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface DelegationRequest {
  title: string;
  reason: string;
  prompt: string;
  count: number;
}

/** Parse `.dsh/delegate.md` (title / reason / prompt / count; prompt may span lines). */
export function parseDelegation(markdown: string): DelegationRequest | null {
  const title = /^title:\s*(.+)$/m.exec(markdown)?.[1]?.trim();
  const promptMatch = /^prompt:[ \t]*([^\n]*(?:\n(?!(?:title|reason|count):)[^\n]*)*)/m.exec(markdown);
  if (!title || !promptMatch || !promptMatch[1].trim()) return null;
  const reason = /^reason:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? "";
  const countRaw = /^count:\s*(\d+)\s*$/m.exec(markdown)?.[1];
  const count = Math.max(1, Math.min(10, Number(countRaw ?? 1) || 1));
  return { title, reason, prompt: promptMatch[1].trim(), count };
}

/** Consume `.dsh/delegate.md` from the worktree (moved aside like the approval request).
 *  Null when absent or unparseable — a malformed delegation is a skipped feature, never a failure. */
export function consumeDelegationFile(worktree: string): DelegationRequest | null {
  const file = join(worktree, ".dsh", "delegate.md");
  if (!existsSync(file)) return null;
  let req: DelegationRequest | null = null;
  try {
    req = parseDelegation(readFileSync(file, "utf8"));
  } catch {
    req = null;
  }
  try {
    const done = join(worktree, ".dsh", "consumed");
    mkdirSync(done, { recursive: true });
    renameSync(file, join(done, `delegate-${Date.now()}.md`));
  } catch { /* keep going: the file stays and may be re-consumed once */ }
  return req;
}
