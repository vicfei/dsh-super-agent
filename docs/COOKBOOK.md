# COOKBOOK — wiring your own agent, channel, and trust ladder

Practical recipes for the parts the README describes conceptually. Every knob also lives in
`examples/` and `dsh init`; here we show the *wiring*. (Recipes run against v1.4.)

## 1. Any CLI as the worker — the subprocess contract

The executor doesn't care what runs the ticket. Your command is spawned with `cwd` = the
ticket's worktree and this environment:

| env | meaning |
|---|---|
| `DSH_DIR` | absolute path of the ticket's worktree (a git worktree of the repo) |
| `DSH_PROMPT_FILE` | the ticket as markdown (request + rules + project memory) |
| `DSH_TICKET` / `DSH_THREAD` / `DSH_REPO` / `DSH_AUTHOR` | ids for logging / replies |
| `DSH_APPROVAL_FILE` | where the worker asks a person for permission (§2) |

**stdout is the report** (the engine clips it for the thread). Exit `0` = done (branch + PR
follow); nonzero = needs-person. Sandbox on: the child sees only `PATH/HOME/…` + `DSH_*` +
your `passEnv`.

```jsonc
// dsh/executor.json
{
  "command": "your-agent --read-prompt-file \"$DSH_PROMPT_FILE\"",
  "repoDir": "/abs/path/to/the/repo/checkout",
  "workRoot": "/abs/path/to/work",
  "timeoutMs": 600000,
  "maxWorkers": 1,
  "blockedCommands": ["sudo"]
}
```

### Recipe A — a one-shot CLI agent

Anything that takes a prompt and exits works: point `command` at it with the prompt file
inlined (`"$(cat "$DSH_PROMPT_FILE")"`) or via the tool's own file flag. The agent works in
`$DSH_DIR` (already a worktree on branch `dsh/ticket-<id>`); whatever it commits, the engine
pushes and PRs on exit 0.

### Recipe B — a deterministic script (no model)

The whole delivery chain (worktree → commit → push → PR → report) can be validated without
any LLM — our own first dogfood delivery was a fixed Python script that inserted an FAQ
block and committed. Ideal for smoke-testing admission, approval digits and merge brakes.

### Recipe C — a BYOM HTTP worker (the pattern we run in production)

