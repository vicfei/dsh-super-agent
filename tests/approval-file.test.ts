// v1.2 P2 — the approval-request file protocol (docs/designs/v1.2-scope.md §P2):
// a worker that wants permission writes .dsh/approval-request.md and stops; the run
// lands in needs-person with the request as the structured ask; the file is consumed;
// approve (digit 1) resumes with the request as guidance — a note, never a token.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { Executor, renderPrompt, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";
import { applyApproval, runApprovalSweep } from "../src/approval.js";
import type { ReplyChannel } from "../src/source.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "auto",
  approval: { enabled: true },
  table: [{ scope: "im_dm", listedNotAddressing: "inferred", unlistedAddressing: "inferred", unlistedNotAddressing: "ignore" }],
};

const trigger: Trigger = {
  id: "wechat:msg:1", source: "wechat", scope: "im_dm", threadId: "wechat:peer/wxid_ops",
  author: { login: "alice", isBot: false }, addressing: true,
  body: "ship it", ts: "2026-11-05T00:00:00Z",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-apfile-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The asking worker: writes the request file, then exits with the given code. */
function askingExecutor(exit: number): Executor {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main .", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q", { cwd: repo });
  const cfg: ExecutorConfig = {
    command: `mkdir -p .dsh && printf 'title: npm publish v1.2.0\\nreason: the registry is unreachable from inside the sandbox\\naction: run npm publish from your side' > "$DSH_APPROVAL_FILE" && exit ${exit}`,
    repoDir: repo, workRoot: join(dir, "work"),
    timeoutMs: 15000, maxWorkers: 1, blockedCommands: [],
  };
  return new Executor(cfg);
}

function openTicket(): void {
  const gate = evaluateGate(policy, trigger);
  engine.ingest([{ trigger, gate, resolution: resolveCandidate(policy, gate, "positive") }]);
}

const fakeChannel = (): ReplyChannel & { delivered: [string, string][] } => {
  const delivered: [string, string][] = [];
  return {
    matches: (t) => t.startsWith("wechat:"),
    deliver: async (threadId, body) => {
      delivered.push([threadId, body]);
      return { externalId: `msg:${delivered.length}` };
    },
    delivered,
  };
};

describe("the file protocol", () => {
  it("the executor exposes $DSH_APPROVAL_FILE inside the worktree", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    execSync("git init -q -b main .", { cwd: repo });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q", { cwd: repo });
    const ex = new Executor({
      command: 'echo "APPROVAL=$DSH_APPROVAL_FILE"',
      repoDir: repo, workRoot: join(dir, "work"), timeoutMs: 15000, maxWorkers: 1, blockedCommands: [],
    });
    openTicket();
    const r = await ex.run({ id: 1, threadId: trigger.threadId }, { body: "x", author: "alice" }, "o/r");
    expect(r.output).toContain("APPROVAL=");
    expect(r.output).toContain(join(".dsh", "approval-request.md"));
  });

  it("renderPrompt tells the worker about the protocol", () => {
    expect(renderPrompt({ id: 1, threadId: "t" }, { body: "x", author: "a" }, "o/r")).toContain("DSH_APPROVAL_FILE");
  });

  it("clean exit + request file → needs-person, request stored, file consumed, thread told", async () => {
    openTicket();
    const reports = await runWork(engine, askingExecutor(0), "o/r", null, []);
    expect(reports[0]).toMatchObject({ outcome: "failed", detail: expect.stringContaining("approval file") });

    const t = engine.tickets()[0];
    expect(t.state).toBe("open");
    expect(t.stage).toBe("needs-person"); // null exit = "did not complete" — the person decides
    expect(engine.workerRequest(1)).toContain("npm publish v1.2.0");

    const worktree = join(dir, "work", "ticket-1");
    expect(existsSync(join(worktree, ".dsh", "approval-request.md"))).toBe(false); // consumed
    expect(readdirSync(join(worktree, ".dsh", "approval-requested"))).toHaveLength(1);

    const fx = engine.takeDue().find((f) => f.key.startsWith("ticket-report:1"));
    const body = String((fx?.payload as { body: string }).body);
    expect(body).toContain("asked for a person");
    expect(body).toContain("npm publish v1.2.0");
  });

  it("failed exit + request file → same hold, and the exit code stays truthful", async () => {
    openTicket();
    await runWork(engine, askingExecutor(3), "o/r", null, []);
    const a = engine.db.prepare("SELECT exit_code FROM assignment ORDER BY id DESC LIMIT 1").get() as { exit_code: number };
    expect(a.exit_code).toBe(3);
    expect(engine.tickets()[0].stage).toBe("needs-person");
  });

  it("the approval surface renders the worker's request; digit 1 resumes with it as guidance", async () => {
    openTicket();
    await runWork(engine, askingExecutor(0), "o/r", null, []);
    const channel = fakeChannel();
    const rendered = await runApprovalSweep(engine, policy, [channel]);
    expect(rendered).toBe(1);
    // the outbox drains in order (ticket-open, ticket-report, approval-req) — find the ask
    const ask = channel.delivered.find(([, body]) => body.includes("[approval needed]"));
    expect(ask?.[1]).toContain("worker requested:");
    expect(ask?.[1]).toContain("npm publish v1.2.0");

    // the owner's ops thread is where digits come from (a minute after the request — inside the expiry window)
    engine.registerOpsThread("alice", "wechat:peer/wxid_ops");
    const applied = applyApproval(engine, "wechat:peer/wxid_ops", 1, new Date(Date.now() + 60_000));
    expect(applied).toBe("requeue:1");

    const claimed = engine.claimQueued(1);
    expect(claimed[0].body).toContain("owner note (approved request)");
    expect(claimed[0].body).toContain("npm publish v1.2.0");
    // the note is consumed on claim — the run after next does not see it again
    engine.requeueTicket(1);
    const again = engine.claimQueued(1);
    expect(again[0].body).not.toContain("owner note");
  });
});

describe("P1 — the shipped default agrees with init", () => {
  it("examples/executor.json ships sandbox enabled (confinement is the norm)", () => {
    const examplePath = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "executor.json");
    const example = JSON.parse(readFileSync(examplePath, "utf8")) as { sandbox: { enabled: boolean }; $comment?: string };
    expect(example.sandbox.enabled).toBe(true);
    expect(example.$comment).toContain("exception"); // the migration note ships with the flip
  });
});

describe("renderPrompt scope ethic (borrowed from the prototype's team/scope)", () => {
  const p = renderPrompt({ id: 1, threadId: "t" }, { body: "x", author: "a" }, "o/r");
  it("carries through for effort reasons, pauses for impact reasons", () => {
    expect(p).toContain("NOT reasons to stop");
    expect(p).toContain("breaking existing caller expectations");
    expect(p).toContain("Name the specific interface and caller impact");
  });
  it("drafts honestly, never fabricates", () => {
    expect(p).toContain("explicitly incomplete draft");
    expect(p).toContain("Never fabricate a PR");
  });
});
