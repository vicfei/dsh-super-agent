// Routines — the timer Source (v1.2, design: docs/designs/routines-source.md).
// Zero-dep cron parser tables, IANA tz folding via Intl, catch-up coalescing,
// exactly-once via Source positions, sweep isolation, and load guardrails.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, RoutineDefinition, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import type { SourceState } from "../src/source.js";
import {
  MAX_ROUTINE_DEFINITIONS,
  ROUTINE_CATCHUP_HORIZON_MS,
  TimerSource,
  lastKey,
  nextCronMatch,
  nextEveryMatch,
  nextRoutineFire,
  parseCron,
  routineTrigger,
  renderSchedule,
  threadIdToScope,
  validateRoutines,
} from "../src/routines.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A UTC wall-clock instant — tests stay deterministic across host zones. */
const utc = (iso: string) => Date.parse(iso);

function def(partial: Partial<RoutineDefinition> = {}): RoutineDefinition {
  return {
    id: "digest",
    prompt: "Summarize the day.",
    schedule: { cron: "0 8 * * *", tz: "UTC" },
    reportTo: "wechat:peer/wxid_ops",
    ...partial,
  };
}

function policyWith(defs: RoutineDefinition[], extra: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    allowedList: ["alice"],
    botList: [],
    acceptMode: "auto",
    table: [
      { scope: "im_dm" as const, listedNotAddressing: "inferred", unlistedAddressing: "inferred", unlistedNotAddressing: "ignore" },
    ],
    routines: { enabled: true, definitions: defs },
    ...extra,
  };
}

// ── cron parser (Gap 1) ──────────────────────────────────────────────────────

describe("parseCron", () => {
  it("field forms", () => {
    expect(parseCron("* * * * *")).toMatchObject({
      minutes: expect.any(Array),
      domRestricted: false,
      dowRestricted: false,
    });
    expect(parseCron("* * * * *").minutes).toHaveLength(60);
    expect(parseCron("*/15 * * * *").minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron("10-40/10 * * * *").minutes).toEqual([10, 20, 30, 40]);
    expect(parseCron("5/15 * * * *").minutes).toEqual([5, 20, 35, 50]); // start-step runs to the field max
    expect(parseCron("0 8 * * *").hours).toEqual([8]);
    expect(parseCron("0 7-9,20 * * *").hours).toEqual([7, 8, 9, 20]);
    expect(parseCron("0 0 1,15 * *").doms).toEqual([1, 15]);
    expect(parseCron("0 0 * jan,jul *").months).toEqual([1, 7]);
  });

  it("weekday names, lists and 7≡0 (Sunday)", () => {
    expect(parseCron("0 0 * * mon-fri").dows).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 * * sun,sat").dows).toEqual([0, 6]);
    expect(parseCron("0 0 * * 7").dows).toEqual([0]);
    expect(parseCron("0 0 * * 5-7").dows).toEqual([0, 5, 6]);
  });

  it("rejects the whole zoo at parse time", () => {
    const bad = [
      "0 8 * * * *",   // 6 fields (seconds)
      "0 8 * *",       // 4 fields
      "60 * * * *",    // minute out of range
      "* 24 * * *",    // hour out of range
      "0 8 0 * *",     // day-of-month 0
      "0 8 32 * *",    // day-of-month 32
      "0 8 * 13 *",    // month 13
      "0 8 * * 8",     // weekday 8 (0-7 only)
      "*/0 * * * *",   // step 0
      "5-1 * * * *",   // reversed range
      "* /2 * * * *",  // "* /2" typo — "/2" is not a field
      "jan * * * *",   // names only exist in month/weekday
      "0 8 * * 1-x",   // garbage
      "0 8 * * 1-5/0", // step 0 on a range
    ];
    for (const expr of bad) expect(() => parseCron(expr), expr).toThrow();
  });
});

// ── tz folding (Gap 2) ───────────────────────────────────────────────────────

