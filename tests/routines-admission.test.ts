// Routines admission — the clock knocks on the same door (v1.2).
// Gate rule (routine in policy + admission cell), ladder consequences
// (off/observe/auto), subscription-bypass context join, and the watch cycle
// running the timer Source first (design: docs/designs/routines-source.md §3–5).

import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, RoutineDefinition, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { classify } from "../src/runner.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { TimerSource, lastKey, routineTrigger } from "../src/routines.js";
import type { ReplyChannel, Source, SourceState } from "../src/source.js";
import { runWatch } from "../src/watch.js";

let dir: string;
let engine: Engine;

const digest: RoutineDefinition = {
  id: "digest",
  prompt: "Summarize the day.",
  schedule: { cron: "0 8 * * *", tz: "UTC" },
  reportTo: "wechat:peer/wxid_ops",
};

function policyWith(over: Partial<Policy> = {}, defs: RoutineDefinition[] = [digest]): Policy {
  return {
    version: 1,
    allowedList: ["alice"],
    botList: [],
    acceptMode: "auto",
    table: [
      { scope: "im_dm" as const, listedNotAddressing: "inferred", unlistedAddressing: "inferred", unlistedNotAddressing: "ignore" },
    ],
    routines: { enabled: true, definitions: defs },
    ...over,
  };
}

const NOW = Date.parse("2026-11-05T08:30:00Z");
const HOUR_MS = 3_600_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-routadm-"));
  engine = new Engine(join(dir, "engine.db"));
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function accept(policy: Policy, t: Trigger, assessment: "positive" | "negative" = "positive") {
  return classify(t, policy, assessment);
}

// ── the gate rule ────────────────────────────────────────────────────────────

describe("gate: a timer trigger is a trigger like any other", () => {
  const t = routineTrigger(digest, Date.parse("2026-11-05T08:00:00Z"));

  it("routine in policy + cell inferred → inferred strength (never explicit — the ladder applies)", () => {
    const g = evaluateGate(policyWith(), t);
    expect(g.strength).toBe("inferred");
    expect(g.basis).toContain("digest");
  });

  it("routine missing from the loaded policy → not admitted; the clock does not create scope", () => {
    const g = evaluateGate(policyWith({ routines: { enabled: true, definitions: [] } }), t);
    expect(g.strength).toBeNull();
    expect(g.basis).toContain("not in loaded policy");
  });

  it("routines disabled → not admitted", () => {
    const g = evaluateGate(policyWith({ routines: { enabled: false, definitions: [digest] } }), t);
    expect(g.strength).toBeNull();
  });

  it("row says ignore (or no row) → fires into nothing", () => {
    const ignoreRow = policyWith({
      table: [{ scope: "im_dm", listedNotAddressing: "inferred", unlistedAddressing: "ignore", unlistedNotAddressing: "ignore" }],
    });
    expect(evaluateGate(ignoreRow, t).strength).toBeNull();
    const noRow = policyWith({ table: [] });
    expect(evaluateGate(noRow, t).strength).toBeNull();
  });

  it("trigger pointing at a thread other than the routine's reportTo → not admitted", () => {
    const forged: Trigger = { ...t, threadId: "wechat:peer/wxid_other" };
    expect(evaluateGate(policyWith(), forged).strength).toBeNull();
  });
});

// ── ladder consequences, by construction ─────────────────────────────────────

describe("admission under the ladder", () => {
  const slot = Date.parse("2026-11-05T08:00:00Z");

  function ingest(policy: Policy, assessment: "positive" | "negative" = "positive") {
    engine.setPolicyIfChanged(policy);
    const item = accept(policy, routineTrigger(digest, slot), assessment);
    return { item, report: engine.ingest([item], { timer: { positions: { [lastKey("digest")]: slot } } }) };
  }

  it("auto → a working ticket on the reportTo thread, opener routine:<id>", () => {
    const { report } = ingest(policyWith());
    expect(report.ticketsOpened).toBe(1);
    const t = engine.tickets()[0];
    expect(t).toMatchObject({ threadId: "wechat:peer/wxid_ops", opener: "routine:digest", strength: "inferred", stage: "queued" });
  });

  it("observe + speculation → a silent speculative ticket (the clock does not escalate trust)", () => {
    const p = policyWith({ acceptMode: "observe", speculation: { enabled: true, maxSpeculative: 1 } });
    const { report } = ingest(p);
    expect(report.ticketsOpened).toBe(0);
    expect(report.speculative).toBe(1);
    expect(engine.tickets()[0].speculative).toBe(true);
  });

  it("observe without speculation → a shadow, nothing opened", () => {
    const { report } = ingest(policyWith({ acceptMode: "observe" }));
    expect(report.ticketsOpened).toBe(0);
    expect(report.speculative).toBe(0);
    expect(engine.tickets()).toHaveLength(0);
    const d = engine.decisions()[0];
    expect(d.wouldAccept).toBe(true);
  });

  it("off → rejected (record only)", () => {
    const { item, report } = ingest(policyWith({ acceptMode: "off" }));
    expect(item.resolution.action).toBe("reject");
    expect(report.ticketsOpened).toBe(0);
  });

  it("negative assessment → rejected", () => {
    const { item } = ingest(policyWith(), "negative");
    expect(item.resolution.action).toBe("reject");
  });

  it("duplicate schedule slot honored twice → one ticket (id idempotence)", () => {
    ingest(policyWith());
    const again = accept(policyWith(), routineTrigger(digest, slot));
    const r2 = engine.ingest([again]);
    expect(r2.duplicates).toBe(1);
    expect(engine.tickets()).toHaveLength(1);
  });
});

