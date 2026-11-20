// Chat (v1.9 P1-2, issue #154): the terminal as a sixth channel — same admission table,
// same digits. Every assertion here is about NOT being special: cli triggers look like
// wechat im_dm triggers in the same decision table, digits ride the same interception.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { chatThreadId, chatTrigger, CliReplyChannel, runWork, runChat } from "../src/chat.js";
import { drainReplyEffects } from "../src/work.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "auto",
  approval: { enabled: true },
  table: [
    { scope: "im_dm" as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-chat-"));
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
    command: 'echo "done — worked on $DSH_TICKET"',
    repoDir: gitRepo(),
    workRoot: join(dir, "work"),
    timeoutMs: 30_000,
    maxWorkers: 1,
    blockedCommands: [],
    ...over,
  };
}

/** A prompt fed from a script; null after the script runs out (EOF). */
function scripted(lines: string[], out: string[] = []) {
  let i = 0;
  return {
    deps: {
      prompt: async (_q: string) => (i < lines.length ? lines[i++] : null),
      print: (l: string) => out.push(l),
    },
    out,
  };
}

describe("chatTrigger", () => {
  it("is an im_dm trigger like a WeChat DM: same scope, inherently addressed, same-thread across sessions", () => {
    const a = chatTrigger("alice", "fix the flaky test", "sess-1", 1);
    const b = chatTrigger("alice", "and another thing", "sess-2", 1);
    expect(a).toMatchObject({ source: "cli", scope: "im_dm", threadId: "cli:dm/alice", addressing: true });
    expect(a.threadId).toBe(b.threadId); // one persistent DM conversation
    expect(a.id).not.toBe(b.id); // but dedup-safe: session+seq ids never collide
  });
});

describe("runChat", () => {
  it("an allowed operator's line goes through the gate → ticket → work → report, printed right here", async () => {
    const s = scripted(["summarize HEAD"]);
    await runChat({ engine, policy, executor: new Executor(cfg()), repo: "local/chat", login: "alice", assessment: () => "positive", deps: s.deps });
    expect(s.out.some((l) => l.includes("[ACCEPT]") && l.includes("im_dm cli:dm/alice"))).toBe(true);
    expect(s.out.some((l) => l.includes("#1 [done]"))).toBe(true);
    expect(s.out.some((l) => l.includes("Ticket #1 done"))).toBe(true); // the report body, via the CLI channel
    // the twist: the decision row is indistinguishable in shape from a WeChat DM's —
    // an allowed member's inherently-addressed DM is explicit, exactly like wechat:peer
    const d = engine.decisions()[0];
    expect(d).toMatchObject({ scope: "im_dm", strength: "explicit" });
    expect(engine.tickets()[0].threadId).toBe("cli:dm/alice");
  });

  it("an unlisted login is gated to ignore by the same cell — no ticket, no work", async () => {
    const s = scripted(["let me in"]);
    await runChat({ engine, policy, executor: new Executor(cfg()), repo: "local/chat", login: "mallory", assessment: () => "positive", deps: s.deps });
    expect(s.out.some((l) => l.includes("[IGNORE]"))).toBe(true);
    expect(s.out.some((l) => l.includes("not on the allowedList"))).toBe(true);
    expect(engine.tickets()).toHaveLength(0);
  });

  it("the chat thread registers as an ops route — digits and ? ride the same interception", async () => {
    const s = scripted(["?"]);
    await runChat({ engine, policy, executor: new Executor(cfg()), repo: "local/chat", login: "alice", assessment: () => "positive", deps: s.deps });
    expect(engine.opsRoutes()["alice"]).toBe("cli:dm/alice");
    expect(s.out.some((l) => l.includes("[approval] status-card"))).toBe(true);
    expect(s.out.some((l) => l.includes("dsh status"))).toBe(true);
  });

  it("a failed run asks for a person HERE: needs-person → approval request rendered into the chat thread", async () => {
    const s = scripted(["do the thing"]);
    const bad = cfg({ command: "echo bad; exit 3" });
    await runChat({ engine, policy, executor: new Executor(bad), repo: "local/chat", login: "alice", assessment: () => "positive", deps: s.deps });
    expect(s.out.some((l) => l.includes("Ticket #1 failed") || l.includes("#1 [failed]"))).toBe(true);
    expect(s.out.some((l) => l.includes("1") && l.includes("requeue"))).toBe(true);
    // and the digit resolves it — full circle in one thread
    const digit = scripted(["1"], []);
    await runChat({ engine, policy, executor: new Executor(bad), repo: "local/chat", login: "alice", assessment: () => "positive", deps: digit.deps });
    expect(digit.out.some((l) => l.includes("requeue") || l.includes("Requeued") || l.includes("re-queued"))).toBe(true);
  });

  it("exit and EOF end the chat; blank lines are skipped", async () => {
    const s = scripted(["", "exit"]);
    await runChat({ engine, policy, executor: new Executor(cfg()), repo: "local/chat", login: "alice", assessment: () => "positive", deps: s.deps });
    expect(engine.tickets()).toHaveLength(0); // nothing was ingested
    const eof = scripted([]);
    await runChat({ engine, policy, executor: new Executor(cfg()), repo: "local/chat", login: "alice", assessment: () => "positive", deps: eof.deps });
  });
});

describe("CliReplyChannel", () => {
  it("matches only cli: threads and prints the body", async () => {
    const out: string[] = [];
    const ch = new CliReplyChannel((l) => out.push(l));
    expect(ch.matches("cli:dm/alice")).toBe(true);
    expect(ch.matches("wechat:peer/x")).toBe(false);
    const { externalId } = await ch.deliver("cli:dm/alice", "hello from the engine");
    expect(externalId).toContain("chat-line:");
    expect(out).toEqual(["hello from the engine"]);
  });
});