describe("nextCronMatch", () => {
  it("0 8 * * * in Asia/Shanghai fires at 00:00Z (design example)", () => {
    const spec = parseCron("0 8 * * *");
    const next = nextCronMatch(utc("2026-11-04T16:00:01Z"), spec, "Asia/Shanghai");
    expect(next).toBe(utc("2026-11-05T00:00:00Z"));
  });

  it("strictly after: a boundary instant yields the NEXT day, not itself", () => {
    const spec = parseCron("0 8 * * *");
    expect(nextCronMatch(utc("2026-11-05T00:00:00Z"), spec, "Asia/Shanghai")).toBe(utc("2026-11-06T00:00:00Z"));
  });

  it("weekdays skip the weekend in the routine's tz", () => {
    const spec = parseCron("0 8 * * 1-5");
    // Fri 2026-11-06 08:00 CST → next is Mon 2026-11-09 08:00 CST
    expect(nextCronMatch(utc("2026-11-06T00:00:00Z"), spec, "Asia/Shanghai")).toBe(utc("2026-11-09T00:00:00Z"));
  });

  it("same cron, different zones — per-routine tz (not host, not UTC)", () => {
    const spec = parseCron("0 8 * * *");
    const from = utc("2026-11-04T00:00:00Z");
    expect(nextCronMatch(from, spec, "UTC")).toBe(utc("2026-11-04T08:00:00Z"));
    // Nov 4 08:00 JST = Nov 3 23:00Z is already past `from` → the next is Nov 5 08:00 JST
    expect(nextCronMatch(from, spec, "Asia/Tokyo")).toBe(utc("2026-11-04T23:00:00Z"));
  });

  it("hour 23 renders via h23 — no phantom hour 24", () => {
    const spec = parseCron("0 23 * * *");
    expect(nextCronMatch(utc("2026-11-04T10:00:00Z"), spec, "Asia/Tokyo")).toBe(utc("2026-11-04T14:00:00Z"));
  });

  it("DST spring-forward gap: the 02:30 wall time that never existed is skipped, not corrected", () => {
    // America/New_York springs forward 2026-03-08 02:00→03:00; 02:30 does not exist that day.
    const spec = parseCron("30 2 8 3 *");
    const next = nextCronMatch(utc("2026-03-07T12:00:00Z"), spec, "America/New_York");
    // next Mar 8 with an existing 02:30 is 2027-03-08 (DST starts 2027-03-14) → EST = UTC-5
    expect(next).toBe(utc("2027-03-08T07:30:00Z"));
  });

  it("DST fall-back fold resolves deterministically to the earlier occurrence", () => {
    // America/New_York falls back 2026-11-01: 01:30 happens twice (05:30Z EDT and 06:30Z EST).
    const spec = parseCron("30 1 1 11 *");
    expect(nextCronMatch(utc("2026-10-30T00:00:00Z"), spec, "America/New_York")).toBe(utc("2026-11-01T05:30:00Z"));
  });

  it("dom/dow OR rule when both are restricted (Vixie semantics)", () => {
    // "0 0 13 * 5" = the 13th OR any Friday
    const spec = parseCron("0 0 13 * 5");
    // from Nov 1 2026 (a Sunday): first Friday is Nov 6; the 13th (also a Friday) comes later
    expect(nextCronMatch(utc("2026-11-01T00:00:00Z"), spec, "UTC")).toBe(utc("2026-11-06T00:00:00Z"));
    // from Nov 7: next 13th is Fri 2026-11-13
    expect(nextCronMatch(utc("2026-11-07T00:00:00Z"), spec, "UTC")).toBe(utc("2026-11-13T00:00:00Z"));
  });

  it("throws when the schedule can never match within the search window", () => {
    // Feb 29 exists, but pin the throw path with a 5-year-free dom/month combo that parses
    expect(() => nextCronMatch(utc("2026-01-01T00:00:00Z"), parseCron("0 0 30 2 *"), "UTC")).toThrow(/no match/i);
  });
});

