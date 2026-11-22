// Milestone gates (v1.11, #173): a long task pauses for a person at milestone boundaries.
// The checklist is a progress report (one-way); `1` releases the segment; evidence on the ledger.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";
import { applyApproval, runApprovalSweep } from "../src/approval.js";
import { parseMilestones } from "../src/milestones.js";

let dir: string;
let engine: Engine;
let seq = 0;
const THREAD = "github:o/r/issues/5";

const policyOf = (over: Partial<Policy> = {}): Policy => ({
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  approval: { enabled: true }, milestones: { enabled: true }, ...over,
  table: ["issue"].map((s) => ({
    scope: s as never, listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
});
let policy = policyOf();

function acceptItem(): IngestItem {
  const t: Trigger = {
    id: `github:issue:${++seq}`, source: "github", scope: "issue", threadId: THREAD,
    author: { login: "alice", isBot: false }, addressing: true, body: `task ${seq}`, ts: "2026-11-21T00:00:00Z",
  };
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-milestone-"));
  engine = new Engine(join(dir, "engine.db"));
  policy = policyOf();
  engine.setPolicyIfChanged(policy);
  engine.registerOpsThread("alice", THREAD);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function gitRepo(): string {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main .", { cwd: repo });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repo });
  return repo;
}
function cfg(command: string): ExecutorConfig {
  return { command, repoDir: gitRepo(), workRoot: join(dir, "work"), timeoutMs: 30_000, maxWorkers: 1, blockedCommands: [] };
}
/** A worker that writes the given checklist lines, then succeeds. */
const worker = (lines: string[], fail = false) =>
  cfg(`mkdir -p .dsh && printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")} > "$DSH_MILESTONES_FILE" && echo worked${fail ? "; exit 3" : ""}`);

const replies = () => engine.takeDue().map((f) => (f.payload as { body: string }).body);
/** A channel that captures what the sweep delivers. */
const capture = (into: string[]) => [{ matches: () => true, deliver: async (_t: string, body: string) => { into.push(body); return { externalId: "cap" }; } }];
const ledgerRows = (kind: string) => engine.ledger.eventsAfter(0, 500).filter((e) => e.kind === kind);

describe("parseMilestones", () => {
  it("reads checkbox items in order; headers and bare lines are ignored", () => {
    const s = parseMilestones("# Plan\n\n- [x] schema migration\n* [ ] API endpoints\n  - [X] seed data\nsome prose\n- not a checkbox");
    expect(s.done).toEqual(["schema migration", "seed data"]);
    expect(s.pending).toEqual(["API endpoints"]);
  });
});

describe("milestone gates through runWork + the approval surface", () => {
  it("a finished run with pending items holds the ticket; the sweep asks; `1` releases the segment", async () => {
    engine.ingest([acceptItem()]);
    const reports = await runWork(engine, new Executor(worker(["- [x] schema", "- [ ] tests", "- [ ] docs"])), "o/r", null);
    expect(reports[0].detail).toMatch(/milestone 1\/3 — awaiting approval/);
    const t = engine.tickets()[0];
    expect(t.state).toBe("open"); // not completed — a person decides whether the next segment runs
    expect(t.stage).toBe("needs-person");
    expect(engine.milestoneHold(1)).toMatchObject({ done: ["schema"], pending: ["tests", "docs"] });
    expect(engine.claimQueued(5)).toHaveLength(0); // held: not claimable until approved
    expect(ledgerRows("ticket.milestone-held")).toHaveLength(1);
    expect(ledgerRows("ticket.milestones")[0].payload).toMatchObject({ done: 1, pending: 2, next: "tests" });

    // the approval sweep renders the milestone ask (kind "milestone"), not a failure notice
    const delivered: string[] = [];
    expect(await runApprovalSweep(engine, policy, capture(delivered))).toBe(1);
    expect(engine.pendingApprovals()[0]).toMatchObject({ ticketId: 1, kind: "milestone", opsThread: THREAD });
    const ask = delivered.find((b) => b.includes("[milestone]"));
    expect(ask).toContain("reached 1/3");
    expect(ask).toContain("Next: tests");

    // digit 1: the segment is approved — hold released, pending items become the next run's guidance
    expect(applyApproval(engine, THREAD)).toBe("milestone-approved:1");
    expect(engine.milestoneHold(1)).toBeNull();
    expect(engine.claimQueued(5)).toHaveLength(1);
    expect(replies().some((b) => b.includes("approved to continue"))).toBe(true);

    // the next run finishes the rest → the ticket completes normally
    const second = await runWork(engine, new Executor(worker(["- [x] schema", "- [x] tests", "- [x] docs"])), "o/r", null);
    expect(second[0]).toMatchObject({ outcome: "done", detail: "exit 0" });
    expect(engine.tickets()[0].state).toBe("ended");
    expect(engine.milestoneHold(1)).toBeNull();
  });

  it("`3` lists progress; `2` stops with the double-key", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(worker(["- [x] a", "- [ ] b"])), "o/r", null);
    await runApprovalSweep(engine, policy, capture([]));
    expect(applyApproval(engine, THREAD, 3)).toBe("detail:1");
    expect(replies().some((b) => b.includes("Milestones: 1 done · 1 pending; next: b"))).toBe(true);
    expect(applyApproval(engine, THREAD, 2)).toBe("confirm:1"); // armed, nothing stopped yet
    expect(engine.tickets()[0].state).toBe("open");
    expect(applyApproval(engine, THREAD, 2)).toBe("stop:1");
    expect(engine.tickets()[0].state).toBe("ended");
  });

  it("all items done → evidence recorded, the ticket completes, no hold", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(worker(["- [x] schema", "- [x] tests"])), "o/r", null);
    expect(engine.tickets()[0].state).toBe("ended");
    expect(engine.milestoneHold(1)).toBeNull();
    expect(ledgerRows("ticket.milestones")[0].payload).toMatchObject({ done: 2, pending: 0 });
    expect(ledgerRows("ticket.milestone-held")).toHaveLength(0);
  });

  it("gates off → the checklist is ignored and the ticket completes", async () => {
    engine.setPolicyIfChanged(policyOf({ version: 2, milestones: { enabled: false } }));
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(worker(["- [x] a", "- [ ] b"])), "o/r", null);
    expect(engine.tickets()[0].state).toBe("ended");
    expect(engine.milestoneHold(1)).toBeNull();
  });

  it("approval surface off → the gate is inert (never a stranded ticket)", async () => {
    engine.setPolicyIfChanged(policyOf({ version: 2, approval: { enabled: false } }));
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(worker(["- [x] a", "- [ ] b"])), "o/r", null);
    expect(engine.tickets()[0].state).toBe("ended");
    expect(engine.milestoneHold(1)).toBeNull();
  });

  it("a failed run takes the ordinary failure path — no milestone hold", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(worker(["- [ ] b"], true)), "o/r", null);
    expect(engine.tickets()[0].stage).toBe("needs-person"); // by failure, not by gate
    expect(engine.milestoneHold(1)).toBeNull();
    expect(ledgerRows("ticket.milestone-held")).toHaveLength(0);
  });

  it("no checklist → nothing recorded, the ticket completes", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg("echo plain")), "o/r", null);
    expect(engine.tickets()[0].state).toBe("ended");
    expect(ledgerRows("ticket.milestones")).toHaveLength(0);
  });
});
