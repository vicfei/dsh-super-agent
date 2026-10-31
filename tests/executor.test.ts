import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "auto",
  table: ["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci"].map((s) => ({
    scope: s as never,
    listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const,
    unlistedNotAddressing: "ignore" as const,
  })),
};

let seq = 0;
function acceptItem(): IngestItem {
  const t: Trigger = {
    id: `github:issue:${++seq}`,
    source: "github", scope: "issue", threadId: "github:o/r/issues/5",
    author: { login: "alice", isBot: false }, addressing: true,
    body: `task ${seq}: summarize HEAD`, ts: "2026-11-02T00:00:00Z",
  };
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-exec-"));
  engine = new Engine(join(dir, "engine.db"));
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

function cfg(over: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    command: 'echo "worked on $DSH_TICKET"; git -C "$DSH_DIR" log --oneline -1',
    repoDir: gitRepo(),
    workRoot: join(dir, "work"),
    timeoutMs: 30_000,
    maxWorkers: 1,
    blockedCommands: [],
    ...over,
  };
}

describe("Executor", () => {
  it("runs in a per-ticket worktree with env vars and prompt file", async () => {
    const exec = new Executor(cfg());
    const r = await exec.run({ id: 7, threadId: "github:o/r/issues/5" }, { body: "do the thing", author: "alice" }, "o/r");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("worked on 7");
    expect(r.output).toContain("init"); // git log from the worktree
    expect(existsSync(r.worktree)).toBe(true);
    const prompt = readFileSync(join(r.worktree, "DSH_PROMPT.md"), "utf8");
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("≤150 words");
    expect(execSync("git -C " + JSON.stringify(r.worktree) + " branch --show-current").toString().trim()).toBe("dsh/ticket-7");
  });

  it("blocked commands refuse by name", async () => {
    const exec = new Executor(cfg({ command: "sudo rm -rf x", blockedCommands: ["sudo"] }));
    await expect(exec.run({ id: 1, threadId: "t" }, { body: "b", author: "a" }, "o/r")).rejects.toThrow(/blocked by name: sudo/);
  });

  it("kills the subprocess at the timeout", async () => {
    const exec = new Executor(cfg({ command: "echo started; sleep 30", timeoutMs: 800 }));
    const r = await exec.run({ id: 2, threadId: "t" }, { body: "b", author: "a" }, "o/r");
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.output).toContain("started");
  });

  it("prepare failure (bad repoDir) throws with context", async () => {
    const exec = new Executor(cfg({ repoDir: join(dir, "nope") }));
    await expect(exec.run({ id: 3, threadId: "t" }, { body: "b", author: "a" }, "o/r")).rejects.toThrow(/prepare failed/);
  });
});

describe("runWork", () => {
  it("done: assignment recorded, ticket completed, reply effect enqueued", async () => {
    engine.ingest([acceptItem()]);
    const reports = await runWork(engine, new Executor(cfg()), "o/r", null);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ticketId: 1, outcome: "done" });

    const t = engine.tickets()[0];
    expect(t.state).toBe("ended");
    expect(t.stoppedBy).toBeUndefined(); // completed, not stopped — new work opens a new ticket
    expect(t.stage).toBe("ended");

    const fx = engine.takeDue().filter((f) => f.key.startsWith("ticket-report:1:"));
    expect(fx).toHaveLength(1);
    const body = (fx[0].payload as { body: string }).body;
    expect(body).toContain("Ticket #1 done");
    expect(body).toContain("automated agent");
  });

  it("failed: ticket stays open at needs-person, not re-claimed", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg({ command: "echo bad; exit 3" })), "o/r", null);
    const t = engine.tickets()[0];
    expect(t.state).toBe("open");
    expect(t.stage).toBe("needs-person");
    expect(engine.claimQueued(5)).toHaveLength(0); // no automatic retry loop
    expect(engine.takeDue().some((f) => (f.payload as { body: string }).body.includes("failed"))).toBe(true);
  });

  it("refused (blocked/prepare): recorded as failed assignment + reply, ticket needs-person", async () => {
    engine.ingest([acceptItem()]);
    const reports = await runWork(engine, new Executor(cfg({ repoDir: join(dir, "nope") })), "o/r", null);
    expect(reports[0].outcome).toBe("refused");
    expect(engine.tickets()[0].stage).toBe("needs-person");
  });

  it("slots: maxWorkers=1 runs one ticket per invocation; the second stays queued", async () => {
    engine.ingest([acceptItem(), acceptItem()]);
    const first = await runWork(engine, new Executor(cfg({ maxWorkers: 1 })), "o/r", null);
    expect(first).toHaveLength(1);
    expect(engine.tickets().filter((t) => t.stage === "queued")).toHaveLength(1);
    const second = await runWork(engine, new Executor(cfg({ maxWorkers: 1 })), "o/r", null);
    expect(second).toHaveLength(1);
    expect(engine.tickets().every((t) => t.state === "ended")).toBe(true);
  });

  it("a resumed ticket (completed then resumed by opener) is re-claimable", async () => {
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg()), "o/r", null); // completed → ended
    const r = engine.ingest([acceptItem()]); // same author, same thread → resume
    expect(r.resumed).toBe(1);
    expect(engine.tickets()[0].stage).toBe("queued"); // re-claimable
    expect(engine.claimQueued(5)).toHaveLength(1);
  });
});
