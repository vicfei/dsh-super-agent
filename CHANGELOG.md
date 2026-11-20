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
