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
