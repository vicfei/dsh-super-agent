import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { startPanel } from "../src/panel.js";
import type { Server } from "node:http";

let dir: string;
let engine: Engine;
let server: Server;
let base: string;

const policy: Policy = {
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "observe",
  table: ["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci"].map((s) => ({
    scope: s as never,
    listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const,
    unlistedNotAddressing: "ignore" as const,
  })),
};

function item(id: string, partial: Partial<Trigger> = {}) {
  const t: Trigger = {
    id, source: "github", scope: "issue", threadId: "github:o/r/issues/5",
    author: { login: "alice", isBot: false }, addressing: true, body: "fix the bug", ts: "2026-11-03T00:00:00Z",
    ...partial,
  };
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dsh-panel-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
  server = await startPanel(engine, 0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("panel HTTP API", () => {
  it("serves the single page with the motto and permission banner", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("healthy state takes no space");
    expect(html).toContain("Messages cannot change permissions");
    expect(html).toContain("By person"); // M6-3 per-person section
  });

  it("state exposes policy, tickets, decisions with trigger context", async () => {
    engine.ingest([item("github:issue:1")]);
    const s = (await (await fetch(`${base}/api/state`)).json()) as {
      policy: Policy; tickets: { id: number }[]; decisions: { author: string; excerpt: string }[];
      deliveries: unknown[];
    };
    expect(s.policy.acceptMode).toBe("observe");
    expect(s.tickets).toHaveLength(1);
    expect(s.decisions[0]).toMatchObject({ author: "alice", excerpt: "fix the bug" });
    expect(s.deliveries).toEqual([]);
  });

  it("state lists deliveries — an open PR is a thing awaiting a human", async () => {
    engine.recordDelivery({ repo: "o/r", prNumber: 42, ticketId: 1, threadId: "github:o/r/issues/5", branch: "dsh/ticket-1", headSha: "a" });
    const s = (await (await fetch(`${base}/api/state`)).json()) as { deliveries: { prNumber: number; state: string }[] };
    expect(s.deliveries[0]).toMatchObject({ prNumber: 42, state: "open" });
  });

  it("mode switch is versioned; invalid modes rejected; unknown paths 404", async () => {
    const ok = await fetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "auto" }) });
    const after = (await ok.json()) as { policy: Policy };
    expect(after.policy.acceptMode).toBe("auto");
    expect(after.policy.version).toBe(2);

    const bad = await fetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "yolo" }) });
    expect(bad.status).toBe(400);

    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("stop ends an open ticket via the panel (a person's command acting directly)", async () => {
    engine.ingest([item("github:issue:2")]);
    const stop = await fetch(`${base}/api/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1 }) });
    expect(await stop.json()).toMatchObject({ stopped: true });
    expect(engine.tickets()[0].state).toBe("ended");

    const again = await fetch(`${base}/api/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1 }) });
    expect(again.status).toBe(404);
  });

  it("observe records surface as would-accept decisions", async () => {
    const shadow = item("github:issue:3", { addressing: false });
    const gate = evaluateGate(policy, shadow.trigger);
    shadow.resolution = { action: "shadow", strength: "inferred", basis: "allowed alice not addressing", wouldAccept: true };
    void gate;
    engine.ingest([shadow]);
    const s = (await (await fetch(`${base}/api/state`)).json()) as { decisions: { wouldAccept: boolean; kind: string }[] };
    expect(s.decisions[0]).toMatchObject({ wouldAccept: true, kind: "ignore" });
  });

  it("v1.3: health vitals ride along — stage counts and effect backlog", async () => {
    engine.ingest([item("github:issue:4")]);
    const s = (await (await fetch(`${base}/api/state`)).json()) as {
      health: { tickets: Record<string, number>; pendingEffects: number; failedEffects: number };
    };
    expect(s.health.tickets.queued).toBe(1);
    expect(s.health.pendingEffects).toBeGreaterThan(0);
    expect(s.health.failedEffects).toBe(0);
  });

  it("v1.3: routines render with the next fire from the engine's timer positions", async () => {
    const withRoutines: Policy = {
      ...policy,
      routines: {
        enabled: true,
        definitions: [{ id: "digest", prompt: "summarize", schedule: { cron: "0 8 * * *", tz: "UTC" }, reportTo: "github:o/r/issues/9" }],
      },
    };
    engine.setPolicyIfChanged({ ...withRoutines, version: 2 });
    // a running daemon's state: today's 08:00 slot already honored → next is tomorrow 08:00
    const todayAt8 = new Date();
    todayAt8.setUTCHours(8, 0, 0, 0);
    engine.ingest([], { timer: { positions: { "last:digest": todayAt8.getTime() } } });

    const s = (await (await fetch(`${base}/api/state`)).json()) as {
      routines: { enabled: boolean; items: { id: string; schedule: string; next: string; overdue: boolean; reportTo: string }[] };
    };
    expect(s.routines.enabled).toBe(true);
    expect(s.routines.items).toHaveLength(1);
    const r = s.routines.items[0];
    expect(r.id).toBe("digest");
    expect(r.schedule).toContain("0 8 * * *");
    expect(r.overdue).toBe(false);
    expect(new Date(r.next).getUTCHours()).toBe(8);
    expect(r.reportTo).toBe("github:o/r/issues/9");
  });

  it("v1.3: the clock off renders honestly (enabled flag false, no definitions fabricated)", async () => {
    const s = (await (await fetch(`${base}/api/state`)).json()) as { routines: { enabled: boolean; items: unknown[] } };
    expect(s.routines.enabled).toBe(false);
    expect(s.routines.items).toEqual([]);
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("the clock is off");
    expect(html).toContain("Routines");
  });

  it("v1.3 slice 2: without doctor context the section is honestly absent", async () => {
    const s = (await (await fetch(`${base}/api/state`)).json()) as { doctor: unknown };
    expect(s.doctor).toBeNull();
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("Doctor"); // the section exists, renders the not-wired note
  });

  it("v1.3 slice 2: with doctor context the checks ride along, offline, exit semantics intact", async () => {
    await new Promise((r) => server.close(r));
    server = await startPanel(engine, 0, "127.0.0.1", {
      executor: { command: "definitely-not-on-path-xyz run" },
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const s = (await (await fetch(`${base}/api/state`)).json()) as {
      doctor: { checks: { id: string; status: string; line: string }[]; warnings: number; failures: number; exitCode: number };
    };
    expect(s.doctor).not.toBeNull();
    const byId = Object.fromEntries(s.doctor.checks.map((c) => [c.id, c]));
    expect(byId.node.status).toBe("ok");
    expect(byId["agent-cli"].status).toBe("warn"); // the bin is deliberately not on PATH
    expect(byId["agent-cli"].line).toContain("definitely-not-on-path-xyz");
    expect(s.doctor.failures).toBe(0);
    expect(s.doctor.warnings).toBeGreaterThanOrEqual(1);
    expect(s.doctor.exitCode).toBe(1); // warnings only — CI truth preserved
    // the second poll within the cache window answers without re-probing (same shape)
    const again = (await (await fetch(`${base}/api/state`)).json()) as { doctor: { checks: unknown[] } };
    expect(again.doctor.checks.length).toBe(s.doctor.checks.length);
  });
});

