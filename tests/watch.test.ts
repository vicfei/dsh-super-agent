import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import type { GitHubSource } from "../src/github/source.js";
import type { SourceState } from "../src/github/state.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runWatch } from "../src/watch.js";

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

const trigger: Trigger = {
  id: "github:issue:1", source: "github", scope: "issue", threadId: "github:o/r/issues/5",
  author: { login: "alice", isBot: false }, addressing: true,
  body: "say hello", ts: "2026-11-02T00:00:00Z",
};

function fakeSource(script: ("hello" | "fail" | "empty")[]): GitHubSource {
  const queue = [...script];
  return {
    async collect(_from: SourceState) {
      const step = queue.shift() ?? "empty";
      if (step === "fail") throw new Error("API 503");
      if (step === "empty") return { triggers: [], next: { positions: { issue: 1, issue_comment: 0, pr: 0, review_comment: 0 } } };
      return { triggers: [trigger], next: { positions: { issue: 1, issue_comment: 0, pr: 0, review_comment: 0 } } };
    },
  } as unknown as GitHubSource;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-watch-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function echoExecutor(): Executor {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main .", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q", { cwd: repo });
  const cfg: ExecutorConfig = {
    command: 'echo "hello from ticket $DSH_TICKET"',
    repoDir: repo, workRoot: join(dir, "work"),
    timeoutMs: 15000, maxWorkers: 1, blockedCommands: [],
  };
  return new Executor(cfg);
}

describe("runWatch", () => {
  it("one busy cycle: trigger → ticket → executed → reported; later cycles quiet", async () => {
    const logs: string[] = [];
    await runWatch({
      engine, source: fakeSource(["hello", "empty", "empty"]), executor: echoExecutor(),
      client: null, repo: "o/r", policy, assessment: () => "positive",
      intervalMs: 5, cycles: 3, log: (l) => logs.push(l),
    });

    const t = engine.tickets()[0];
    expect(t).toMatchObject({ state: "ended", stage: "ended", opener: "alice" }); // worked + completed
    expect(engine.takeDue().some((f) => f.key.startsWith("ticket-report:1:"))).toBe(true);
    expect(logs.some((l) => l.includes("[ACCEPT] EXPLICIT"))).toBe(true);
    expect(logs.some((l) => l.includes("#1 [done]"))).toBe(true);
    expect(logs.filter((l) => l.includes("— cycle")).length).toBe(1); // only the busy cycle logs a summary
  });

  it("a failing cycle backs off and the next one recovers", async () => {
    const logs: string[] = [];
    await runWatch({
      engine, source: fakeSource(["fail", "empty"]), executor: echoExecutor(),
      client: null, repo: "o/r", policy, assessment: () => "positive",
      intervalMs: 5, cycles: 2, log: (l) => logs.push(l),
    });
    expect(logs.some((l) => l.includes("backing off"))).toBe(true);
    expect(logs.some((l) => l.includes("cycle 1 failed"))).toBe(true);
  });

  it("does not re-execute across cycles (engine idempotence + read positions)", async () => {
    await runWatch({
      engine, source: fakeSource(["hello", "empty"]), executor: echoExecutor(),
      client: null, repo: "o/r", policy, assessment: () => "positive",
      intervalMs: 5, cycles: 2, log: () => {},
    });
    expect(engine.tickets()).toHaveLength(1);
    const assignments = engine.db.prepare("SELECT COUNT(*) c FROM assignment").get() as { c: number };
    expect(assignments.c).toBe(1);
  });
});
