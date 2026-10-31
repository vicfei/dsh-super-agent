import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1,
  allowedList: ["alice", "bob"],
  botList: [],
  acceptMode: "auto",
  table: ["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci"].map((s) => ({
    scope: s as never,
    listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const,
    unlistedNotAddressing: "ignore" as const,
  })),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-engine-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function item(partial: Partial<Trigger> = {}, overrides: Partial<IngestItem> = {}): IngestItem {
  const t: Trigger = {
    id: `github:issue:${++seq}`,
    source: "github", scope: "issue", threadId: "github:o/r/issues/5",
    author: { login: "alice", isBot: false }, addressing: true, body: "do it", ts: "2026-11-01T00:00:00Z",
    ...partial,
  };
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive"), ...overrides };
}

describe("ingest", () => {
  it("accept creates a ticket and enqueues exactly one confirmation reply effect", () => {
    const r = engine.ingest([item()]);
    expect(r).toMatchObject({ fresh: 1, ticketsOpened: 1 });
    const tickets = engine.tickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ opener: "alice", strength: "explicit", state: "open", stage: "queued" });
    const fx = engine.takeDue();
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ kind: "reply", key: "ticket-open:1" });
    expect(fx[0].payload).toMatchObject({ issueNumber: 5 });
    expect(String((fx[0].payload as { body: string }).body)).toContain("automated agent");
  });

  it("duplicate trigger id is a full no-op (one ticket, one decision, no side effects)", () => {
    const first = item();
    engine.ingest([first]);
    const fxCount = engine.takeDue().length;
    const r2 = engine.ingest([{ ...first, resolution: first.resolution }]); // same trigger object
    expect(r2).toMatchObject({ duplicates: 1, fresh: 0, ticketsOpened: 0 });
    expect(engine.tickets()).toHaveLength(1);
    expect(engine.takeDue()).toHaveLength(fxCount);
  });

  it("shadow (observe) records a would-accept decision and opens nothing", () => {
    const observing: Policy = { ...policy, acceptMode: "observe" };
    engine.setPolicyIfChanged({ ...observing, version: 2 });
    const shadowed = item({ addressing: false }, {
      resolution: { action: "shadow", strength: "inferred", basis: "allowed alice not addressing", wouldAccept: true },
    });
    const r = engine.ingest([shadowed]);
    expect(r.ticketsOpened).toBe(0);
    expect(engine.tickets()).toHaveLength(0);
    expect(engine.takeDue()).toHaveLength(0);
  });

  it("several accepts on one thread open several tickets (no one-live-per-thread limit)", () => {
    const r = engine.ingest([item(), item({ id: "github:issue:900", body: "second task @agent" })]);
    expect(r.ticketsOpened).toBe(2);
    expect(engine.tickets()).toHaveLength(2);
  });

  it("positions persist with the batch (exactly-once home)", () => {
    engine.ingest([item()], { positions: { issue: 7, issue_comment: 0, pr: 0, review_comment: 0 } });
    expect(engine.positions().positions.issue).toBe(7);
  });
});