A small harness around any OpenAI-compatible `/chat/completions` endpoint: the model explores
with `READ: <path>` lines, then returns **whole files** (` ```file ` blocks) — never diffs;
hand-written hunk headers corrupt constantly. Apply, run the repo's verification gates
(tests, fmt, lint — **red gates mean exit nonzero: no PR on red**), commit as your bot
identity. Three traps we hit live, so you don't have to:

- worktrees are fresh checkouts: symlink the main checkout's `node_modules`, and for Python
  **prepend `PYTHONPATH=<worktree>/src`** — an editable install otherwise makes you test a
  *different* checkout;
- exclude your harness artifacts from the commit (`DSH_PROMPT.md`, `.dsh/`, `node_modules`,
  `target/`);
- write the test yourself if the model won't — a green suite without a new test for new
  behavior proves nothing.

## 1½. The worker's built-in scope ethic

Every `DSH_PROMPT.md` carries a scope contract (borrowed from the prototype's
`prompts/team/scope.md` — stop **by impact, not by effort**):

- **Carry through**: an authorized local change goes through implementation, checks and review
  to completion. File counts, failing tests and layout defects alone are *not* reasons to stop.
- **Pause** (via the approval file): when the scope requires breaking existing caller
  expectations, changing a module's responsibility, coordinated redesign across modules — or
  when feasible approaches repeatedly fail. Name the specific interface and caller impact.
- **Draft honestly**: preserve useful partial work as an explicitly incomplete draft and
  report what is blocked; never fabricate a PR when no useful safe change exists.

Until prompt overrides ship (v1.6), the contract is built into `renderPrompt` — read it, and
if your team needs different scope rules, that file is where they live.

## 2. The worker's permission ask — `$DSH_APPROVAL_FILE`

A worker that needs an outward action (or hits something the sandbox blocks) writes
`title / reason / requested action` to `$DSH_APPROVAL_FILE` (`.dsh/approval-request.md` in
the worktree) and stops. The run lands in **needs-person** whatever its exit code says; the
ask appears on the IM approval surface; the owner's `1` requeues with the request injected
as guidance. One-way by design: **informative, never authoritative** — nothing the worker
writes can flip a gate.

## 3. Policy recipes — the trust ladder in practice

Start every new scope in `observe` (positives become `would accept` records; nothing runs),
review `dsh stats`, then widen:

```jsonc
// im DMs from an allowed person: inferred candidates, assessed by the Slow Path
{ "scope": "im_dm", "listedNotAddressing": "inferred", "unlistedAddressing": "ignore", "unlistedNotAddressing": "ignore" }
// strangers opening issues: fail closed
{ "scope": "issue", "listedNotAddressing": "inferred", "unlistedAddressing": "ignore", "unlistedNotAddressing": "ignore" }
```

- **Approval digits** (`policy.approval.enabled`): pending decisions arrive in the ops DM;
  `1` requeue/promote · `2` stop (double-key) · `3` detail; `?` prints the status card.
- **Speculation** (`policy.speculation`): observe-mode positives may rehearse silently;
  delivery needs a human `1` (promote).
- **Routines** (`policy.routines`): cron + tz + `reportTo` — the clock through the same gate:

```jsonc
{ "id": "morning-digest", "prompt": "Summarize open tickets and stale PRs. One paragraph.",
  "schedule": { "cron": "0 8 * * 1-5", "tz": "Asia/Shanghai" },
  "reportTo": "wechat:peer/<id>@im.wechat" }
```

- **Merge brakes** (`policy.merge`): default off; every condition is a checkable fact about
  the PR, never model judgment.

## 4. BYOM assessment — any OpenAI-compatible endpoint

```bash
dsh watch --assessment llm \
  --assess-base-url https://api.your-llm.example/v1 \
  --assess-model your-model
export ASSESS_API_KEY=…   # env at the boundary, never in configs
```

Only inferred candidates reach it; explicit never waits; **any error fails closed** to
negative. The same endpoint powers v1.4's memory distill pass.

## 5. Sandbox — confinement is the norm

`dsh init` enables bwrap (Linux) / sandbox-exec (macOS) whenever the wrapper exists:
read-only root, read-write only the worktree, **network denied** unless `allowNetwork`,
env allowlist (`DSH_*` + your `passEnv`). A missing wrapper with sandbox "enabled" is a hard
startup error and a `dsh doctor` failure — never a silent unsandboxed fallback.

## 6. Channels

- **GitHub**: a GitHub App (recommended — hourly installation tokens, `[bot]` identity that
  can never impersonate a human) or a PAT. Bots only ever produce inferred candidates.
- **WeChat**: `dsh wechat-login --web` (click → scan → done; the QR's short life beats any
  terminal round trip). The typing heartbeat keeps the send-side session warm — without it,
  scheduled digests land late.
- **Telegram/Feishu/Slack**: one token each (`TELEGRAM_BOT_TOKEN`, …) — the channel arms
  itself when the env is present.

## 6½. Reply language

Every human-facing message (ticket notices, reports, approval asks and receipts, watchdog
check-ins) ships in English and Chinese: set `DSH_LOCALE=zh` in the daemon's environment.
The gate, decisions and audit trail stay English — they are evidence, not conversation.
`DSH_LOCALE` unset = English (the only behavior before this knob existed).

## 7. The daemon, and bootstrapping an existing repo

`dsh watch` is poll → gate → work → report → drain, forever, with backoff. Run it under
`nohup`/systemd with the panel on a localhost port (`PANEL_PORT`), then `ssh -L` in.

**Fresh engine on a repo with history**: the first collect sees the newest page of every
feed as fresh triggers. If you don't want history ticketed, start from now — run one
collect-and-discard and persist the positions before the daemon's first cycle:

```ts
const { triggers, next } = await source.collect({ positions: {} }, { exclude: new Set() });
engine.ingest([], { github: next }); // positions land, triggers are dropped
```

(Found live: booting a second watch on a busy repo flooded 19 tickets for long-closed
issues — fixed in #113 so the first collect returns numeric positions, but "history is
fresh" is semantics, not a bug.)
