// Speculative execution + deliver gate (v1.0, issue #68) — observe-mode inferred candidates
// may rehearse in total silence; a human promote is the ONLY path to delivery.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { GitHubClient } from "../src/github/client.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runPromoteSweep, runWork } from "../src/work.js";

let dir: string;
let engine: Engine;

const specPolicy: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "observe",
  speculation: { enabled: true, maxSpeculative: 1 },
  table: ["issue", "im_dm"].map((s) => ({
    scope: s as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
};
const plainPolicy: Policy = { ...specPolicy, speculation: undefined, version: 2 };

function shadowItem(n: number): IngestItem {
  const t: Trigger = {
    id: `github:issue:${n}`, source: "github", scope: "issue", threadId: `github:o/r/issues/${n}`,
    author: { login: "alice", isBot: false }, addressing: false, body: "maybe fix this", ts: "2026-11-04T00:00:00Z",
  };
  const gate = evaluateGate(specPolicy, t);
  return { trigger: t, gate, resolution: { action: "shadow", strength: "inferred", basis: "allowed alice not addressing", wouldAccept: true } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-spec-"));
  engine = new Engine(join(dir, "engine.db"));
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("speculative ingest", () => {
  it("observe shadow + enabled → a silent speculative ticket; decision stays would-accept; cap enforced", () => {
    engine.setPolicyIfChanged(specPolicy);
    const r = engine.ingest([shadowItem(1)]);
    expect(r.speculative).toBe(1);
    const t = engine.tickets()[0];
    expect(t).toMatchObject({ speculative: true, strength: "inferred", state: "open" });
    expect(engine.takeDue()).toHaveLength(0); // total silence: zero reply effects
    expect(engine.decisions(10)[0]).toMatchObject({ kind: "ignore", wouldAccept: true });

    // cap: the second shadow stays shadow-only
    const r2 = engine.ingest([shadowItem(2)]);
    expect(r2.speculative).toBe(0);
    expect(engine.tickets()).toHaveLength(1);
  });

  it("disabled → unchanged shadow behavior (no ticket)", () => {
    engine.setPolicyIfChanged(plainPolicy);
    const r = engine.ingest([shadowItem(3)]);
    expect(r.speculative).toBe(0);
    expect(engine.tickets()).toHaveLength(0);
  });
});

function gitHarness(): { repoDir: string; originGit: string; client: GitHubClient; posted: string[] } {
  const originGit = join(dir, "origin.git");
  const repoDir = join(dir, "repo");
  mkdirSync(originGit, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  execSync("git init -q --bare -b main .", { cwd: originGit });
  execSync(`git clone -q ${JSON.stringify(originGit)} ${JSON.stringify(repoDir)}`);
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repoDir });
  execSync("git push -q origin main", { cwd: repoDir });
  const posted: string[] = [];
  const client = new GitHubClient({
    token: "t0",
    fetchImpl: vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = url.toString();
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (u.endsWith("/repos/o/r") && (init?.method ?? "GET") === "GET") return json({ default_branch: "main" });
      if (u.endsWith("/repos/o/r/pulls") && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)).title);
        return json({ number: 77, html_url: "https://github.com/o/r/pull/77" });
      }
      if (u.endsWith("/repos/o/r/issues/1/comments") && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)).body);
        return json({ id: 555 });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch,
  });
  return { repoDir, originGit, client, posted };
}

describe("silent run + human promote delivery", () => {
  it("rehearses without a word; promote → the sweep pushes, opens the PR, reports once", async () => {
    engine.setPolicyIfChanged(specPolicy);
    engine.ingest([shadowItem(1)]);
    const { repoDir, originGit, client, posted } = gitHarness();
    const cfg: ExecutorConfig = {
      command: `git -C "$DSH_DIR" -c user.email=w@w -c user.name=w commit --allow-empty -m "rehearsed fix" -q`,
      repoDir, workRoot: join(dir, "work"), timeoutMs: 30_000, maxWorkers: 1, blockedCommands: [],
    };
    const executor = new Executor(cfg);

    // 1) silent run: work happens, nothing is pushed/said
    const reports = await runWork(engine, executor, "o/r", client);
    expect(reports[0]).toMatchObject({ outcome: "done", detail: expect.stringContaining("speculative") });
    expect(posted).toHaveLength(0); // zero PRs, zero replies
    expect(execSync(`git -C ${JSON.stringify(originGit)} branch --list dsh/*`).toString().trim()).toBe("");
    expect(engine.tickets()[0].state).toBe("ended");

    // 2) the deliver gate is a human act
    expect(engine.promoteTicket(1, "panel")).toBe(true);
    expect(engine.promoteTicket(1, "panel")).toBe(false); // idempotent refusal

    // 3) the sweep delivers exactly once
    const n1 = await runPromoteSweep(engine, executor, client, "o/r");
    expect(n1).toBe(1);
    const n2 = await runPromoteSweep(engine, executor, client, "o/r");
    expect(n2).toBe(0); // delivery row took it out of the pending list
    expect(posted.some((p) => p.includes("Ticket #1"))).toBe(true); // the PR title
    expect(posted.some((p) => p.includes("Promoted speculative ticket #1"))).toBe(true); // the reply
    expect(execSync(`git -C ${JSON.stringify(originGit)} log -1 --format=%s dsh/ticket-1`).toString().trim()).toBe("rehearsed fix");
    expect(engine.deliveries()[0]).toMatchObject({ prNumber: 77, state: "open" });
  });

  it("promoted but empty worktree: logged once, then out of the sweep for good (no per-cycle replay)", async () => {
    engine.setPolicyIfChanged(specPolicy);
    engine.ingest([shadowItem(1)]);
    const { repoDir, client } = gitHarness();
    const executor = new Executor({
      command: "true", // rehearses without committing anything
      repoDir, workRoot: join(dir, "work"), timeoutMs: 30_000, maxWorkers: 1, blockedCommands: [],
    });
    await runWork(engine, executor, "o/r", client);
    engine.promoteTicket(1, "panel");

    const logs: string[] = [];
    const n1 = await runPromoteSweep(engine, executor, client, "o/r", [], (l) => logs.push(l));
    expect(n1).toBe(0);
    expect(logs).toHaveLength(1); // "no commits — nothing to deliver", exactly once
    expect(logs[0]).toContain("no commits");
    const n2 = await runPromoteSweep(engine, executor, client, "o/r", [], (l) => logs.push(l));
    expect(n2).toBe(0);
    expect(logs).toHaveLength(1); // the next sweep is silent — settled, not retried
  });
});