describe("nextEveryMatch", () => {
  it("anchors at epoch: next top-of-hour, strictly after", () => {
    expect(nextEveryMatch(utc("2026-11-05T15:30:00Z"), HOUR)).toBe(utc("2026-11-05T16:00:00Z"));
    expect(nextEveryMatch(utc("2026-11-05T16:00:00Z"), HOUR)).toBe(utc("2026-11-05T17:00:00Z"));
  });
  it("{hours: 2} ≡ {minutes: 120}", () => {
    expect(nextEveryMatch(utc("2026-11-05T15:30:00Z"), 2 * HOUR)).toBe(utc("2026-11-05T16:00:00Z"));
  });
});

// ── nextRoutineFire: catch-up (Gap 3) and the first-enable rule ──────────────

describe("nextRoutineFire", () => {
  const now = utc("2026-11-05T15:00:00Z");

  it("caught-up routine: next is simply the next future slot", () => {
    const last = utc("2026-11-05T08:00:00Z");
    expect(nextRoutineFire(def(), last, now)).toBe(utc("2026-11-06T08:00:00Z"));
  });

  it("3 intervals stale → the FIRST missed schedule is honored, not now", () => {
    const every10 = def({ id: "soak", schedule: { every: { minutes: 10 } }, reportTo: "github:o/r/issues/80" });
    const last = now - 35 * MIN; // missed: T-30, T-20, T-10
    expect(nextRoutineFire(every10, last, now)).toBe(now - 30 * MIN);
  });

  it("catch-up horizon: slots older than 7 days are dropped, not replayed", () => {
    const daily = def(); // 08:00 UTC daily
    const last = now - 10 * DAY; // ten days without a run
    const fire = nextRoutineFire(daily, last, now);
    expect(fire).toBeGreaterThan(now - ROUTINE_CATCHUP_HORIZON_MS - DAY); // within the horizon…
    expect(fire).toBeLessThanOrEqual(now); // …but still a catch-up (due now)
  });

  it("first enable (no kv state) starts at NOW — no 56 years of backlog", () => {
    expect(nextRoutineFire(def(), undefined, now)).toBe(utc("2026-11-06T08:00:00Z"));
  });
});

// ── TimerSource: the sweep ───────────────────────────────────────────────────

