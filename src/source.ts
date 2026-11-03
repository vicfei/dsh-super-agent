// Source & ReplyChannel — the multi-source contracts (v0.8, issue #45).
// A Source turns one channel's events into domain Triggers and owns its read state, namespaced
// by `kind`; the Engine persists that state in the same transaction as the triggers it produced
// (exactly-once across restarts — docs/001: "a Source holds its own read position").
// A ReplyChannel delivers outbox reply effects back where the trigger came from; routing is by
// threadId prefix ("github:…", "feishu:…", "slack:…", "wechat:…").

import type { Trigger } from "./domain.js";

export interface SourceState {
  /** Max item id already taken per feed; 0 = never polled. Feed names are source-specific. */
  positions: Record<string, number>;
}

export interface Source {
  /** Channel namespace — also the threadId prefix and the positions kv suffix. */
  readonly kind: string;
  /** Pure collection: triggers newer than `from` plus the next state; persists nothing. */
  collect(from: SourceState, opts: { exclude?: ReadonlySet<string> }): Promise<{ triggers: Trigger[]; next: SourceState }>;
}

export interface ReplyChannel {
  matches(threadId: string): boolean;
  /** Deliver a reply body into the thread; returns the source-scoped external message id. */
  deliver(threadId: string, body: string): Promise<{ externalId: string }>;
}

/** GitHub's channel: threads are `github:owner/repo/(issues|pulls)/N`, delivery is an issue comment. */
export function threadSource(threadId: string): string {
  return threadId.split(":")[0] ?? "";
}
