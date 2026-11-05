# Routines (timer Source) — design (v1.2)

> Status: **implemented** — see §8 for the implementation notes (three places where the
> shipped code narrows this text, and why). Every trigger so far came from a human message. Routines are the first
> triggers that come from **the clock** — so the design burden is inverted: instead of asking
> "how do we trust scheduled work", we make scheduled work knock on the same door as everyone
> else. **A routine is owner-authored config that still passes admission control.** No bypass,
> no privileged lane, no second pipeline.

## 0. Why now (competitive)

- LofiSu/deepseek-super-agent shipped `routines.json` (interval + UTC daily-time) on 11-04
  (#150, #156); their own gap doc lists "cron expressions, per-routine timezone, restart
  drift" as open. We should ship all three closed.
- Routines/proactivity is one of the most recognizable concepts of the personal-agent
  genre (Grok Bot routines, Muse `HEARTBEAT.md`). Project rule: famous concepts must exist.
- Our differentiator is already decided by the architecture: routines enter through the
  **gate**, not around it. LofiSu's routines run "on the daemon tick" — ours are triggers
  subject to the off/observe/auto ladder like any message.

## 1. Policy shape

```jsonc
{
  "routines": {
    "enabled": true,                    // absent = disabled — nothing fires by default
    "definitions": [
      {
        "id": "morning-digest",         // [a-z0-9-]+; unique; stable identity for kv state
        "prompt": "Summarize open tickets, stale PRs, and anything the watchdog nudged. One paragraph.",
        "schedule": {
          "cron": "0 8 * * 1-5",        // 5-field, minute resolution — one of cron | every
          "tz": "Asia/Shanghai"         // IANA; default host local
        },
        "reportTo": "wechat:wxi_…-im"   // an existing thread on any live channel
      },
      {
        "id": "hourly-soak",
        "prompt": "Run the offline test suite; if red, report the failing file and one line why.",
        "schedule": { "every": { "minutes": 60 } },
        "reportTo": "github:vicfei/dsh-super-agent/issues/80"
      }
    ]
  }
}
```

Rules (enforced at config load — fail closed, whole file):

- `id`: `^[a-z0-9][a-z0-9-]{0,63}$`, unique.
- `prompt`: 1–4096 chars. It is an instruction to the agent, exactly like a chat message.
- exactly one of `cron` (5 fields, standard syntax, no seconds/years) or `every`
  (`{minutes: 1..20160}` or `{hours: 1..336}`).
- `tz`: IANA zone name, resolved via `Intl.DateTimeFormat` (zero-dep). Invalid name = load error.
- `reportTo`: must match an existing channel prefix
  (`github:` `feishu:` `slack:` `wechat:` `telegram:`). `dsh routines validate` additionally
  warns when the target thread is not a known ops thread / open GitHub thread — reachable
  but not guaranteed live.
- Cap: 32 definitions; more = load error (a clock is not a load balancer).

## 2. Scheduling semantics — and the three closed gaps

**Tick.** The watch cycle already loops every `--interval` seconds. A new
`runRoutineSweep(engine, policy, now)` runs first in the cycle (before work: firing is
cheap, work is not). Per routine:

1. read kv `routine-last:<id>` (ISO ts of the last **scheduled** fire we honored; absent = epoch);
2. compute `next` = first schedule match strictly after `routine-last`;
3. if `now >= next` → enqueue one trigger carrying `next` as its scheduled ts, and set
   `routine-last` to `next` **in the same engine transaction** (exactly-once across restarts,
   same pattern as Source positions);
4. repeat step 2–3 at most once per tick per routine (a routine misconfigured to
   every-minute with interval=15s still fires at most once per sweep).

**Gap 1 — cron expressions.** Minimal zero-dep parser: 5 fields, `*`, `N`, `N-M`, `N/M`,
`N-M/M`, lists. Named ranges only where standard (`0-6` weekday, Sunday=0 **and** 7).
Reject anything else at load. ~120 lines + table tests.

**Gap 2 — per-routine timezone.** Cron is evaluated in `tz`: to ask "is it 08:00 in
Asia/Shanghai now", fold wall-clock via
`Intl.DateTimeFormat("en-GB", {timeZone, hour12:false, …})` and walk minute-by-minute only
across the boundary (at most 2 evaluations per tick — no scanning the day). DST gap
(02:30 on spring-forward night) = no match that day, documented, not "corrected".

**Gap 3 — restart drift.** Solved by the kv: on restart, `routine-last` survives; a routine
down for 3 scheduled fires fires **once** on the next tick (missed runs coalesce into one —
"a digest three times is not three times as useful"). The trigger's `ts` is the schedule
time it honors, not wall-clock now, so logs tell the truth.

## 3. The trigger — through the front door

```
Trigger {
  id: `routine:<id>:<scheduledTs>`,     // idempotency: accepting twice yields one Ticket
  source: "timer",                      // union extends; footer of every stat line
  scope: <the reportTo thread's scope>, // im_dm for DM threads; issue for github issue threads
  threadId: <reportTo>,                 // THE target thread — see §4
  author: { login: `routine:<id>`, isBot: false },
  addressing: true,                     // a routine addresses the agent by construction
  body: <prompt>, ts: <scheduledTs>
}
```

Gate rule: a `source:"timer"` trigger is admitted **iff** its `id`'s routine exists in the
loaded policy (config IS the owner's voice — explicit strength) **and** the admission row
for its scope says so under the current ladder. Consequences, all by construction:

- **observe mode**: routine tickets are ordinary observe-mode tickets — with speculation on,
  they rehearse silently and surface via the approval surface (`🧪 rehearsal ready … 1 promote
  · 2 discard`); with speculation off they are shadows. The clock does not escalate trust.
- **row says ignore / no row**: fires into nothing; one log line. The clock does not create
  scope.
- **assessment**: one LLM call per thread, dedup by `verdictByThread` — a routine firing
  into a thread that also chats dedupes with the chat, exactly like a human follow-up.
- **subscription bypass**: a routine firing while its thread's previous ticket is still open
  **joins as context** (ticket_followup) instead of stacking a second ticket. "Hourly soak"
  on one thread can never pile up.

## 4. Why `threadId = reportTo` (and not a `routine:` namespace)

The tempting design is `routine:<id>` threads + a routing map to the reply channel. We
reject it: it forks the reply path, the context-join path, and the approval-routing path
for zero benefit. Reusing the real thread id means **everything already built keeps
working** — replies deliver, bursts coalesce, the watchdog nudges, IM digits route, and the
morning digest lands in the same chat the owner already reads. A thread that mixes human
messages and routine runs is not contamination; it is the product ("the agent also writes
first"). The routine's identity stays visible in the ticket line
(`from routine:morning-digest · wechat DM`).

## 5. Sweep wiring & rate guard

`watch.ts` cycle becomes: **routine sweep → promote sweep → approval sweep → watchdog
sweep → (existing per-thread assessment dedup, work, merge)**. Firing writes one trigger
per routine per tick; a global per-tick cap of 32 fires logs-and-stops (a misconfigured
`every:1min` across 30 routines degrades to "the tick did work", never to a flood).

Failure containment: schedule evaluation errors (bad tz data, clock skew backwards) are
caught per routine — one routine's exception must not stall the sweep (log, skip, next tick
retries). `routine-last` never moves on a failed enqueue (transaction).

## 6. CLI

```
dsh routines list [--config …]      # id · schedule (rendered w/ tz) · next fire · reportTo
dsh routines validate [--config …]  # load errors + reachability warnings; exit ≠ 0 on error
dsh routines fire <id> [--now]      # manual fire for testing (marks routine-last = now)
```

`list` computes next fire from current kv state — the answer to "is my digest actually
scheduled". `fire` is the dogfood tool: verify the full pipeline (gate → ticket → executor
→ reply in your DM) before waiting a day for the cron to prove it.

## 7. Tests (offline, deterministic)

- cron parser: field forms, named lists, `7`≡`0` weekday, rejects 6 fields / seconds / `* /2` typos.
- tz fold: `0 8 * * *` in `Asia/Shanghai` fires at 00:00Z; DST spring-forward gap skipped.
- catch-up coalesce: `routine-last` 3 intervals stale → exactly one trigger, `ts` = first
  missed schedule; kv moves to that schedule, not to now.
- exactly-once: re-run sweep at same now → no second trigger (id idempotency + kv).
- admission: ladder row ignore → no ticket; observe + speculation → speculative ticket;
  auto → working ticket.
- context join: open ticket on thread → routine trigger becomes followup context.
- load guardrails: dup id, bad tz, both cron+every, 33 definitions → load error.
- sweep isolation: one throwing routine does not block others.

## 8. Implementation notes (what shipped, and the three deltas)

1. **State rides the standard Source positions.** The last honored slot lives in the
   engine's `positions:timer` map under `last:<id>` (epoch ms), not a separate
   `routine-last:<id>` kv key — the exactly-once guarantee is identical (persisted in the
   same ingest transaction as the fired triggers, the same pattern as every other Source),
   and it needed zero schema changes.
2. **First enable starts at now, not epoch.** With no state, the first match is computed
   strictly after *now* — enabling a routine never replays history (a literal "absent =
   epoch" would fire one 1970-era slot per sweep for a week). `dsh routines fire` is the
   tool for "prove the pipeline right now". Missed-slot catch-up (restart drift) still
   honors the *first* missed schedule with a 7-day horizon: slots older than that are
   dropped, not replayed — a digest three days late is useful, fifty is spam. Replays run
   one slot per sweep and coalesce onto the thread's open ticket, so they converge.
3. **The clock never resumes.** A timer trigger whose thread's previous (same-opener)
   ticket already *ended* opens fresh work; the person-resume rule of docs/002 stays a
   person rule. Open tickets are joined as context regardless of opener (§3).
4. Confirmed by construction (worth saying out loud): the trigger's `author` is
   `routine:<id>` with `isBot: false`, so the gate evaluates it as an **unlisted sender
   addressing the agent** — the row cell that decides is `unlistedAddressing`, the strength
   ceiling is "inferred", and the ladder/Slow Path/speculation all apply unchanged. A
   routine fires only when its scope's `unlistedAddressing` cell is `"inferred"`;
   `dsh routines validate` warns when it isn't.
5. Minor pins: DST fall-back folds resolve to the earlier occurrence; `every` intervals
   anchor at epoch UTC (a 60-minute routine fires on the top of each hour).
