// IM approval surface (v1.1, issue #76; design: docs/designs/im-approval-surface.md).
// Digit routing downstream of admission, newest-wins requests, double-key stop, expiry,
// requeue/promote semantics — with receipts for every outcome.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import type { ReplyChannel } from "../src/source.js";
import { interceptApprovalCommands } from "../src/approval.js";
import { drainReplyEffects } from "../src/work.js";
import { applyApproval, interceptApprovalCommands, isApprovalDigit, runApprovalSweep } from "../src/approval.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "observe",
  approval: { enabled: true },
  table: ["issue", "im_dm"].map((s) => ({
    scope: s as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
};

function imItem(n: number, body: string, login = "alice", thread = "wechat:peer/wxid_alice"): Trigger {
  return {
    id: `wechat:msg/${n}`, source: "wechat", scope: "im_dm", threadId: thread,
    author: { login, isBot: false }, addressing: true, body, ts: "2026-11-04T00:00:00Z",
  };
}

function accept(t: Trigger): IngestItem {
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-appr-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function channel(): ReplyChannel & { sent: string[] } {
  const sent: string[] = [];
  return { matches: (t) => t.startsWith("wechat:"), deliver: async (_t, b) => { sent.push(b); return { externalId: `m${sent.length}` }; }, sent };
}

/** The canonical setup: alice DMs the bot (ops thread registers), a ticket fails to needs-person. */
async function setupNeedsPerson(): Promise<number> {
  engine.ingest([accept(imItem(1, "fix the timeout bug"))]);
  const aid = engine.startAssignment(1, "");
  engine.endAssignment(aid, 1, false, "boom");
  await drain(channel()); // flush the ticket-open reply so assertions see only approval traffic
  return 1;
}

describe("ops threads + digit shape", () => {
  it("an allowed member's IM DM registers their ops thread at ingest (identity, not admission)", () => {
    engine.ingest([accept(imItem(1, "hello"))]);
    expect(engine.opsThreadLogin("wechat:peer/wxid_alice")).toBe("alice");
    expect(engine.firstOpsThread()).toBe("wechat:peer/wxid_alice");
    expect(isApprovalDigit("1")).toBe(1);
    expect(isApprovalDigit(" 2 ")).toBe(2);
    expect(isApprovalDigit("1.")).toBeNull();
    expect(isApprovalDigit("ok 1")).toBeNull();
    expect(isApprovalDigit("12")).toBeNull();
  });
});

describe("runApprovalSweep rendering", () => {
  it("needs-person renders one request into the opener's ops thread; a second sweep stays quiet", async () => {
    await setupNeedsPerson();
    const ch = channel();
    expect(await runApprovalSweep(engine, policy, [ch])).toBe(1);
    expect(ch.sent[0]).toContain("[approval needed] Ticket #1");
    expect(ch.sent[0]).toContain("1 requeue (run again) · 2 stop · 3 detail");
    expect(await runApprovalSweep(engine, policy, [ch])).toBe(0);
    expect(engine.pendingApprovals()).toHaveLength(1);
  });

  it("several eligible tickets at once: newest-wins supersedes the REQUEST rows, but no render storm (live finding 2026-11-06)", async () => {
    engine.ingest([accept(imItem(1, "job one")), accept(imItem(2, "job two", "alice", "wechat:peer/wxid_second"))]);
    engine.db.prepare("UPDATE ticket SET state = 'ended', speculative = 1").run();
    const ch = channel();
    const first = await runApprovalSweep(engine, policy, [ch]);
    expect(first).toBe(2); // both rendered once, this sweep
    const second = await runApprovalSweep(engine, policy, [ch]);
    expect(second).toBe(0); // …and never again — even though openApprovalRequest superseded the older row
    const keys = (engine.db.prepare("SELECT key FROM effect WHERE key LIKE 'approval-req:%' ORDER BY id").all() as { key: string }[]).map((r) => r.key).sort();
    expect(keys).toEqual(["approval-req:1:0", "approval-req:2:0"]); // exactly one ask per ticket (no assignment yet → :0)
  });

  it("a requeued ticket that fails again re-renders its ask — new assignment, new key (#114)", async () => {
    await setupNeedsPerson();
    const ch = channel();
    expect(await runApprovalSweep(engine, policy, [ch])).toBe(1);
    expect(await runApprovalSweep(engine, policy, [ch])).toBe(0); // same assignment: the storm guard holds
    engine.requeueTicket(1);
    const aid2 = engine.startAssignment(1, "");
    engine.endAssignment(aid2, 1, false, "boom again");
    await drain(ch);
    // the live bug: this stayed 0 forever and the owner's digit got "Nothing pending"
    expect(await runApprovalSweep(engine, policy, [ch])).toBe(1);
  });

  it("a speculative promote renders even after an earlier needs-person ask on the same ticket (#114)", async () => {
    await setupNeedsPerson();
    const ch = channel();
    await runApprovalSweep(engine, policy, [ch]); // 🔑 rendered for assignment 1
    engine.requeueTicket(1);
    const aid2 = engine.startAssignment(1, "");
    engine.endAssignment(aid2, 0, false, "done");
    engine.db.prepare("UPDATE ticket SET speculative = 1 WHERE id = 1").run();
    engine.completeTicket(1);
    await drain(ch);
    const rendered = await runApprovalSweep(engine, policy, [ch]);
    expect(rendered).toBe(1); // 🧪 for assignment 2 — was suppressed by the old ticket-only key
    expect(ch.sent.some((b) => b.includes("rehearsal ready"))).toBe(true);
  });

  it("a terminally failed ask is not re-rendered either — the outbox owned the retries", async () => {
    await setupNeedsPerson();
    const ch = channel();
    await runApprovalSweep(engine, policy, [ch]); // rendered + drained (delivered in the test channel)
    const fx = engine.db.prepare("SELECT id FROM effect WHERE key = 'approval-req:1:1'").get() as { id: number };
    engine.failEffect(fx.id, "ret=-2", false); // terminal — delivery gave up
    expect(await runApprovalSweep(engine, policy, [ch])).toBe(0);
  });
});

describe("digit routing (interceptApprovalCommands)", () => {
  it("a digit from the ops-thread owner is intercepted; other traffic passes through", async () => {
    await setupNeedsPerson();
    await runApprovalSweep(engine, policy, [channel()]);

    const { rest, applied } = interceptApprovalCommands(
      [imItem(2, "1"), imItem(3, "please also do Y", "alice"), imItem(4, "1", "alice", "wechat:group/g9"), imItem(5, "1", "bob", "wechat:peer/wxid_bob")],
      engine, policy,
    );
    expect(applied).toEqual(["requeue:1"]);
    expect(rest.map((t) => t.id)).toEqual(["wechat:msg/3", "wechat:msg/4", "wechat:msg/5"]); // real text, group digit, stranger digit
  });

  it("approve requeues a failed ticket — claimable again with its context", async () => {
    await setupNeedsPerson();
    expect(engine.claimQueued(5)).toHaveLength(0); // failed assignment blocks
    await runApprovalSweep(engine, policy, [channel()]);
    const ch = channel();
    await drain(ch);
    expect(applyApproval(engine, "wechat:peer/wxid_alice", 1)).toBe("requeue:1");
    const claimed = engine.claimQueued(5);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].body).toContain("fix the timeout bug");
    await drain(ch);
    expect(ch.sent.some((b) => b.includes("requeued"))).toBe(true); // receipt
  });

  it("stop requires the double-key: first 2 arms, second 2 within 5 minutes stops", async () => {
    await setupNeedsPerson();
    await runApprovalSweep(engine, policy, [channel()]);
    const now = new Date("2026-11-04T01:00:00Z");
    expect(applyApproval(engine, "wechat:peer/wxid_alice", 2, now)).toBe("confirm:1");
    expect(engine.tickets()[0].state).toBe("open"); // untouched
    expect(applyApproval(engine, "wechat:peer/wxid_alice", 2, new Date(now.getTime() + 2 * 60_000))).toBe("stop:1");
    expect(engine.tickets()[0].state).toBe("ended");
  });

  it("detail re-sends; expiry declines and the request resolves", async () => {
    await setupNeedsPerson();
    await runApprovalSweep(engine, policy, [channel()]);
    const t0 = new Date("2026-11-04T01:00:00Z");
    const created = new Date(); // the sweep just created it — 61 minutes later it is expired
    const later = new Date(created.getTime() + 61 * 60_000);
    expect(applyApproval(engine, "wechat:peer/wxid_alice", 3, t0)).toBe("detail:1");
    expect(applyApproval(engine, "wechat:peer/wxid_alice", 1, later)).toBe("expired:1");
    expect(engine.pendingApprovals()).toHaveLength(0);
  });

  it("a digit with nothing pending politely declines — never guesses", () => {
    expect(applyApproval(engine, "wechat:peer/wxid_alice", 1)).toBe("nothing-pending");
  });

  it("speculative rehearsal routes promote through the deliver gate", async () => {
    // shadow → speculative ticket (speculation on), run silently to ended
    engine.setPolicyIfChanged({ ...policy, version: 2, acceptMode: "observe", speculation: { enabled: true } });
    const t = imItem(10, "maybe fix this");
    const gate = evaluateGate(policy, t);
    engine.ingest([{ trigger: t, gate, resolution: { action: "shadow", strength: "inferred", basis: "allowed alice", wouldAccept: true } }]);
    expect(engine.tickets()[0].speculative).toBe(true);
    engine.startAssignment(1, "");
    engine.endAssignment(1, 0, false, "rehearsed");
    engine.completeTicket(1);

    const ch = channel();
    expect(await runApprovalSweep(engine, { ...policy, speculation: { enabled: true } }, [ch])).toBe(1);
    expect(ch.sent[0]).toContain("[rehearsal ready]");
    expect(engine.promotedPendingDelivery()).toHaveLength(0);
    expect(applyApproval(engine, "wechat:peer/wxid_alice", 1)).toBe("promote:1");
    expect(engine.promotedPendingDelivery()).toHaveLength(1); // the promote sweep will deliver
  });
});

async function drain(ch: ReplyChannel): Promise<void> {
  const { drainReplyEffects } = await import("../src/work.js");
  await drainReplyEffects(engine, [ch]);
}

describe("ops status command: ? in the ops thread (v1.3)", () => {
  it("the owner's ? gets the whole picture back — pending decisions, stages, backlog, the clock", async () => {
    await setupNeedsPerson(); // ticket 1 in needs-person
    engine.openApprovalRequest("wechat:peer/wxid_alice", 1, "needs-person"); // …and asked (as the sweep would)
    engine.setPolicyIfChanged({
      ...policy,
      version: 2,
      routines: { enabled: true, definitions: [{ id: "digest", prompt: "p", schedule: { cron: "0 8 * * 1-5", tz: "UTC" }, reportTo: "wechat:peer/wxid_alice" }] },
    });
    const { rest, applied } = interceptApprovalCommands([imItem(9, "?")], engine, engine.policy()!);
    expect(rest).toHaveLength(0); // consumed — a weak-intent ? must never become a ticket
    expect(applied[0]).toContain("status-card");
    const ch = channel();
    await drain(ch);
    const card = ch.sent[0];
    expect(card).toContain("📊 dsh status — acceptMode observe");
    expect(card).toContain("awaiting you: 1");
    expect(card).toContain("needs-person 1");
    expect(card).toContain("⏰ digest:");
  });

  it("fullwidth ？ works for Chinese keyboards; strangers' and wordy ?s are just chat", async () => {
    engine.ingest([accept(imItem(1, "hello"))]); // register the ops thread
    const a = interceptApprovalCommands([imItem(10, "？")], engine, engine.policy()!);
    expect(a.applied[0]).toContain("status-card");
    const b = interceptApprovalCommands([imItem(11, "? now"), imItem(12, "?", "bob", "wechat:peer/wxid_bob")], engine, engine.policy()!);
    expect(b.rest).toHaveLength(2); // not commands — they flow through the gate like any message
  });
});