describe("TimerSource.collect", () => {
  let dir: string;
  let engine: Engine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-routines-"));
    engine = new Engine(join(dir, "engine.db"));
  });
  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const NOW = utc("2026-11-05T08:30:00Z");

  function sweep(p: Policy, from: SourceState = engine.sourceState("timer"), now = NOW) {
    return new TimerSource({ policy: p, now: () => new Date(now), log: () => {} }).collect(from, {});
  }

  it("fires a due routine and advances its position in the same returned state", async () => {
    const p = policyWith([def()]); // 08:00 UTC daily; last honored yesterday → today's slot is due
    const from: SourceState = { positions: { [lastKey("digest")]: NOW - DAY } };
    const { triggers, next } = await sweep(p, from);
    expect(triggers).toHaveLength(1);
    const t = triggers[0] as Trigger;
    expect(t).toMatchObject({
      id: `routine:digest:${new Date(utc("2026-11-05T08:00:00Z")).toISOString()}`,
      source: "timer",
      scope: "im_dm",
      threadId: "wechat:peer/wxid_ops",
      author: { login: "routine:digest", isBot: false },
      addressing: true,
      body: "Summarize the day.",
      ts: new Date(utc("2026-11-05T08:00:00Z")).toISOString(),
    });
    expect(next.positions[lastKey("digest")]).toBe(utc("2026-11-05T08:00:00Z"));
  });

  it("not due → no triggers, positions untouched", async () => {
    const p = policyWith([def({ schedule: { cron: "0 9 * * *", tz: "UTC" } })]); // next 09:00
    const { triggers, next } = await sweep(p);
    expect(triggers).toHaveLength(0);
    expect(next.positions).toEqual({});
  });

  it("exactly-once: re-running the sweep at the same now fires nothing new", async () => {
    const p = policyWith([def()]);
    const from: SourceState = { positions: { [lastKey("digest")]: NOW - DAY } };
    const first = await sweep(p, from);
    expect(first.triggers).toHaveLength(1);
    engine.ingest(
      first.triggers.map((t) => ({ trigger: t, gate: { strength: "inferred" as const, basis: "b" }, resolution: { action: "accept" as const, strength: "inferred" as const, basis: "b" } })),
      { timer: first.next },
    );
    const second = await sweep(p);
    expect(second.triggers).toHaveLength(0);
  });

  it("missed runs coalesce: one fire per sweep, kv moves to the honored schedule", async () => {
    const every10 = def({ id: "soak", schedule: { every: { minutes: 10 } } });
    const p = policyWith([every10]);
    const from: SourceState = { positions: { [lastKey("soak")]: NOW - 35 * MIN } };
    const { triggers, next } = await sweep(p, from);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].ts).toBe(new Date(NOW - 30 * MIN).toISOString()); // first missed, not now
    expect(next.positions[lastKey("soak")]).toBe(NOW - 30 * MIN); // kv to that schedule, not to now
  });

  it("a routine misconfigured to every-minute fires at most once per sweep", async () => {
    const every1 = def({ id: "spam", schedule: { every: { minutes: 1 } } });
    const p = policyWith([every1]);
    const last = NOW - 5 * MIN; // slots 08:26…08:30 all missed — one fire, the oldest
    const { triggers } = await sweep(p, { positions: { [lastKey("spam")]: last } });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].ts).toBe(new Date(NOW - 4 * MIN).toISOString());
  });

  it("disabled / absent routines fire nothing (enabled absent = disabled)", async () => {
    expect((await sweep({ ...policyWith([def()]), routines: { enabled: false, definitions: [def()] } })).triggers).toHaveLength(0);
    const noKey = policyWith([def()]);
    delete (noKey as Partial<Policy>).routines;
    expect((await sweep(noKey)).triggers).toHaveLength(0);
  });

  it("global per-tick cap of 32 fires — the tick does work, never floods", async () => {
    const defs = Array.from({ length: MAX_ROUTINE_DEFINITIONS + 2 }, (_, i) =>
      def({ id: `r-${i}`, schedule: { every: { minutes: 60 } } }));
    const from: SourceState = { positions: Object.fromEntries(defs.map((d) => [lastKey(d.id), NOW - 2 * HOUR])) };
    const { triggers, next } = await sweep(policyWith(defs), from);
    expect(triggers).toHaveLength(MAX_ROUTINE_DEFINITIONS);
    // the two capped-out routines keep their old state (never moved without a fire)
    const unfired = defs.slice(MAX_ROUTINE_DEFINITIONS).map((d) => next.positions[lastKey(d.id)]);
    expect(unfired).toEqual([NOW - 2 * HOUR, NOW - 2 * HOUR]);
  });

  it("sweep isolation: one throwing routine logs and skips; the others still fire", async () => {
    const logs: string[] = [];
    const bad = def({ id: "bad", schedule: { cron: "0 0 30 2 *" } }); // parses, never matches → throws
    const p = policyWith([bad, def()]);
    const from: SourceState = { positions: { [lastKey("digest")]: NOW - DAY } };
    const { triggers, next } = await new TimerSource({ policy: p, now: () => new Date(NOW), log: (l) => logs.push(l) }).collect(from, {});
    expect(triggers).toHaveLength(1);
    expect(triggers[0].author.login).toBe("routine:digest");
    expect(next.positions[lastKey("bad")]).toBeUndefined(); // failed evaluation never moves state
    expect(logs.some((l) => l.includes("bad") && l.includes("skipped"))).toBe(true);
  });
});

// ── load guardrails (fail closed, whole file) ────────────────────────────────