// ── subscription bypass: joins, never stacks ─────────────────────────────────

describe("context join", () => {
  const slot2 = Date.parse("2026-11-06T08:00:00Z");

  function humanTrigger(over: Partial<Trigger> = {}): Trigger {
    return {
      id: `wechat:msg/${Math.random().toString(36).slice(2)}`,
      source: "wechat", scope: "im_dm", threadId: "wechat:peer/wxid_ops",
      author: { login: "alice", isBot: false }, addressing: true,
      body: "also check the soak", ts: new Date(NOW).toISOString(),
      ...over,
    };
  }

  it("a routine firing while its thread's ticket is open joins as context — any opener", () => {
    const p = policyWith();
    engine.setPolicyIfChanged(p);
    engine.ingest([accept(p, humanTrigger())]); // alice's ticket open on the thread
    const r = engine.ingest([accept(p, routineTrigger(digest, slot2))]);
    expect(r.joined).toBe(1);
    expect(r.ticketsOpened).toBe(0);
    expect(engine.tickets()).toHaveLength(1);
    expect(engine.tickets()[0].followUps).toBe(1);
  });

  it("a routine's own open ticket joins the same way (hourly soak can never pile up)", () => {
    const p = policyWith();
    engine.setPolicyIfChanged(p);
    engine.ingest([accept(p, routineTrigger(digest, Date.parse("2026-11-05T08:00:00Z")))], { timer: { positions: {} } });
    const r = engine.ingest([accept(p, routineTrigger(digest, slot2))]);
    expect(r.joined).toBe(1);
    expect(engine.tickets()).toHaveLength(1);
  });

  it("the clock never resumes: a routine's ended ticket stays ended, a fresh fire opens fresh work", () => {
    const p = policyWith();
    engine.setPolicyIfChanged(p);
    engine.ingest([accept(p, routineTrigger(digest, Date.parse("2026-11-05T08:00:00Z")))]);
    engine.completeTicket(1); // yesterday's digest ended
    const r = engine.ingest([accept(p, routineTrigger(digest, slot2))]);
    expect(r.ticketsOpened).toBe(1);
    expect(r.resumed).toBe(0);
    expect(engine.tickets().map((t) => t.id)).toEqual([2, 1]);
  });
});

// ── the watch cycle: routine sweep first, everything already built keeps working ──

describe("runWatch with the timer Source", () => {
  function echoExecutor(): Executor {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    execSync("git init -q -b main .", { cwd: repo });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q", { cwd: repo });
    const cfg: ExecutorConfig = {
      command: 'echo "digest for $DSH_TICKET"',
      repoDir: repo, workRoot: join(dir, "work"),
      timeoutMs: 15000, maxWorkers: 1, blockedCommands: [],
    };
    return new Executor(cfg);
  }

  it("fires → tickets → works → reports into the reportTo thread via its channel", async () => {
    const policy = policyWith();
    engine.setPolicyIfChanged(policy);
    // a running daemon's state: yesterday's digest already honored → today's 08:00 slot is due
    engine.kvSet("positions:timer", JSON.stringify({ [lastKey("digest")]: NOW - 24 * HOUR_MS }));
    const delivered: [string, string][] = [];
    const wechat: ReplyChannel = {
      matches: (t) => t.startsWith("wechat:"),
      deliver: async (threadId, body) => {
        delivered.push([threadId, body]);
        return { externalId: `msg:${delivered.length}` };
      },
    };
    const logs: string[] = [];
    await runWatch({
      engine,
      sources: [new TimerSource({ policy, now: () => new Date(NOW), log: (l) => logs.push(l) })],
      executor: echoExecutor(),
      client: null, channels: [wechat], repo: "o/r", policy,
      assessment: () => "positive",
      intervalMs: 5, cycles: 2, log: (l) => logs.push(l),
    });

    const t = engine.tickets()[0];
    expect(t).toMatchObject({ opener: "routine:digest", threadId: "wechat:peer/wxid_ops", state: "ended" });
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered[0][0]).toBe("wechat:peer/wxid_ops");
    expect(logs.some((l) => l.includes("[ACCEPT] INFERRED"))).toBe(true);
    // exactly one assessment for the routine's thread
    expect(logs.some((l) => l.includes("#1 [done]"))).toBe(true);
  });

  it("routine and human chat on one thread share one Slow-Path verdict", async () => {
    const policy = policyWith(); // alice listed; im_dm DMs are addressing → explicit… so use non-addressing group chatter
    const group: RoutineDefinition = { ...digest, reportTo: "slack:channel/C01" };
    const p2 = policyWith({}, [group]);
    p2.table = [{ scope: "im_group" as const, listedNotAddressing: "inferred", unlistedAddressing: "inferred", unlistedNotAddressing: "ignore" }];
    engine.setPolicyIfChanged(p2);

    let calls = 0;
    const human: Trigger = {
      id: "slack:msg/h1", source: "slack", scope: "im_group", threadId: "slack:channel/C01",
      author: { login: "bob", isBot: false }, addressing: true, body: "hi", ts: new Date(NOW).toISOString(),
    };
    const humanSource: Source = {
      kind: "slack",
      collect: async (_from: SourceState) => ({ triggers: [human], next: { positions: {} } }),
    };
    await runWatch({
      engine,
      sources: [new TimerSource({ policy: p2, now: () => new Date(NOW), log: () => {} }), humanSource],
      executor: echoExecutor(),
      client: null, channels: [], repo: "o/r", policy: p2,
      assessment: async () => { calls++; return "positive"; },
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(calls).toBe(1); // dedup by thread — the routine is just another unlisted sender
  });
});
