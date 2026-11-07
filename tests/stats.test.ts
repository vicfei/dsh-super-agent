// `dsh stats` (v1.3) — every figure a query, every figure auditable. Offline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { runStats, formatStats } from "../src/stats.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  table: [{ scope: "im_dm", listedNotAddressing: "inferred", unlistedAddressing: "inferred", unlistedNotAddressing: "ignore" }],
};

const trig = (id: string, body: string): Trigger => ({
  id, source: "wechat", scope: "im_dm", threadId: "wechat:peer/wxid_a",
  author: { login: "alice", isBot: false }, addressing: true, body, ts: new Date().toISOString(),
});

function accept(t: Trigger): IngestItem {
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-stats-"));
  engine = new Engine(join(dir, "e.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("runStats", () => {
  it("gate counts decisions by kind and source; timer fires group per routine", () => {
    engine.ingest([accept(trig("wechat:msg/1", "do it"))]);
    const timer: Trigger = {
      id: "routine:digest:2026-11-07T01:14:00.000Z", source: "timer", scope: "im_dm",
      threadId: "wechat:peer/wxid_a", author: { login: "routine:digest", isBot: false },
      addressing: true, body: "digest", ts: "2026-11-07T01:14:00.000Z",
    };
    const g = evaluateGate(policy, timer);
    engine.ingest([{ trigger: timer, gate: g, resolution: resolveCandidate(policy, g, "positive") }]);
    const r = runStats(engine);
    expect(r.gate.decisions).toBe(2);
    expect(r.gate.accepted).toBe(1);      // the human message works…
    expect(r.gate.rejected).toBe(1);      // …the orphan timer is gated out (no routine in policy)
    expect(r.gate.bySource).toEqual({ wechat: 1, timer: 1 });
    expect(r.routines).toEqual([{ id: "digest", fires: 1, firstTs: "2026-11-07T01:14:00.000Z", lastTs: "2026-11-07T01:14:00.000Z" }]);
  });

  it("cycle time: creation → first clean assignment, median minutes", () => {
    engine.ingest([accept(trig("wechat:msg/2", "quick"))]);
    const aid = engine.startAssignment(1, "");
    const created = Date.parse(engine.tickets()[0].createdAt);
    engine.endAssignment(aid, 0, false, "ok");
    const r = runStats(engine);
    expect(r.medianCycleMin).not.toBeNull();
    expect(r.medianCycleMin!).toBeGreaterThanOrEqual(0);
    expect(r.tickets.opened).toBe(1);
  });

  it("the --since window filters everything it counts", () => {
    engine.ingest([accept(trig("wechat:msg/3", "old work"))]);
    const later = new Date(Date.now() + 60_000).toISOString();
    const r = runStats(engine, { sinceIso: later });
    expect(r.gate.decisions).toBe(0);
    expect(r.tickets.opened).toBe(0);
  });

  it("formatStats renders one line per section, honest empties", () => {
    const lines = formatStats(runStats(engine)).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("0 decisions (—)");
    expect(lines[4]).toContain("clock: off");
  });
});