describe("validateRoutines", () => {
  it("accepts a well-formed policy and returns the definitions", () => {
    const v = validateRoutines(policyWith([def()]));
    expect(v.errors).toHaveLength(0);
    expect(v.definitions).toHaveLength(1);
  });

  it("collects every error, not just the first", () => {
    const p = policyWith([
      def({ id: "UPPER" }),                                  // id charset
      def({ id: "digest" }),                                 // first digest — valid
      def({ id: "digest", prompt: "again" }),                // duplicate id
      def({ id: "both", schedule: { cron: "0 8 * * *", every: { minutes: 5 } } }), // both schedulers
      def({ id: "neither", schedule: {} }),                  // no scheduler
      def({ id: "badtz", schedule: { cron: "0 8 * * *", tz: "Mars/Olympus" } }),   // invalid IANA
      def({ id: "badcron", schedule: { cron: "0 8 * * * *" } }),                   // 6 fields
      def({ id: "badto", reportTo: "pigeon:coop-42" }),      // unknown channel
      def({ id: "emptyprompt", prompt: "" }),                // 1–4096
      def({ id: "badevery", schedule: { every: { minutes: 0 } } }),                // 1..20160
      def({ id: "neverday", schedule: { cron: "0 0 31 4,6,9,11 *" } }),            // dom 31 in 30-day months
    ]);
    const v = validateRoutines(p);
    expect(v.errors.length).toBeGreaterThanOrEqual(10);
    expect(v.errors.join("\n")).toContain("duplicate");
    expect(v.errors.join("\n")).toContain("Mars/Olympus");
    expect(v.errors.join("\n")).toContain("pigeon:");
  });

  it("caps definitions at 32 — a clock is not a load balancer", () => {
    const defs = Array.from({ length: 33 }, (_, i) => def({ id: `r-${i}` }));
    expect(validateRoutines(policyWith(defs)).errors[0]).toContain("32");
  });

  it("warns when the scope's admission row would never admit the routine", () => {
    const p = policyWith([def()]);
    p.table = [{ scope: "im_dm", listedNotAddressing: "inferred", unlistedAddressing: "ignore", unlistedNotAddressing: "ignore" }];
    const v = validateRoutines(p);
    expect(v.errors).toHaveLength(0);
    expect(v.warnings.join("\n")).toContain("unlistedAddressing");
  });
});

// ── scope mapping & rendering ────────────────────────────────────────────────

describe("threadIdToScope", () => {
  it("maps every channel's thread shapes", () => {
    expect(threadIdToScope("github:o/r/issues/5")).toBe("issue");
    expect(threadIdToScope("github:o/r/pulls/7")).toBe("pr");
    expect(threadIdToScope("wechat:peer/wxid_a")).toBe("im_dm");
    expect(threadIdToScope("wechat:group/123")).toBe("im_group");
    expect(threadIdToScope("slack:dm/D01")).toBe("im_dm");
    expect(threadIdToScope("slack:channel/C01")).toBe("im_group");
    expect(threadIdToScope("feishu:chat/oc_1")).toBe("im_dm");
    expect(threadIdToScope("telegram:chat/42")).toBe("im_dm");
  });
});

describe("renderSchedule", () => {
  it("shows cron with its tz and every with its interval", () => {
    expect(renderSchedule(def())).toBe('cron "0 8 * * *" UTC');
    expect(renderSchedule(def({ schedule: { cron: "0 8 * * 1-5", tz: "Asia/Shanghai" } }))).toBe('cron "0 8 * * 1-5" Asia/Shanghai');
    expect(renderSchedule(def({ schedule: { every: { minutes: 60 } } }))).toBe("every 60m");
    expect(renderSchedule(def({ schedule: { every: { hours: 6 } } }))).toBe("every 6h");
  });
});

describe("routineTrigger", () => {
  it("manual fires get their own id space (repeatable tool, not a schedule slot)", () => {
    const t = routineTrigger(def(), utc("2026-11-05T08:00:00Z"));
    expect(t.id).toBe(`routine:digest:${new Date(utc("2026-11-05T08:00:00Z")).toISOString()}`);
  });
});
