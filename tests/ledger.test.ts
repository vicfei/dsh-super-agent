// The evidence ledger (v1.5, issue #119) — append-only, hash-chained. Verify must catch
// any post-hoc edit; the chain must cover every transition kind the engine performs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  table: [{ scope: "issue", listedNotAddressing: "inferred", unlistedAddressing: "ignore", unlistedNotAddressing: "ignore" }],
};

const trigger: Trigger = {
  id: "github:issue:1", source: "github", scope: "issue", threadId: "github:o/r/issues/5",
  author: { login: "alice", isBot: false }, addressing: true, body: "do it", ts: "2026-11-10T00:00:00Z",
};

function accept() {
  return { trigger, gate: { strength: "explicit" as const, row: policy.table[0] }, resolution: { action: "accept" as const, basis: "explicit" } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-ledger-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("chain integrity", () => {
  it("a full lifecycle verifies; events read back in order with cursors", () => {
    engine.ingest([accept()], { github: { positions: { issue: 1 } } });
    const aid = engine.startAssignment(1, "/tmp/w");
    engine.endAssignment(aid, 0, false, "done");
    engine.completeTicket(1);
    const v = engine.ledger.verify();
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.count).toBeGreaterThanOrEqual(6); // policy + decision + opened + started + ended + ticket.ended
    const kinds = engine.ledger.eventsAfter(0, 100).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["policy.version", "decision.recorded", "ticket.opened", "assignment.started", "assignment.ended", "ticket.ended"]));
    // cursor semantics: everything after the policy event
    const afterFirst = engine.ledger.eventsAfter(1, 100);
    expect(afterFirst.every((e) => e.id > 1)).toBe(true);
    expect(afterFirst.length).toBe(kinds.length - 1);
  });

  it("verify catches an edited payload (tamper evidence)", () => {
    engine.ingest([accept()], { github: { positions: { issue: 1 } } });
    expect(engine.ledger.verify().ok).toBe(true);
    engine.db.prepare("UPDATE event_log SET payload = '{\"forged\":true}' WHERE id = 2").run();
    const v = engine.ledger.verify();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.firstBadId).toBeGreaterThanOrEqual(2);
  });

  it("verify catches a spliced chain (prev_hash rewritten)", () => {
    engine.ingest([accept()], { github: { positions: { issue: 1 } } });
    engine.db.prepare("UPDATE event_log SET prev_hash = ? WHERE id = 3").run("f".repeat(64));
    const v = engine.ledger.verify();
    expect(v.ok).toBe(false);
  });

  it("a truncated tail is caught by the head anchor (slice B)", () => {
    engine.ingest([accept()], { github: { positions: { issue: 1 } } });
    engine.db.prepare("DELETE FROM event_log WHERE id = (SELECT MAX(id) FROM event_log)").run();
    // hashing alone cannot see a missing TAIL (a shorter valid chain remains) — the kv
    // head anchor is ahead of the last row and verify fails.
    const v = engine.ledger.verify();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("truncated");
  });
});

describe("transition coverage", () => {
  it("approval render, stop, requeue, promote, effects and memory all land in the ledger", () => {
    engine.ingest([accept()], { github: { positions: { issue: 1 } } }); // ticket #1 exists (memory FK)
    engine.openApprovalRequest("wechat:peer/x", 1, "needs-person");
    engine.requeueTicket(1);
    engine.stopTicket(1, "alice");
    engine.promoteTicket(1, "alice"); // not speculative → no-op, must NOT emit
    engine.enqueueReply("k-1", "github:o/r/issues/5", "hello");
    const fx = engine.db.prepare("SELECT id FROM effect WHERE key = 'k-1'").get() as { id: number };
    engine.completeEffect(fx.id);
    engine.recordMemories({ repo: "o/r", ticketId: 1, bodies: ["fact"], autoAccept: false, maxAccepted: 8 });
    const kinds = engine.ledger.eventsAfter(0, 100).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      "approval.rendered", "ticket.requeued", "ticket.stopped", "effect.enqueued", "effect.delivered", "memory.recorded",
    ]));
    expect(kinds).not.toContain("ticket.promoted"); // the no-op promote emitted nothing
  });
});