describe("panel loopback hardening (cross-origin POST)", () => {
  const json = { "content-type": "application/json" };

  it("a browser-origin POST from any other page is refused (loopback is not a CSRF exemption)", async () => {
    engine.ingest([item("github:issue:91")]);
    const evil = await fetch(`${base}/api/mode`, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ mode: "auto" }) });
    expect(evil.status).toBe(403);
    expect(engine.policy()?.acceptMode).toBe("observe"); // unchanged
    const evilStop = await fetch(`${base}/api/stop`, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ id: 1 }) });
    expect(evilStop.status).toBe(403);
    expect(engine.tickets()[0].state).toBe("open");
  });

  it("a no-cors style text/plain POST is refused — simple requests cannot carry the JSON content type", async () => {
    const r = await fetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ mode: "auto" }) });
    expect(r.status).toBe(415);
    expect(engine.policy()?.acceptMode).toBe("observe");
  });

  it("same-origin (no Origin header) JSON posts keep working — and promote is actually routed now", async () => {
    engine.ingest([item("github:issue:92")]);
    // make ticket 1 a speculative rehearsal awaiting promote
    engine.db.prepare("UPDATE ticket SET speculative = 1, state = 'ended' WHERE id = 1").run();
    const r = await fetch(`${base}/api/promote`, { method: "POST", headers: json, body: JSON.stringify({ id: 1 }) });
    expect(r.status).toBe(200); // used to fall through to 404 — the outer POST route never listed /api/promote
    expect(await r.json()).toMatchObject({ promoted: true });
  });
});

describe("v1.3 slice 3: audit depth", () => {
  it("a decision opens to its FULL trigger (no 160-char excerpt) plus the decision itself", async () => {
    const long = "x".repeat(300);
    engine.ingest([item("github:issue:71", { body: long })]);
    const a = (await (await fetch(`${base}/api/audit/trigger?id=github:issue:71`)).json()) as {
      body: string; decision: { kind: string; basis: string }; author: string;
    };
    expect(a.body).toHaveLength(300); // untruncated
    expect(a.decision.kind).toBe("accept");
    expect(a.decision.basis).toContain("allowed alice");
    expect((await (await fetch(`${base}/api/audit/trigger?id=nope`)).json())).toMatchObject({ error: "unknown trigger" });
  });

  it("a ticket opens to its run history, follow-ups, and the approval state machine", async () => {
    engine.ingest([item("github:issue:72")]);
    const aid = engine.startAssignment(1, "");
    engine.endAssignment(aid, 3, false, "line1\nFAILTEST seen — exiting 3");
    engine.ingest([item("github:issue_comment:72", { scope: "issue_comment" as const, body: "the follow-up context" })]); // joins
    engine.openApprovalRequest("github:o/r/issues/5", 1, "needs-person");
    engine.armDestructiveConfirm(1);
    engine.resolveApproval(1);
    const a = (await (await fetch(`${base}/api/audit/ticket?id=1`)).json()) as {
      ticket: { id: number }; assignments: { exitCode: number; tail: string }[];
      followups: { body: string }[]; requests: { confirmAt: string | null; resolvedAt: string | null }[];
    };
    expect(a.ticket.id).toBe(1);
    expect(a.assignments[0].exitCode).toBe(3);
    expect(a.assignments[0].tail).toContain("FAILTEST");
    expect(a.followups[0].body).toContain("follow-up context");
    expect(a.requests[0].confirmAt).not.toBeNull(); // the double-key is part of the trail
    expect(a.requests[0].resolvedAt).not.toBeNull();
  });

  it("the approval surface history lists the state machine across tickets", async () => {
    const rows = (await (await fetch(`${base}/api/audit/approvals`)).json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
  });
});
