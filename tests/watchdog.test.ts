// Watchdog (v0.9-1, issue #58) — observes and nudges, never admits: stuck-running assignments
// get one idempotent nudge (an LLM consult can skip it — fail-closed to the rule), stale
// needs-person tickets get one reminder, disabled is a complete no-op, and health is read-only.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import type { ReplyChannel } from "../src/source.js";
import { healthReport, runWatchdogSweep } from "../src/watchdog.js";
import { drainReplyEffects } from "../src/work.js";

let dir: string;
let engine: Engine;
let NOW: Date; // captured per test — backdating is relative to it

const policy: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  watchdog: { enabled: true },
  table: ["issue", "im_dm"].map((s) => ({
    scope: s as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
};

function item(n: number, threadId = "github:o/r/issues/5"): IngestItem {
  const t = {
    id: `github:issue:${n}`, source: "github" as const, scope: "issue" as const, threadId,
    author: { login: "alice", isBot: false }, addressing: true, body: "work", ts: "2026-11-04T00:00:00Z",
  };
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-watchdog-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
  NOW = new Date();
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeChannel(): ReplyChannel & { sent: string[] } {
  const sent: string[] = [];
  return { matches: (t) => t.startsWith("github:"), deliver: async (_t, body) => { sent.push(body); return { externalId: `c${sent.length}` }; }, sent };
}

/** Flush ingest-time replies into a throwaway channel so assertions see only watchdog traffic. */
function flush(): Promise<void> {
  return drainReplyEffects(engine, [fakeChannel()]);
}

function backdate(assignmentId: number, msAgo: number): void {
  engine.db.prepare("UPDATE assignment SET started_at = ? WHERE id = ?").run(new Date(NOW.getTime() - msAgo).toISOString(), assignmentId);
}

const MIN = 60_000, HOUR = 3_600_000;

describe("runWatchdogSweep", () => {
  it("stuck-running assignment gets exactly one nudge (idempotent across sweeps)", async () => {
    engine.ingest([item(1)]);
    backdate(engine.startAssignment(1, ""), 45 * MIN);
    await flush();

    const ch = fakeChannel();
    const first = await runWatchdogSweep(engine, policy, [ch], { now: () => NOW });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ action: "nudge" });
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]).toContain("running for 45 minutes");
    expect(ch.sent[0]).toContain("automated agent");

    expect(await runWatchdogSweep(engine, policy, [ch], { now: () => NOW })).toEqual([]); // one nudge ever
    expect(ch.sent).toHaveLength(1);
  });

  it("an LLM consult seeing progress skips the nudge; a consult error falls back to the rule", async () => {
    engine.ingest([item(1)]);
    backdate(engine.startAssignment(1, ""), 45 * MIN);
    await flush();

    const p = { ...policy, watchdog: { enabled: true, consultLlm: true } };
    const ch = fakeChannel();
    const progress = vi.fn(async () => true);
    const lines = await runWatchdogSweep(engine, p, [ch], { now: () => NOW, progress });
    expect(lines[0]).toMatchObject({ action: "skip-progress" });
    expect(ch.sent).toHaveLength(0);
    expect(progress).toHaveBeenCalledOnce();

    // NEW stuck work whose consult throws → rule fires (fail-closed); the earlier skip left
    // no trace, so it re-consults and now nudges too — consulting is per-sweep by design
    engine.ingest([item(2, "github:o/r/issues/6")]);
    backdate(engine.startAssignment(2, ""), 45 * MIN);
    await flush();
    const again = await runWatchdogSweep(engine, p, [ch], { now: () => NOW, progress: async () => { throw new Error("503"); } });
    expect(again.every((l) => l.action === "nudge")).toBe(true);
    expect(again).toHaveLength(2);
    expect(ch.sent).toHaveLength(2);
  });

  it("fresh-running and threshold-young assignments are left alone", async () => {
    engine.ingest([item(1), item(2, "github:o/r/issues/6")]);
    engine.startAssignment(1, ""); // just started
    backdate(engine.startAssignment(2, ""), 10 * MIN); // under the 30-min threshold
    await flush();

    const ch = fakeChannel();
    expect(await runWatchdogSweep(engine, policy, [ch], { now: () => NOW })).toEqual([]);
    expect(ch.sent).toHaveLength(0);
  });

  it("stale needs-person ticket gets exactly one reminder — never a close", async () => {
    engine.ingest([item(1)]);
    const aid = engine.startAssignment(1, "");
    engine.endAssignment(aid, 1, false, "boom"); // failed → needs-person
    engine.db.prepare("UPDATE assignment SET ended_at = ? WHERE id = ?").run(new Date(NOW.getTime() - 25 * HOUR).toISOString(), aid);
    await flush();

    const ch = fakeChannel();
    const first = await runWatchdogSweep(engine, policy, [ch], { now: () => NOW });
    expect(first[0]).toMatchObject({ action: "remind" });
    expect(ch.sent.some((b) => b.includes("only reminder"))).toBe(true);
    expect(await runWatchdogSweep(engine, policy, [ch], { now: () => NOW })).toEqual([]);
    expect(engine.tickets()[0].state).toBe("open"); // never closed by the watchdog
  });

  it("disabled policy is a complete no-op", async () => {
    engine.ingest([item(1)]);
    backdate(engine.startAssignment(1, ""), 5 * HOUR);
    await flush();
    const ch = fakeChannel();
    expect(await runWatchdogSweep(engine, { ...policy, watchdog: undefined }, [ch], { now: () => NOW })).toEqual([]);
    expect(ch.sent).toHaveLength(0);
  });
});

describe("healthReport", () => {
  it("read-only snapshot: stages, ages, effect backlog", () => {
    engine.ingest([item(1)]);
    backdate(engine.startAssignment(1, ""), 45 * MIN);
    const r = healthReport(engine, NOW);
    expect(r.tickets).toMatchObject({ queued: 0, working: 1, "needs-person": 0, ended: 0 });
    expect(r.oldestWorkingMs).toBeGreaterThan(44 * MIN);
    expect(r.oldestNeedsPersonMs).toBeNull();
    expect(r.pendingEffects).toBe(1); // the ticket-open reply
  });
});
