// Budget gates (v1.11, #171): caps as checkable facts — hold for a person, approval is a
// waiver, `budget.near` once per dimension, `$DSH_USAGE_FILE` one-way reporting.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";
import { budgetRunTimeoutMs, consumeUsageFile, evaluateBudget } from "../src/budget.js";

let dir: string;
let engine: Engine;
let seq = 0;

const policyOf = (budget?: Policy["budget"]): Policy => ({
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  ...(budget ? { budget } : {}),
  table: ["issue"].map((s) => ({
    scope: s as never, listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
});

function acceptItem(): IngestItem {
  const t: Trigger = {
    id: `github:issue:${++seq}`, source: "github", scope: "issue", threadId: "github:o/r/issues/5",
    author: { login: "alice", isBot: false }, addressing: true, body: `task ${seq}`, ts: "2026-11-21T00:00:00Z",
  };
  const gate = evaluateGate(policyOf(), t);
  return { trigger: t, gate, resolution: resolveCandidate(policyOf(), gate, "positive") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-budget-"));
  engine = new Engine(join(dir, "engine.db"));
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
const ledgerRows = (kind: string) => engine.ledger.eventsAfter(0, 500).filter((e) => e.kind === kind);
const USAGE = `mkdir -p .dsh && printf '%s' '{"input_tokens": 600, "output_tokens": 0}' > "$DSH_USAGE_FILE"`;

describe("evaluateBudget (pure)", () => {
  const p = { maxWallMs: 1000, maxAttempts: 4, maxOutputBytes: 100, maxTokens: 1000, nearRatio: 0.8 };
  it("exhausted at or over cap, near between ratio and cap, unbounded dims ignored", () => {
    const v = evaluateBudget({ wallMs: 1000, attempts: 3, outputBytes: 10, tokens: 799 }, p);
    expect(v.exhausted).toEqual(["wall"]);
    expect(v.near).toEqual([]); // 3 < 3.2 and 799 < 800 — just under both bands
  });
  it("near threshold is cap × nearRatio; waived dimensions are skipped entirely", () => {
    const v = evaluateBudget({ wallMs: 900, attempts: 3, outputBytes: 90, tokens: 5000 }, { ...p, nearRatio: 0.75 }, ["tokens"]);
    expect(v.near.sort()).toEqual(["attempts", "output", "wall"]); // 900≥750, 3≥3, 90≥75
    expect(v.exhausted).toEqual([]); // tokens waived
  });
  it("run timeout is the executor's or the remaining wall budget, whichever is less", () => {
    const u = { wallMs: 0, attempts: 0, outputBytes: 0, tokens: 0 };
    expect(budgetRunTimeoutMs(u, p, 30_000)).toBe(1000);
    expect(budgetRunTimeoutMs({ ...u, wallMs: 600 }, p, 30_000)).toBe(400);
    expect(budgetRunTimeoutMs({ ...u, wallMs: 600 }, p, 200)).toBe(200);
    expect(budgetRunTimeoutMs(u, { nearRatio: 0.8 }, 30_000)).toBe(30_000); // no wall cap
    expect(budgetRunTimeoutMs(u, p, 30_000, ["wall"])).toBe(30_000); // waived
  });
});

describe("consumeUsageFile", () => {
  it("accepts OpenAI, underscore and camelCase names; moves the report to consumed/", () => {
    const wt = join(dir, "wt");
    mkdirSync(join(wt, ".dsh"), { recursive: true });
    const write = (s: string) => writeFileSync(join(wt, ".dsh", "usage.json"), s, "utf8");
    write('{"prompt_tokens": 100, "completion_tokens": 20}');
    expect(consumeUsageFile(wt)).toEqual({ input: 100, output: 20 });
    write('{"input_tokens": 7, "output_tokens": 3}');
    expect(consumeUsageFile(wt)).toEqual({ input: 7, output: 3 });
    write('{"inputTokens": 1, "outputTokens": 2}');
    expect(consumeUsageFile(wt)).toEqual({ input: 1, output: 2 });
    expect(existsSync(join(wt, ".dsh", "usage.json"))).toBe(false); // consumed once
  });
  it("missing or malformed reports are inert — never fail a run", () => {
    const wt = join(dir, "wt2");
    mkdirSync(join(wt, ".dsh"), { recursive: true });
    expect(consumeUsageFile(wt)).toBeNull();
    writeFileSync(join(wt, ".dsh", "usage.json"), "{not json", "utf8");
    expect(consumeUsageFile(wt)).toBeNull();
    writeFileSync(join(wt, ".dsh", "usage.json"), '{"prompt_tokens": -5}', "utf8");
    expect(consumeUsageFile(wt)).toBeNull();
  });
});

describe("budget gates through runWork", () => {
  it("attempts: a failed run at the cap holds the ticket for a person; approval waives and re-arms", async () => {
    engine.setPolicyIfChanged(policyOf({ maxAttempts: 1 }));
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg("echo bad; exit 3")), "o/r", null);

    expect(engine.tickets()[0].stage).toBe("needs-person");
    expect(ledgerRows("budget.exhausted").map((e) => (e.payload as { dimension: string }).dimension)).toContain("attempts");
    expect(engine.budgetHold(1)?.dimensions).toEqual(["attempts"]);

    // held tickets are not claimable — no second run, nothing killed
    expect(engine.claimQueued(5)).toHaveLength(0);
    expect(await runWork(engine, new Executor(cfg("echo again")), "o/r", null)).toHaveLength(0);

    // a person approves → waiver on the ledger → claimable; attempts no longer count against it
    expect(engine.requeueTicket(1)).toBe(true);
    expect(engine.budgetHold(1)).toBeNull();
    expect(engine.budgetWaived(1)).toEqual(["attempts"]);
    expect(ledgerRows("budget.waived")).toHaveLength(1);
    const reports = await runWork(engine, new Executor(cfg("echo still bad; exit 3")), "o/r", null);
    expect(reports[0].outcome).toBe("failed"); // fails on its own merits — not a budget hold
    expect(engine.budgetHold(1)).toBeNull();
    expect(ledgerRows("budget.exhausted")).toHaveLength(1);
  });

  it("wall: the run is capped at the remaining wall budget; exhausting it holds the ticket", async () => {
    engine.setPolicyIfChanged(policyOf({ maxWallMs: 80 }));
    engine.ingest([acceptItem()]);
    const reports = await runWork(engine, new Executor(cfg("echo started; sleep 5")), "o/r", null);
    expect(reports[0].detail).toBe("timeout"); // killed at ~80ms, not at the executor's 30s
    const dims = ledgerRows("budget.exhausted").map((e) => (e.payload as { dimension: string }).dimension);
    expect(dims).toContain("wall");
    expect(engine.tickets()[0].stage).toBe("needs-person");
    expect(engine.budgetHold(1)?.detail).toMatch(/wall \d+ms ≥ cap 80/);
  });

  it("output: a run over the cap is recorded even when the work succeeds (evidence, no hold on a done ticket)", async () => {
    engine.setPolicyIfChanged(policyOf({ maxOutputBytes: 50 }));
    engine.ingest([acceptItem()]);
    const reports = await runWork(engine, new Executor(cfg(`echo ${"x".repeat(200)}`)), "o/r", null);
    expect(reports[0].outcome).toBe("done");
    expect(engine.tickets()[0].state).toBe("ended");
    expect(engine.budgetHold(1)).toBeNull();
    expect(ledgerRows("budget.exhausted").map((e) => (e.payload as { dimension: string }).dimension)).toEqual(["output"]);
  });

  it("tokens: worker reports accumulate across resumes; the pre-run gate holds before the next run", async () => {
    engine.setPolicyIfChanged(policyOf({ maxTokens: 1000 }));
    const exec = () => new Executor(cfg(USAGE));
    engine.ingest([acceptItem()]);
    await runWork(engine, exec(), "o/r", null); // run 1: 600 tokens, near (≥800)? no — 600 < 800
    expect(ledgerRows("budget.near")).toHaveLength(0);
    expect(engine.ticketTokens(1)).toEqual({ input: 600, output: 0 });

    engine.ingest([acceptItem()]); // the opener returns on the same thread → the ticket resumes
    await runWork(engine, exec(), "o/r", null); // run 2: 1200 ≥ 1000, but the run succeeded → evidence only
    expect(engine.tickets()[0].state).toBe("ended");
    expect(ledgerRows("budget.exhausted").map((e) => (e.payload as { dimension: string }).dimension)).toEqual(["tokens"]);
    expect(engine.budgetHold(1)).toBeNull(); // done tickets are never held

    engine.ingest([acceptItem()]); // resumed again → claimable → the PRE-RUN gate fires
    const reports = await runWork(engine, exec(), "o/r", null);
    expect(reports[0]).toMatchObject({ outcome: "refused", detail: /budget exhausted \(tokens\) — held for a person/ });
    expect(engine.tickets()[0].stage).toBe("needs-person");
    expect(engine.budgetHold(1)?.dimensions).toEqual(["tokens"]);
  });

  it("near is recorded once per dimension, however many times usage sits in the band", async () => {
    engine.setPolicyIfChanged(policyOf({ maxAttempts: 5, nearRatio: 0.2 })); // near band starts at 1 run
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg("echo bad; exit 3")), "o/r", null);
    engine.requeueTicket(1);
    await runWork(engine, new Executor(cfg("echo bad; exit 3")), "o/r", null);
    const near = ledgerRows("budget.near");
    expect(near).toHaveLength(1);
    expect((near[0].payload as { dimension: string }).dimension).toBe("attempts");
    expect(engine.budgetHold(1)).toBeNull(); // 2 < 5 — not exhausted
  });

  it("without policy.budget everything is inert — no rows, no holds, the executor's timeout rules", async () => {
    engine.setPolicyIfChanged(policyOf());
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg("echo bad; exit 3")), "o/r", null);
    expect(engine.budgetHold(1)).toBeNull();
    expect(engine.ledger.eventsAfter(0, 500).filter((e) => e.kind.startsWith("budget."))).toHaveLength(0);
  });
});
