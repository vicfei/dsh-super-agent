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
});