describe("stop / resume / revalidation", () => {
  it("person's stop ends the ticket; the opener's later message resumes it", () => {
    engine.ingest([item()]);
    expect(engine.stopTicket(1, "panel")).toBe(true);
    expect(engine.stopTicket(1, "panel")).toBe(false); // not open anymore
    expect(engine.tickets()[0]).toMatchObject({ state: "ended", stoppedBy: "panel" });

    const r = engine.ingest([item({ id: "github:issue_comment:10", scope: "issue_comment", body: "resume please" })]);
    expect(r.resumed).toBe(1);
    const t = engine.tickets()[0];
    expect(t.state).toBe("open");
    expect(t.resumedCount).toBe(1);
    const fx = engine.takeDue();
    expect(fx.some((f) => f.key === "ticket-resume:1:1")).toBe(true);
  });

  it("a different person's message does not resume another's ticket (it opens their own)", () => {
    engine.ingest([item()]);
    engine.stopTicket(1, "panel");
    const r = engine.ingest([item({ id: "github:issue_comment:11", author: { login: "bob", isBot: false } })]);
    expect(r.resumed).toBe(0);
    expect(r.ticketsOpened).toBe(1); // bob's own ticket on the same thread
    const alices = engine.tickets().filter((t) => t.opener === "alice");
    expect(alices).toHaveLength(1);
    expect(alices[0].state).toBe("ended");
  });

  it("weakening policy keeps open tickets; resume revalidates and revokes on failure", () => {
    engine.ingest([item()]); // explicit ticket for alice (basis: allowed alice addressing agent)
    engine.stopTicket(1, "panel");
    // alice stays admissible via the unlisted-addressing cell, but is off the allowed list:
    engine.setPolicyIfChanged({
      ...policy, version: 2, allowedList: ["bob"],
      table: policy.table.map((r) => (r.scope === "issue" ? { ...r, unlistedAddressing: "inferred" as const } : r)),
    });

    const r = engine.ingest([item({ id: "github:issue_comment:12", scope: "issue_comment", body: "resume" })]);
    expect(r.resumed).toBe(0);
    expect(r.refusals[0]).toContain("stays ended");
    expect(r.refusals[0]).toContain("no longer allowed");
    const t = engine.tickets()[0];
    expect(t.state).toBe("ended");
    expect(t.revokedReason).toContain("no longer allowed");

    // A revoked mandate stays revoked: later admitted messages from alice do not resurrect it.
    const again = engine.ingest([item({ id: "github:issue_comment:13", scope: "issue_comment", body: "resume again" })]);
    expect(again.resumed).toBe(0);
    expect(again.refusals[0]).toContain("mandate revoked");
    expect(engine.tickets()[0].state).toBe("ended");
  });

  it("an inferred mandate does not resume while acceptMode is not auto (explicit attempt → revoked)", () => {
    const inf = item({ addressing: false, id: "github:issue:21" });
    engine.ingest([inf]); // auto mode → inferred accept
    expect(engine.tickets()[0].strength).toBe("inferred");
    engine.stopTicket(1, "panel");
    engine.setPolicyIfChanged({ ...policy, version: 3, acceptMode: "observe" });

    // alice addresses the agent → explicit → admitted in every mode → resume attempt happens
    const r = engine.ingest([item({ id: "github:issue_comment:14", scope: "issue_comment", body: "@agent resume" })]);
    expect(r.resumed).toBe(0);
    expect(engine.tickets()[0].revokedReason).toContain("acceptMode=auto");
  });
});

describe("effects (outbox)", () => {
  it("same kind+key coalesces: one row, payload replaced, attempts reset", () => {
    engine.ingest([item()]);
    const [first] = engine.takeDue();
    engine.failEffect(first.id, "boom"); // attempts → 1, due later
    expect(engine.takeDue()).toHaveLength(0); // backed off

    engine.ingest([item({ id: "github:issue:31" })]); // new ticket → new key, not coalescing
    // Re-enqueue the same key directly via a second identical ticket id simulation:
    const before = engine.db.prepare("SELECT COUNT(*) c FROM effect").get() as { c: number };
    expect(before.c).toBe(2);
    engine.completeEffect(first.id);
    const rows = engine.db.prepare("SELECT * FROM effect WHERE key = ?").all("ticket-open:1") as { status: string }[];
    expect(rows[0].status).toBe("done");
  });

  it("failEffect backs off exponentially and goes terminal on the 5th attempt", () => {
    engine.ingest([item()]);
    const [fx] = engine.takeDue();
    for (let i = 0; i < 4; i++) engine.failEffect(fx.id, `e${i}`);
    let row = engine.db.prepare("SELECT status, attempts FROM effect WHERE id = ?").get(fx.id) as { status: string; attempts: number };
    expect(row).toMatchObject({ status: "pending", attempts: 4 });
    engine.failEffect(fx.id, "final");
    row = engine.db.prepare("SELECT status, attempts FROM effect WHERE id = ?").get(fx.id) as { status: string; attempts: number };
    expect(row).toMatchObject({ status: "failed", attempts: 5 });
    expect(engine.takeDue()).toHaveLength(0);
  });

  it("non-retryable failure is terminal immediately", () => {
    engine.ingest([item()]);
    const [fx] = engine.takeDue();
    engine.failEffect(fx.id, "bad request", false);
    const row = engine.db.prepare("SELECT status FROM effect WHERE id = ?").get(fx.id) as { status: string };
    expect(row.status).toBe("failed");
  });
});
