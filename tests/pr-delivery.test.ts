import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { GitHubClient } from "../src/github/client.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";

let dir: string;
let engine: Engine;
let createdPRs: { title: string; head: string; base: string }[];
let prApiFails: boolean;
let postedCommentBodies: string[];
let client: GitHubClient;

const policy: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  table: ["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci"].map((s) => ({
    scope: s as never,
    listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
};

/** origin.git (bare) ← repoDir (clone, executor source) — real push path, no network. */
let originGit: string;
let repoDir: string;

function setupGit() {
  originGit = join(dir, "origin.git");
  repoDir = join(dir, "repo");
  mkdirSync(originGit, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  execSync("git init -q --bare -b main .", { cwd: originGit });
  execSync(`git clone -q ${JSON.stringify(originGit)} ${JSON.stringify(repoDir)}`);
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repoDir });
  execSync("git push -q origin main", { cwd: repoDir });
}

function acceptItem(n = 1): IngestItem {
  const t: Trigger = {
    id: `github:issue:${n}`, source: "github", scope: "issue", threadId: "github:o/r/issues/5",
    author: { login: "alice", isBot: false }, addressing: true,
    body: `task ${n}: add a feature\n\ndetails here`, ts: "2026-11-03T00:00:00Z",
  };
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

function makeClient(): GitHubClient {
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = url.toString();
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/repos/o/r") && (init?.method ?? "GET") === "GET") return json({ default_branch: "main" });
    if (u.endsWith("/repos/o/r/pulls") && init?.method === "POST") {
      if (prApiFails) return json({ message: "oops" }, 422);
      const body = JSON.parse(String(init.body)) as { title: string; head: string; base: string };
      createdPRs.push(body);
      return json({ number: 42, html_url: `https://github.com/o/r/pull/42` });
    }
    if (u.includes("/repos/o/r/issues/5/comments") && init?.method === "POST") {
      postedCommentBodies.push(JSON.parse(String(init.body)).body);
      return json({ id: 999 });
    }
    if (u.includes("/repos/o/r/issues/comments")) return json([]);
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${u}`);
  }) as unknown as typeof fetch;
  return new GitHubClient({ token: "t0", fetchImpl });
}

function executorWith(command: string): Executor {
  const cfg: ExecutorConfig = {
    command, repoDir, workRoot: join(dir, "work"),
    timeoutMs: 20000, maxWorkers: 1, blockedCommands: [],
  };
  return new Executor(cfg);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-delivery-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
  createdPRs = [];
  prApiFails = false;
  postedCommentBodies = [];
  setupGit();
  client = makeClient();
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PR delivery loop", () => {
  it("worker commits → branch pushed to origin + PR opened + report links it", async () => {
    engine.ingest([acceptItem()]);
    const exec = executorWith(
      `git -C "$DSH_DIR" -c user.email=w@w -c user.name=worker commit --allow-empty -m "feat: the work" -q && echo done`,
    );
    const reports = await runWork(engine, exec, "o/r", client);

    expect(reports[0]).toMatchObject({ outcome: "done", detail: "exit 0 · PR opened" });
    expect(createdPRs).toHaveLength(1);
    expect(createdPRs[0]).toMatchObject({ head: "dsh/ticket-1", base: "main" });
    expect(createdPRs[0].title).toBe("Ticket #1: task 1: add a feature");
    // real push happened: the bare origin has the ticket branch, tip = the worker's commit
    const tip = execSync(`git -C ${JSON.stringify(originGit)} log -1 --format=%s dsh/ticket-1`).toString().trim();
    expect(tip).toBe("feat: the work");
    // the report comment (drained by runWork's client) carries the PR link and the disclaimer
    const report = postedCommentBodies.find((b) => b.includes("Ticket #1 done"));
    expect(report).toBeDefined();
    expect(report).toContain("https://github.com/o/r/pull/42");
    expect(report).toContain("automated agent");
    // the delivery is recorded for the auto-merge sweep: PR number + the exact pushed SHA
    const dels = engine.openDeliveries("o/r");
    expect(dels).toHaveLength(1);
    expect(dels[0]).toMatchObject({ prNumber: 42, ticketId: 1, branch: "dsh/ticket-1", threadId: "github:o/r/issues/5" });
    const tipSha = execSync(`git -C ${JSON.stringify(originGit)} rev-parse dsh/ticket-1`).toString().trim();
    expect(dels[0].headSha).toBe(tipSha);
  });

  it("no new commits → no push, no PR, plain done report", async () => {
    engine.ingest([acceptItem(2)]);
    const reports = await runWork(engine, executorWith("echo read-only work"), "o/r", client);
    expect(reports[0]).toMatchObject({ outcome: "done", detail: "exit 0" });
    expect(createdPRs).toHaveLength(0);
    expect(engine.openDeliveries("o/r")).toHaveLength(0);
    expect(execSync(`git -C ${JSON.stringify(originGit)} branch --list dsh/ticket-*`).toString().trim()).toBe("");
  });

  it("PR API failure degrades gracefully — work stays done, report notes the failure", async () => {
    prApiFails = true;
    engine.ingest([acceptItem(3)]);
    const exec = executorWith(
      `git -C "$DSH_DIR" -c user.email=w@w -c user.name=worker commit --allow-empty -m "feat: more" -q`,
    );
    const reports = await runWork(engine, exec, "o/r", client);
    expect(reports[0]).toMatchObject({ outcome: "done" }); // still done
    const report = postedCommentBodies.find((b) => b.includes("Ticket #1 done"));
    expect(report).toContain("delivery failed");
    expect(existsSync(join(dir, "work"))).toBe(true); // worktree kept for inspection
  });
});

describe("PR title hygiene (live finding, harness-native PR #4)", () => {
  it("prefers the worker's summary line and never lifts a markdown header from the body", async () => {
    const item = acceptItem(2);
    item.trigger.body = "## Current behavior (verified against main)\n\nThree defects:\nline-length check is late";
    engine.ingest([item]);
    const exec = executorWith(
      `git -C "$DSH_DIR" -c user.email=w@w -c user.name=worker commit --allow-empty -m "fix: caps" -q && echo "done — enforce per-event byte caps in the SSE decoder"`,
    );
    await runWork(engine, exec, "o/r", client);
    expect(createdPRs[0].title).toBe("Ticket #1: enforce per-event byte caps in the SSE decoder");
  });

  it("falls back to the first non-header body line when the worker prints no summary", async () => {
    const item = acceptItem(3);
    item.trigger.body = "## Current behavior\n\nThree defects:\nline-length check is late";
    engine.ingest([item]);
    const exec = executorWith(
      `git -C "$DSH_DIR" -c user.email=w@w -c user.name=worker commit --allow-empty -m "fix: caps" -q`,
    );
    await runWork(engine, exec, "o/r", client);
    expect(createdPRs[0].title).toBe("Ticket #1: Three defects:");
  });
});
