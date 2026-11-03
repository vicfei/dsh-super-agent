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

## Milestone 4 — Panel + launch (done)

- [x] Zero-dependency HTTP panel (`npm run panel`, localhost): awaiting-human first (needs-person tickets, revoked mandates), observe records with "would accept", full decision log with trigger excerpts, accept-mode switch with confirm, stop command
- [x] Engine: decisions view (join trigger context), setAcceptMode with version bump, busy_timeout for panel writes alongside poll
- [x] Demo GIF built from a real run (issue #11): empty allowed list → injection comment gated out and recorded, nothing executed; listing the operator → @mention accepted → worktree work → report posted. Embedded in both READMEs
- [x] Panel endpoint tests (page, state JSON, mode switch versioning, stop, shadow records)

## Milestone 5 — conversion loop (done)

- [x] CI: Node 20/22 matrix + badges; lockfile guard against mirror URLs (root-caused Tencent-mirror lockfile contamination breaking hosted runners)
- [x] `watch` daemon: single-process poll/work/panel, jitter, exponential backoff, graceful stop
- [x] PR delivery: worker commits → `dsh/ticket-N` branch pushed → pull request opened via API → report links it; delivery failures degrade gracefully
- [x] npm publish (`@vicfei/dsh-super-agent`) + npx path — packaged (bin `dsh-super-agent`, typed programmatic API), publish workflow on tag/manual dispatch via **Trusted Publishing (OIDC)** — validated by v0.5.1 (needs node ≥22.14 + npm ≥11.5.1 + `repository.url` matching provenance)
- [x] DX polish (v0.5.1): `--help`/`--version`, friendly unknown-option errors, config auto-scaffold from packaged examples, token guidance, issue templates, CONTRIBUTING

## Milestone 6 — autonomy with structural brakes (done, v0.6.0)

The loop currently ends at "PR opened". M6 closes it while keeping every brake structural —
merge conditions are checkable facts, not model judgment.

- [x] Auto-merge with delivery requirements: only PRs we opened (`dsh/ticket-N` branch), an
      allowed-list (non-bot) approval **covering the head commit**, a changed-lines cap
      (default ±200), and any allowed-list CHANGES_REQUESTED is a veto until re-reviewed;
      default **off**, opt-in via `policy.merge`; idempotent sweep each watch cycle
- [x] GitHub App auth: installation tokens (hourly refresh, zero-dep RS256 JWT, auto-discovery),
      replies from the bot identity, branch push rides the same credential, PAT fallback
- [x] Panel person-stages: per-person ticket/delivery queues (panel-side grouping over existing state)

## Milestone 8 — channels (done, v0.8.0)

- [x] Multi-source base: Source/ReplyChannel contracts, per-source read states (v0.7 blob migrates),
      reply routing by threadId prefix, `im_dm`/`im_group` admission rows shared by all IM sources
- [x] Feishu: self-built app, SDK WebSocket long connection (no public URL), im/v1 replies
- [x] Slack: Socket Mode (no public URL), auth.test bot-id discovery, chat.postMessage replies
- [x] WeChat: iLink Bot Protocol — QR login (`wechat-login`), long-poll with opaque cursor
      (self-aborting, never blocks a cycle), fail-closed group addressing, context_token routing,
      -14 state clearing; text-first (AES media later)
- [x] Telegram (v0.8.1): official Bot API — @BotFather token, getMe bot-username discovery,
      getUpdates offset long-poll (self-aborting), sendMessage replies

## Milestone 9 — autonomy hygiene (done, v0.9.0)

- [x] Watchdog (v0.9-1): the outside control loop — stuck-work nudge + needs-person reminder,
      one each, idempotent; optional fail-closed LLM consult can skip a nudge on real progress;
      never touches admission, never kills runs; read-only `health` CLI
- [x] Executor sandbox (v0.9-2): bwrap/sandbox-exec — ro root, rw worktree only, network denied,
      env allowlist (DSH_* + passEnv; ambient secrets never reach the worker); missing wrapper
      = hard error. Two live findings documented: --unshare-net must be explicit; /tmp tmpfs
      must precede the worktree bind
- [x] Trigger batching (v0.9-3): one Slow-Path call per thread (subscription bypass coalesces
      the burst); Fast Path / Slow Path vocabulary aligned with the article in docs
- [x] Inline & Spill + chain of recall (v0.9.1): 8k inline budget, over-budget follow-ups spill
      in full to engine rows + `.dsh/spill/<id>.md` files materialized in the worktree before
      the run; the worker recalls by opening the pointer

## Milestone 10 — the deliver gate (done, v1.0.0)

- [x] Speculative execution + deliver gate (#69): observe-mode shadows may rehearse in total
      silence; delivery happens only on a human promote (tickets promote / panel) via the
      watch promote sweep — idempotent, capped, audit-intact
- [x] README: the article's checklist one-by-one + ecosystem positioning (#70)

## Later (from the article's design, deliberately after the slice)

- Subscription bypass for ticket-bearing threads (fan-out without re-eval)
- [x] WeChat polish (v1.0.1): 1800-char reply chunking, scanner ilink_user_id capture
      (typing heartbeat waits for a live-verified smoke of its ticket flow)

## Non-goals (v0)

- Multi-instance / distributed operation
- Cross-source identity mapping
- Being a DSH plugin
