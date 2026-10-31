# Roadmap

Vertical slice first: one Source, one gate, one executor, one reply channel. Everything else waits until the slice is honest.

## Milestone 1 — GitHub Source (done)

- [x] Poll GitHub issues / issue comments / PR comments / review comments / mentions via REST (PAT, no App required)
- [x] Trigger dedup (read position persisted per feed; restart never replays)
- [x] Thread ids (`github:owner/repo/issues/<n>` etc.), author bot detection (`[bot]` logins, App accounts)
- [x] Delivery: reply posting into the originating thread + 100-word clip discipline (orchestration itself lands with the Engine)
- [x] Runner: poll → gate → resolution, one line per trigger; live-smoked against this repo's own issues

## Milestone 2 — Engine + Tickets (done)

- [x] Single-writer Engine on SQLite (better-sqlite3, WAL): trigger / decision / ticket / effect / kv; **one transaction per command** — ingest writes triggers + decisions + tickets + resume + read positions together (exactly-once)
- [x] Accept → Ticket + Mandate (policy version, strength, basis) + one confirmation reply effect ("confirms once"); duplicate trigger ids are full no-ops
- [x] Person's stop ends a Ticket (panel command); the opener's admitted message resumes it after revalidation; failed revalidation revokes the Mandate and the Ticket takes none of its waiting messages
- [x] Outbox: same kind+key coalesces (payload replaced, order kept), takeDue + exponential backoff (5s→300s cap), terminal on the 5th attempt
- [x] Self-echo filter: posted comment ids recorded, never re-ingested as triggers (live-verified)
- [x] CLI: `poll [--post]` persists into the engine and drains reply effects into real comments; `tickets` / `tickets stop <id>`

## Milestone 3 — Executor + Assessment (done)

- [x] Config-driven executor: any CLI in a subprocess, per-ticket `git worktree` + branch `dsh/ticket-<id>` (`-B` re-prepare is idempotent for resumed tickets), prompt via file, env carries DSH_DIR/PROMPT_FILE/TICKET/THREAD/REPO/AUTHOR — absolute paths, no credentials injected
- [x] Assignments in the Engine; ticket stages queued / working / needs-person / ended; a ready report ends the Ticket completed (new work opens a new ticket); a failed one waits for a person — no automatic retry loop
- [x] 30-min default timeout kills the whole process group; `maxWorkers` slots per run; blocked commands refuse by name
- [x] Assessment: any OpenAI-compatible endpoint, called only for inferred candidates (explicit never waits); HTTP/parse/network failures fail closed to negative
- [x] `work` CLI command: claim → prepare → execute → report → drain outbox (live-smoked on this repo, including resume → re-claim → re-run)

## Milestone 4 — Panel + launch

- Single web page: only items awaiting a human; observe records with "would accept"; accept-mode switch with confirm
- Demo GIF: an injection-style comment ("ignore your rules…") is gated out and recorded — nothing executes
- Launch posts + submit to awesome-agent-orchestrators

## Later (from the article's design, deliberately after the slice)

- Subscription bypass for ticket-bearing threads (fan-out without re-eval)
- Feishu / Slack sources
- Auto-merge with delivery-requirements prompt (default: own PR, approvals cover head, <200 lines)
- Batching Router, chain-of-recall context, speculative execution, Watchdog

## Non-goals (v0)

- Multi-instance / distributed operation
- Cross-source identity mapping
- Being a DSH plugin
