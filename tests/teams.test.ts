// Worker-spawned teams (v2.0 Phase 3, #176): the ENGINE opens gated child tickets; the
// parent waits for the team; a child failure flows into the parent's needs-person; the
// org chart is ledger evidence. Team expansion goes through a gate — that's the twist.

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
import { parseDelegation } from "../src/teams.js";

let dir: string;
let engine: Engine;
let seq = 0;
const THREAD = "github:o/r/issues/5";

const policyOf = (over: Partial<Policy> = {}): Policy => ({
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  teams: { enabled: true, maxChildren: 4 }, ...over,
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
  dir = mkdtempSync(join(tmpdir(), "dsh-teams-"));
  engine = new Engine(join(dir, "engine.db"));
  policy = policyOf();
  engine.setPolicyIfChanged(policy);
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
  return { command, repoDir: gitRepo(), workRoot: join(dir, "work"), timeoutMs: 30_000, maxWorkers: 4, blockedCommands: [] };
}
const DELEGATE = (count: number) =>
  cfg(`mkdir -p .dsh && printf '%s\\n' 'title: sub work' 'reason: independent pieces' 'prompt: do the sub-work for this ticket' 'count: ${count}' > "$DSH_DELEGATE_FILE" && echo parent-worked`);
const PLAIN = () => cfg("echo plain-work");

const ledgerRows = (kind: string) => engine.ledger.eventsAfter(0, 500).filter((e) => e.kind === kind);

describe("parseDelegation", () => {
  it("parses title/reason/prompt(possibly multiline)/count with sane caps", () => {
    const d = parseDelegation("title: T\nreason: R\nprompt: line one\nline two\ncount: 3")!;
    expect(d).toEqual({ title: "T", reason: "R", prompt: "line one\nline two", count: 3 });
    expect(parseDelegation("title: T\nprompt: p")!.count).toBe(1); // default 1
    expect(parseDelegation("title: T\nprompt: p\ncount: 99")!.count).toBe(10); // clamp 10
    expect(parseDelegation("title: T")).toBeNull(); // no prompt → nothing to delegate
  });
});

describe("teams through runWork", () => {
  it("parent run + delegate.md → engine opens parent-linked children; parent waits; last child completes it", async () => {
    engine.ingest([acceptItem()]);
    const reports = await runWork(engine, new Executor(DELEGATE(2)), "o/r", null);
    expect(reports[0].detail).toMatch(/delegated to 2 child ticket\(s\)/);
    const parent = engine.tickets().find((t) => t.id === 1)!;
    expect(parent.stage).toBe("waiting-children");
    expect(parent.state).toBe("open"); // a person sees the team, nothing silently finishes
    expect(engine.pendingChildren(1)).toBe(2);
    expect(ledgerRows("ticket.delegated")).toHaveLength(1);
    const opened = ledgerRows("ticket.opened").filter((e) => (e.payload as { parent?: number }).parent === 1);
    expect(opened).toHaveLength(2);
    // children are claimable and parent-linked, inheriting the parent's thread
    const children = engine.tickets().filter((t) => t.id !== 1);
    expect(children).toHaveLength(2);
    expect(children.every((t) => t.threadId === THREAD)).toBe(true);

    // children run and finish → the parent completes when the LAST one settles
    const r2 = await runWork(engine, new Executor(PLAIN()), "o/r", null); // first child (maxWorkers 4 would take both; runWork drains)
    const r3 = await runWork(engine, new Executor(PLAIN()), "o/r", null);
    expect(r2.concat(r3).every((r) => r.outcome === "done")).toBe(true);
    expect(engine.tickets().filter((t) => t.id !== 1).every((t) => t.state === "ended")).toBe(true);
    expect(engine.tickets().find((t) => t.id === 1)!.state).toBe("ended"); // the parent ends with the team
    expect(ledgerRows("ticket.children-settled")).toHaveLength(1);
  });

  it("a child failure parks the PARENT for a person; the approved requeue releases it", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(DELEGATE(2)), "o/r", null);
    // child 2 fails; children share maxWorkers slots — one runWork call may run both, so
    // park checks: force the failing child deterministically per id
    await runWork(engine, new Executor(cfg(`if [ "$DSH_TICKET" = "2" ]; then echo child-ok; else echo child-fail; exit 3; fi`)), "o/r", null);
    const failing = engine.tickets().filter((t) => t.stage === "needs-person");
    expect(failing.length).toBeGreaterThanOrEqual(1); // the failed child, and/or the parked parent
    expect(ledgerRows("ticket.child-failed")).toHaveLength(1);
    const parent = engine.tickets().find((t) => t.id === 1)!;
    expect(parent.stage).toBe("needs-person"); // the team's failure has one owner
    expect(engine.claimQueued(5)).toHaveLength(0); // parked: not claimable

    // a person approves: the parent's park releases AND the failed child re-arms —
    // the parent stays waiting-children while any child is open (correct semantics),
    // so the recovery is: child settles green → the parent becomes claimable again
    expect(engine.requeueTicket(1)).toBe(true);  // the parent's park releases
    expect(engine.requeueTicket(3)).toBe(true);  // the failed child re-arms
    await runWork(engine, new Executor(PLAIN()), "o/r", null); // the child settles green → parent auto-completes
    expect(engine.tickets().find((t) => t.id === 3)!.state).toBe("ended");
    expect(engine.tickets().find((t) => t.id === 1)!.state).toBe("ended");
    expect(engine.claimQueued(5)).toHaveLength(0); // the whole team is done
  });

  it("maxChildren caps the delegation; the ledger keeps the honest number", async () => {
    engine.setPolicyIfChanged(policyOf({ version: 2, teams: { enabled: true, maxChildren: 2 } }));
    engine.ingest([acceptItem()]);
    const reports = await runWork(engine, new Executor(DELEGATE(9)), "o/r", null);
    expect(reports[0].detail).toMatch(/delegated to 2 child ticket\(s\)/);
    expect(engine.pendingChildren(1)).toBe(2); // 9 requested → capped at 2
  });

  it("teams disabled → delegate.md ignored, the parent completes plain", async () => {
    engine.setPolicyIfChanged(policyOf({ version: 2, teams: { enabled: false } }));
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(DELEGATE(2)), "o/r", null);
    expect(engine.tickets().find((t) => t.id === 1)!.state).toBe("ended");
    expect(engine.tickets()).toHaveLength(1);
    expect(ledgerRows("ticket.delegated")).toHaveLength(0);
  });

  it("depth cap: a child cannot delegate again (maxDepth 1)", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(DELEGATE(1)), "o/r", null); // parent → child 2
    await runWork(engine, new Executor(DELEGATE(1)), "o/r", null); // child 2 runs, writes delegate.md
    const child = engine.tickets().find((t) => t.parent_ticket_id ?? false);
    void child;
    expect(engine.tickets().filter((t) => t.id !== 1)).toHaveLength(1); // no grandchild opened
    expect(engine.tickets().filter((t) => t.id !== 1).every((t) => t.state === "ended")).toBe(true);
  });

  it("stopping a child parks the parent too", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(DELEGATE(1)), "o/r", null);
    engine.stopTicket(2, "panel");
    expect(engine.tickets().find((t) => t.id === 1)!.stage).toBe("needs-person");
    expect(ledgerRows("ticket.child-failed")).toHaveLength(1);
  });
});
