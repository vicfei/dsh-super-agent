import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import type { GitHubSource } from "../src/github/source.js";
import type { SourceState } from "../src/github/state.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { GitHubClient } from "../src/github/client.js";
import { GitHubReplyChannel } from "../src/work.js";
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
      engine, sources: [fakeSource(["hello", "empty", "empty"])], executor: echoExecutor(),
      client: null, channels: [], repo: "o/r", policy, assessment: () => "positive",
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
      engine, sources: [fakeSource(["fail", "empty"])], executor: echoExecutor(),
      client: null, channels: [], repo: "o/r", policy, assessment: () => "positive",
      intervalMs: 5, cycles: 2, log: (l) => logs.push(l),
    });
    expect(logs.some((l) => l.includes("backing off"))).toBe(true);
    expect(logs.some((l) => l.includes("cycle 1 failed"))).toBe(true);
  });

  it("does not re-execute across cycles (engine idempotence + read positions)", async () => {
    await runWatch({
      engine, sources: [fakeSource(["hello", "empty"])], executor: echoExecutor(),
      client: null, channels: [], repo: "o/r", policy, assessment: () => "positive",
      intervalMs: 5, cycles: 2, log: () => {},
    });
    expect(engine.tickets()).toHaveLength(1);
    const assignments = engine.db.prepare("SELECT COUNT(*) c FROM assignment").get() as { c: number };
    expect(assignments.c).toBe(1);
  });

  it("same-thread burst costs one Slow-Path call (v0.9-3 batching); threads are independent", async () => {
    // three inferred triggers on one thread + one on another (allowed alice, not addressing)
    const burst = [1, 2, 3].map((n) => ({
      ...trigger, id: `github:issue_comment:${n}`, addressing: false,
      body: `note ${n}`,
    }));
    const other = { ...trigger, id: "github:issue_comment:9", addressing: false, threadId: "github:o/r/issues/6", body: "other" };
    let calls = 0;
    const one = async () => new Promise<typeof burst>(async (r) => {
      await new Promise((x) => setTimeout(x, 5));
      r([...burst, other]);
    });
    const fakeBurstSource = { kind: "github", collect: async () => ({ triggers: await one(), next: { positions: {} } }) } as never;
    await runWatch({
      engine, sources: [fakeBurstSource], executor: echoExecutor(),
      client: null, channels: [], repo: "o/r", policy,
      assessment: async () => { calls++; return "positive"; },
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(calls).toBe(2); // one per thread — not one per trigger
  });

  it("auto-merge sweep runs in-cycle when policy.merge.enabled (M6-1)", async () => {
    const head = "a".repeat(40);
    engine.recordDelivery({ repo: "o/r", prNumber: 42, ticketId: 1, threadId: "github:o/r/issues/5", branch: "dsh/ticket-1", headSha: head });
    const mergedBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = url.toString();
      const method = init?.method ?? "GET";
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
      if (u.endsWith("/repos/o/r/pulls/42") && method === "GET") {
        return json({ number: 42, state: "open", draft: false, merged: false, mergeable: true, head: { ref: "dsh/ticket-1", sha: head }, additions: 10, deletions: 5 });
      }
      if (u.endsWith("/repos/o/r/pulls/42/reviews")) {
        return json([{ id: 1, user: { login: "alice", type: "User" }, state: "APPROVED", commit_id: head, submitted_at: "2026-11-03T00:00:00Z" }]);
      }
      if (u.endsWith("/repos/o/r/pulls/42/merge") && method === "PUT") {
        mergedBodies.push(JSON.parse(String(init.body)));
        return json({ merged: true, sha: head });
      }
      if (u.endsWith("/repos/o/r/issues/5/comments") && method === "POST") return json({ id: 1 });
      if (/git\/refs\/heads\//.test(u) && method === "DELETE") return json({});
      throw new Error(`unexpected fetch ${method} ${u}`);
    }) as unknown as typeof fetch;
    const client = new GitHubClient({ token: "t0", fetchImpl });
    const channels = [new GitHubReplyChannel(client, "o/r")];

    const logs: string[] = [];
    await runWatch({
      engine, sources: [fakeSource(["empty"])], executor: echoExecutor(), client, channels, repo: "o/r",
      policy: { ...policy, merge: { enabled: true } }, assessment: () => "positive",
      intervalMs: 5, cycles: 1, log: (l) => logs.push(l),
    });

    expect(mergedBodies).toEqual([{ sha: head, merge_method: "squash" }]);
    expect(engine.deliveries()[0].state).toBe("merged");
    expect(logs.some((l) => l.includes("[merge] #42 merged"))).toBe(true);
    expect(logs.some((l) => l.includes("merged=1"))).toBe(true);
  });

  it("auto-merge stays a no-op when policy.merge is absent (default off)", async () => {
    engine.recordDelivery({ repo: "o/r", prNumber: 42, ticketId: 1, threadId: "github:o/r/issues/5", branch: "dsh/ticket-1", headSha: "a" });
    const fetchImpl = vi.fn(async () => { throw new Error("no API traffic expected"); }) as unknown as typeof fetch;
    await runWatch({
      engine, sources: [fakeSource(["empty"])], executor: echoExecutor(),
      client: new GitHubClient({ token: "t0", fetchImpl }), channels: [], repo: "o/r", policy,
      assessment: () => "positive", intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(engine.openDeliveries("o/r")).toHaveLength(1);
  });
});
