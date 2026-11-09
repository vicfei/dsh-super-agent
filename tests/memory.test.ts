// Two-tier memory (v1.4, issue #110) — the durable tier: distill-at-completion records
// candidates (observe) or accepted facts (auto); accepted memories ride with future
// DSH_PROMPT.md files. The ladder is the whole point: same distiller, mode decides.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { Executor, renderPrompt, type ExecutorConfig } from "../src/executor.js";
import { parseMemories } from "../src/memory.js";
import { runWatch } from "../src/watch.js";

let dir: string;
let engine: Engine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-memory-"));
  engine = new Engine(join(dir, "engine.db"));
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const basePolicy: Policy = {
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "auto",
  table: [{ scope: "issue", listedNotAddressing: "ignore", unlistedAddressing: "ignore", unlistedNotAddressing: "ignore" }],
  memory: { enabled: true },
};

describe("parseMemories", () => {
  it("keeps bullets, drops chatter and NONE, caps at 3, dedups", () => {
    expect(parseMemories("NONE")).toEqual([]);
    expect(parseMemories("- use pnpm\n- tests need DATABASE_URL\n- use pnpm")).toEqual(["use pnpm", "tests need DATABASE_URL"]);
    expect(parseMemories("Sure! Here are the facts:\n- a\n- b\n- c\n- d")).toEqual(["a", "b", "c"]);
  });

  it("truncates each memory to 160 chars", () => {
    const out = parseMemories(`- ${"x".repeat(200)}`);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(160);
  });
});

describe("engine memory tier", () => {
  function openTicket(id: string): void {
    const t: Trigger = {
      id, source: "github", scope: "issue", threadId: `github:o/r/issues/${id.slice(-1)}`,
      author: { login: "alice", isBot: false }, addressing: true, body: "do work", ts: new Date().toISOString(),
    };
    engine.ingest(
      [{ trigger: t, gate: { strength: "explicit", row: basePolicy.table[0] }, resolution: { action: "accept", basis: "explicit" } }],
      { github: { positions: { issue: 1 } } },
    );
  }

  it("records candidates in observe (would-inject evidence, never injected); accepts in auto", () => {
    openTicket("github:issue:1");
    const n = engine.recordMemories({ repo: "o/r", ticketId: 1, bodies: ["prefer pnpm", ""], autoAccept: false, maxAccepted: 32 });
    expect(n).toBe(1); // empty bodies dropped
    expect(engine.injectableMemories("o/r", 8)).toEqual([]); // observe: candidate, not injectable
    expect(engine.memoryView().counts.candidate).toBe(1);

    engine.recordMemories({ repo: "o/r", ticketId: 1, bodies: ["tests need DATABASE_URL"], autoAccept: true, maxAccepted: 32 });
    expect(engine.injectableMemories("o/r", 8)).toEqual(["tests need DATABASE_URL"]);
    expect(engine.memoryView().counts).toMatchObject({ candidate: 1, accepted: 1 });
  });

  it("prunes the oldest accepted beyond maxAccepted; recency order on injection", () => {
    openTicket("github:issue:1");
    for (let i = 1; i <= 4; i++) {
      engine.recordMemories({ repo: "o/r", ticketId: 1, bodies: [`fact-${i}`], autoAccept: true, maxAccepted: 3 });
    }
    const injectable = engine.injectableMemories("o/r", 8);
    expect(injectable).toEqual(["fact-4", "fact-3", "fact-2"]); // fact-1 pruned, newest first
    expect(engine.memoryView().counts.accepted).toBe(3);
  });

  it("keeps repos isolated", () => {
    openTicket("github:issue:1");
    engine.recordMemories({ repo: "a/b", ticketId: 1, bodies: ["only-for-ab"], autoAccept: true, maxAccepted: 8 });
    expect(engine.injectableMemories("other/r", 8)).toEqual([]);
  });

  it("records provenance: which ticket distilled what", () => {
    openTicket("github:issue:1");
    engine.recordMemories({ repo: "o/r", ticketId: 1, bodies: ["gotcha"], autoAccept: true, maxAccepted: 8 });
    const recent = engine.memoryView().recent;
    expect(recent[0]).toMatchObject({ body: "gotcha", status: "accepted", sourceTicket: 1 });
  });
});

