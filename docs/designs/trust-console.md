# The trust console — v1.6 UI design

> Three screens that make trust visible and operable. Scope locked 2026-11-17.
> Discipline: every feature must answer *"does it make trust more visible or more
> operable?"* — no chat workbench, no editor, no terminal panel (that is LoopForge's and
> Paseo's lane). Zero-dependency: the existing hand-rolled `panel.html` + vanilla JS +
> SVG approach continues; no framework, no build step.

## Why

dsh sells invisible machinery — admission tables, shadow decisions, hash chains, rung
promotion. The CLI prints text; the IM shows one digit. A trust product that cannot be
*seen* cannot be *believed*. The panel already has tickets/status (v1.3), topology and
the events cursor API (v1.5); `dsh review` shipped the data layer (v1.6 dev). This design
wires those into three screens and adds the one missing write path: granting a rung.

## Screen 1 — Review & Grant workbench (the promotion desk)

The human half of the trust ladder. `dsh review` output, rendered as a work surface.

```text
┌─ REVIEW ────────────────────────────────────────────────────────────────────┐
│ window: [all ▾]   scope: [all ▾]      252 decisions · 197 shadows · v1–v8    │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▸ issue_comment      34 shadows · 11 threads · 0 rejections · 11-03→11-09    │
│    suggestion: AUTO-CANDIDATE                                                │
│    [ evidence ▾ ]  [ inspect threads ▾ ]        [ GRANT AUTO RUNG ]  (danger)│
│ ▸ issue              31 shadows · 31 threads …                               │
│ ▸ im_dm              69 shadows · 1 thread  …   suggestion: INSUFFICIENT     │
│ ▸ pr                 63 shadows · 63 threads…   suggestion: AUTO-CANDIDATE ⚠ │
│    ⚠ 58 of 63 shadows are from policy v1–v3 (pre-fix era) — see eras below   │
├─ policy eras ────────────────────────────────────────────────────────────────┤
│ v1 ▓▓▓▓▓▓▓▓▓▓ 91%   v2 ▓▓▓▓▓▓▓▓▓▓ 91%   v3 ▓▓▓▓▓▓▓▓▓▓ 100%                   │
│ v4 ▓ 8% (pr-inferred fixed) … v8 ▓▓▓ 32%                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Data**: `reviewReport()` from `src/review.ts` — verbatim reuse; the panel calls a
  JSON endpoint (`/api/review`) that wraps it.
- **Era-awareness (the v2 heuristic from the live finding)**: the ⚠ note marks scopes
  whose shadow mass is dominated by superseded policy versions; the panel computes the
  split from `byPolicyVersion` + per-scope version breakdown (one extra GROUP BY).
- **GRANT AUTO RUNG** (the only write path): click → confirm dialog showing the exact
  policy diff (`table[scope].listedNotAddressing: inferred → accept` …) and the version
  bump (v8 → v9) → panel POST applies it via the engine (`setPolicyIfChanged` + per-scope
  table update), the ledger emits `policy.version` (existing event kind), the card flips
  to "AUTO granted v9 @ ts". Destructive styling + double-confirm, mirroring the IM
  digit-2 two-key pattern.

## Screen 2 — Live evidence stream (already 80% built)

v1.5 shipped `/api/events?after=<cursor>` + the kv head anchor. The screen renders it as
the engine's heartbeat:

```text
┌─ EVIDENCE ──────────────────────────────────────────────────────── chain ✓ ──┐
│ 14:02:11 decision.recorded   IGNORE  pr            vicfei   (basis: …)        │
│ 14:02:10 ticket.opened       #12     issue #40     inferred                  │
│ 14:01:58 engine.boot         pid 505519            policy v9                 │
│ ▸ filter [kind ▾][thread ▾]   ⏸ pause    ● live (cursor 1042, head a41f…)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

- kinds color-banded (decision/ticket/policy/approval), click-through to the thread's
  decision history; the `chain ✓` badge comes from `verify()` and re-runs on demand.

## Screen 3 — Ledger timeline & verify

The tamper-evidence, demonstrated rather than claimed:

```text
┌─ LEDGER ─────────────────────────────────────────────────────────────────────┐
│ ●────●────●────●────●───…──●  1,042 events   head a41f…9c2                    │
│ [ verify ]  ✓ chain intact — every entry_hash recomputes; anchor matches       │
│ hover a node → { id, ts, kind, payload } · click → raw JSON row                │
└──────────────────────────────────────────────────────────────────────────────┘
```

- One SVG rail (reuse the topology-SVG technique), nodes clustered by kind; the verify
  button runs `EventLedger.verify()` and shows the first broken row on failure — the
  failure state is part of the demo ("edit any row and this goes red").

## Write-path & security posture

- Panel stays 127.0.0.1-bound (operator's machine); the grant path is panel-local, same
  trust boundary as today's `setAcceptMode`. Remote UI/multi-user auth is a non-goal for
  v1.6 (v1.7 candidate: fleet aggregation over multiple engine DBs, read-only first).

## Implementation slices (each independently shippable)

1. `/api/review` endpoint + Screen 1 read-side (eras, ⚠) — the biggest visible win.
2. Screen 2 polish (filters, color bands) over the existing stream.
3. Screen 3 rail + verify badge.
4. Grant write path + confirm dialog + ledger round-trip.
5. Screenshots → README visual pass 2.
