## 2.0.1 — the node-routed followup

- Node-routed delegation (#176/#180): `delegate.md` grows an optional `node:` field —
  `policy.teams.endpoints` maps node → that node's A2A endpoint; the engine stores the
  route per child, resolves it at claim time and exports `DSH_TARGET_URL` /
  `DSH_TARGET_NODE` to the executor command template, which branches: local worker when
  unset, the A2A client when set. **Any CLI is a worker; the engine stays surgery-free.**
  An unresolvable node is a config error: the child fails loudly and the parent parks for
  a person — the team's failure keeps one owner.
- `dsh a2a send` — the outbound delegation client: `message/send` with a client-chosen
  task id (idempotent — the server dedups on the trigger id), then polling `tasks/<id>`
  to a terminal state. Exit contract: `0` completed · `1` transport/protocol · `2` remote
  not-done (input-required / failed / canceled) · `3` wait budget exhausted. Token via
  `--token` / `--token-file` / `A2A_TOKEN` — never a worker env by default.
- Panel ticket trees (slice 5): `TicketView` carries `parent` / `targetNode`; the panel
  grows a "Delegation trees" section (children indented under the parent,
  waiting-children badge, live teams only — settled trees are ledger history); `dsh
  tickets` prints `parent=#N →node`.
- e2e proof: the full chain runs against dsh's own A2A server as the remote node — real
  HTTP hop, real CLI subprocess inside the child's executor template. Fleet dogfood
  (singapore ↔ wsl2) follows Tailscale deployment.

## 2.0.0 — the delegation-edge release

- A2A channel (#176/#177): external agents submit work through the SAME admission table —
  Agent Card at the well-known path, `message/send` → `a2a`-scope trigger (push-buffer
  source), relay replies to registered callbacks, task status endpoint always pollable.
  The protocol carries no admission; dsh supplies the constitution: bearer = transport
  auth, caller identity = admission input (agent identities live in `policy.a2a.allowedAgents`,
  separate from the human list), unlisted callers gated like anyone, one hash-chained row
  per delegation. Default off; refuses to arm without `A2A_TOKEN`.
- Worker-spawned teams (#176/#178): the worker asks via `.dsh/delegate.md` (one-way,
  informative); the ENGINE opens parent-linked child tickets under `policy.teams` caps,
  inheriting the parent's scope admission. The parent waits (`waiting-children`) until the
  team settles; **a child failure flows into the parent's needs-person**. Depth cap: children
  don't delegate. The org chart of a ticket tree is computable from the ledger.
- Retention-inversion argument in the README (v1.11, restated here for the launch narrative).

## 1.11.0 — the stamina release

- Budget gates (#171/#172): `policy.budget` gives a ticket four optional caps — cumulative
  wall-clock across resumes, runs, a single run's output, and worker-reported tokens
  (`$DSH_USAGE_FILE`, one-way like the approval request). A ticket at a cap is **held, never
  killed silently**: needs-person, `budget.exhausted` on the ledger with the dimension, the
  usage and the cap. A person's approval is a **waiver** for that dimension
  (`budget.waived`), the ticket re-armed. A run's timeout is capped at the remaining wall
  budget; `budget.near` is recorded once per dimension. Absent policy = inert.
- Milestone gates (#173/#174): the worker keeps a checklist at `$DSH_MILESTONES_FILE`; with
  `policy.milestones.enabled`, a run that succeeds while items remain **holds the ticket for
  a person** — the approval surface asks `1 continue · 2 stop · 3 detail`; `1` releases the
  segment and the pending items become the next run's guidance. `ticket.milestones` /
  `ticket.milestone-held` on the ledger. Default off; inert without the approval surface.
- README: the **retention-inversion** argument — compaction silently drops governance
  constraints that live only in the prompt; dsh's constraints live in the engine. The prompt
  can be lost; the gate cannot.

## 1.10.0 — the everywhere release

- macOS platform parity (#160/#161): the seatbelt profile finally EXECUTES — a real
  confinement test runs in CI on both wrappers (bwrap on linux runners, sandbox-exec on
  macos runners, its first real execution anywhere), with the /var → /private/var symlink
  alias fixed (allow both spellings) and a macos-latest × node matrix. Doctor's sandbox
  check is platform-aware (`wrapperPresent`; legacy `bwrapPresent` still accepted).
- iMessage channel (#162/#163): macOS-only AppleScript bridge, deliberately the most
  conservative channel — a handle watchlist (IMESSAGE_HANDLES) is an admission layer
  BEFORE the admission table; groups fail closed (WeChat posture); dedup is a recent-id
  window (first poll baselines, restarts never replay); isFromMe never triggers; the
  osascript runner is injected so the bridge tests on any OS. `dsh watch` arms it
  darwin-only, loudly.
- Zero native dependencies (#164/#165): node:sqlite is the default engine backend where
  the runtime has it (Node ≥ 22.5 flagged / ≥ 22.13 unflagged), better-sqlite3 the
  fallback (now optionalDependencies — `npm install` succeeds without a compile chain);
  DSH_DB_BACKEND pins either. The adapter normalizes the contract (undefined params throw
  identically; one flat BEGIN·COMMIT transaction per command) and CI proves equivalence —
  the same full suite on both backends (node 20 fallback, 22 auto, 24 pinned).

## 1.9.0 — the affinity release

- Persona files (#152/#153): nine owner-edited markdown files under `persona/` (SOUL, IDENTITY,
  STYLE, RULES, BOUNDARIES, WORKFLOW, SKILLS, KNOWLEDGE, GOALS), composed in a fixed order into
  every worker prompt. A 16k char budget drops trailing files as a whole (named in a provenance
  line the worker itself reads); every dispatch emits `persona.dispatch` on the hash-chained
  ledger — file list, order, and a sha256 of exactly what the worker saw, so a later SOUL.md
  edit is visible against every past run. `dsh init` writes the starter set and never
  overwrites owner content, not even with `--force`.
- `dsh chat` (#154/#155): the terminal as a sixth channel. Each typed line is an `im_dm`
  trigger through the same admission table (an allowed-list member's line is explicit and goes
  to work; an unlisted login is gated to ignore by the same cell). The chat thread is a full
  ops thread — `?` prints the status card, digits resolve pending approvals with the same
  state machine and receipts. Line → gate → ticket → worktree → report, zero IM configuration;
  CLI triggers and WeChat triggers land in the same decision table.
- Token-gated read-only panel (#156/#157): `PANEL_TOKEN` makes the panel Bearer-gated — every
  request, the page included (timing-safe compare), `?token=` bootstraps the page — and
  read-only by construction (acting endpoints refuse 403 even with the right token).
  `PANEL_HOST` may bind beyond loopback only with a token; without one it is a loud hard
  refusal at startup. No token set: byte-for-byte today's loopback panel.

## 1.8.0 — the witnessed grant

- `dsh fleet --engines name:port,…`: one URL over every engine. Cards show policy/mode,
  health, review suggestions (GRANTED marks, era staleness) and judge health; 10s refresh.
  Same-origin proxy design — the page never talks to engines directly, zero new write paths.
  First live day caught a dead engine. Screenshot: docs/screenshots/08-fleet.png.
- `dsh review` correctness: rejections are now era-scoped like shadows (an old-policy "no"
  no longer holds a scope at hold forever); judge health separates "the judge said no" from
  "the judge was unreachable" (⚠ N unreachable) — fail-closed verdicts carry the judge name
  in the basis (`· <judge> unreachable`).
- WeChat login web page: the QR button POSTs /qr as the server expects (the GET/POST mismatch
  404'd the first scan since November).

## 1.7.0 — bring your own judge

- `--assessment decision` (#133): the slow path reads probability mass over `admit`/`reject`
  from any OpenAI-compatible endpoint's top-logprobs instead of sampled text. Fails closed
  like every assessor: endpoint error, missing mass, or off-candidate tokens → negative.
- Scored verdicts land in the decision basis (`· <judge> <score>`); `dsh review` gains a
  judges section (verdict mix + mean P(admit) per judge) and the panel renders it.
- `--judge-base-url/-model/-threshold` (+ `JUDGE_*` env, falling back to `ASSESS_*`) —
  a judge swap is a config change, not a governance change.
- Panel: bilingual UI (en/zh toggle, persisted; domain terms stay English by design) and
  the #144 shutdown-ordering fix (watch drains the panel before the database closes).

# Changelog

## v1.6.0 — the earned-autonomy release

The review is computable, the rung is clickable, the judge is yours.

- **`dsh review`** — the computable promotion review: per-scope evidence (shadows, thread breadth, assessor rejections, era-aware suggestions), policy eras, thread focus. The Month-N review made one command. (#135)
- **Per-scope rungs (the grant write path)** — `AdmissionRow.acceptMode` overrides the engine's global mode per scope; the panel's review desk grants/revokes rungs with an exact-diff double-confirm dialog; every grant lands `policy.version` + semantic `policy.rung` rows in the ledger. (#141)
- **The trust console** — panel gains the promotion desk, a cursor-accumulating live evidence stream (filters, pause, kind color bands) and a ledger timeline rail with hover detail. (#139/#140)
- **Routines first-enable grace** — a slot missed by less than one poll interval on a first-enable routine is honored once instead of silently skipping a whole period. (#132/#134)
- **README** — real-world use cases (four live scenarios), the trust-ladder diagram, framed Comparison rows (Paseo, LoopForge), badge row. (#128/#136/#137)
- **Ops routes are first-class** — `dsh ops <login> <thread>` and `POST /api/ops` register the digit surface on any channel's thread (was IM-DM-only, dead code).
- **BYO-judge design** — decision models (Piccolo-class, /v1/systemone) as the slow-path assessor: design page shipped, implementation next. (#133, docs/designs/byo-judge.md)

360 tests. Node 20/22. Zero runtime dependencies.