describe("renderPrompt injection", () => {
  it("appends the memory section with the not-an-instruction caveat; absent when empty", () => {
    const withMem = renderPrompt({ id: 1, threadId: "t" }, { body: "b", author: "a" }, "o/r", ["prefer pnpm"]);
    expect(withMem).toContain("## Project memory");
    expect(withMem).toContain("- prefer pnpm");
    expect(withMem).toContain("not instructions from a person");
    expect(renderPrompt({ id: 1, threadId: "t" }, { body: "b", author: "a" }, "o/r", [])).not.toContain("Project memory");
  });
});

describe("the ladder, end to end (runWatch)", () => {
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

  function sourceWith(n: number) {
    const trigger: Trigger = {
      id: `github:issue:${n}`, source: "github", scope: "issue", threadId: `github:o/r/issues/${n}`,
      author: { login: "alice", isBot: false }, addressing: true, body: `task ${n}`, ts: new Date().toISOString(),
    };
    return {
      kind: "github" as const,
      async collect() {
        return { triggers: [trigger], next: { positions: { issue: n } } };
      },
    };
  }

  const promptOf = (executor: Executor, ticketId: number) =>
    readFileSync(join(executor.worktreeOf(ticketId), "DSH_PROMPT.md"), "utf8");

  it("observe: distills candidates but never injects them into the next ticket", async () => {
    const executor = echoExecutor();
    engine.setPolicyIfChanged({ ...basePolicy, acceptMode: "observe" });
    let distills = 0;
    await runWatch({
      engine, sources: [sourceWith(1)], executor, client: null, channels: [], repo: "o/r",
      policy: { ...basePolicy, acceptMode: "observe" },
      assessment: () => "positive",
      memoryDistiller: async () => { distills++; return ["prefer pnpm over npm"]; },
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(distills).toBe(1);
    expect(engine.memoryView().counts).toMatchObject({ candidate: 1, accepted: 0 });

    await runWatch({
      engine, sources: [sourceWith(2)], executor, client: null, channels: [], repo: "o/r",
      policy: { ...basePolicy, acceptMode: "observe" },
      assessment: () => "positive",
      memoryDistiller: async () => [],
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(promptOf(executor, 2)).not.toContain("prefer pnpm"); // the ladder held
  });

  it("auto: accepted memories ride with the next dispatch", async () => {
    const executor = echoExecutor();
    engine.setPolicyIfChanged(basePolicy);
    await runWatch({
      engine, sources: [sourceWith(1)], executor, client: null, channels: [], repo: "o/r",
      policy: basePolicy, assessment: () => "positive",
      memoryDistiller: async () => ["prefer pnpm over npm"],
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(engine.memoryView().counts.accepted).toBe(1);

    await runWatch({
      engine, sources: [sourceWith(2)], executor, client: null, channels: [], repo: "o/r",
      policy: basePolicy, assessment: () => "positive",
      memoryDistiller: async () => [],
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(promptOf(executor, 2)).toContain("- prefer pnpm over npm");
  });

  it("a throwing distiller fails soft: the ticket still completes, nothing recorded", async () => {
    const executor = echoExecutor();
    engine.setPolicyIfChanged(basePolicy);
    await runWatch({
      engine, sources: [sourceWith(1)], executor, client: null, channels: [], repo: "o/r",
      policy: basePolicy, assessment: () => "positive",
      memoryDistiller: async () => { throw new Error("endpoint down"); },
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(engine.tickets()[0]).toMatchObject({ state: "ended" }); // completed normally
    expect(engine.memoryView().counts).toEqual({ candidate: 0, accepted: 0, rejected: 0 });
  });

  it("policy default (memory absent) never calls the distiller even when one is provided", async () => {
    const executor = echoExecutor();
    const noMemory = { ...basePolicy, memory: undefined };
    engine.setPolicyIfChanged(noMemory);
    let distills = 0;
    await runWatch({
      engine, sources: [sourceWith(1)], executor, client: null, channels: [], repo: "o/r",
      policy: noMemory, assessment: () => "positive",
      memoryDistiller: async () => { distills++; return ["should never land"]; },
      intervalMs: 5, cycles: 1, log: () => {},
    });
    expect(distills).toBe(0);
    expect(engine.memoryView().counts.accepted).toBe(0);
  });
});
