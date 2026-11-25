// a2aSend (v2.0 slice 4) — the outbound half of the delegation channel, tested against
// dsh's OWN server (the loopback is the protocol contract: a client built from the server
// shape must complete against a server built from the same shape). Exit-code semantics are
// the child-ticket contract: 0 completed · 1 transport · 2 remote not-done · 3 wait budget.

import { execFile as execFileCb, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";
import { A2ASource, a2aSend, startA2AServer, type A2AServer } from "../src/a2a.js";

const execFile = promisify(execFileCb);

let dir: string;
let engine: Engine;
let source: A2ASource;
let server: A2AServer;
let base = "";

const policy = (): Policy => ({
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  a2a: { enabled: true, path: "/a2a", allowedAgents: ["node-sg"] },
  table: [{ scope: "a2a" as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const }],
});

function gitRepo(): string {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main .", { cwd: repo });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repo });
  return repo;
}
const cfg = (command: string): ExecutorConfig =>
  ({ command, repoDir: gitRepo(), workRoot: join(dir, "work"), timeoutMs: 30_000, maxWorkers: 4, blockedCommands: [] });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dsh-a2asend-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy());
  source = new A2ASource();
  server = await startA2AServer({ engine, source, policy: policy(), port: 0, host: "127.0.0.1", token: "t0k", log: () => {} });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/a2a`;
});
afterEach(() => {
  server.shutdown();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One remote watch cycle: drain the A2A buffer → gate → ingest → work. Explicit delegations
 *  from a registered agent never wait on an assessment (docs/002 — same as the real watch). */
async function remoteCycle(executor: Executor): Promise<void> {
  const { triggers } = await source.collect({ positions: {} });
  if (triggers.length > 0) {
    const p = engine.policy()!;
    const batch: IngestItem[] = triggers.map((t) => {
      const gate = evaluateGate(p, t);
      return { trigger: t, gate, resolution: resolveCandidate(p, gate, undefined) };
    });
    engine.ingest(batch);
  }
  await runWork(engine, executor, "o/r", null);
}

const send = (over: Partial<Parameters<typeof a2aSend>[0]> = {}) =>
  a2aSend({ url: base, token: "t0k", prompt: "do the remote work", caller: "node-sg", wait: true, intervalMs: 50, timeoutMs: 20_000, ...over });

/** Drive remote cycles in the background while a waiting send polls; the loop stops as
 *  soon as the send settles so tests don't idle out their iteration budget. */
function untilResolved(promise: Promise<{ exitCode: number }>, executor: Executor): Promise<{ exitCode: number }> {
  let settled = false;
  const loop = async () => {
    for (let i = 0; i < 400 && !settled; i++) {
      await remoteCycle(executor);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return Promise.all([promise.finally(() => { settled = true; }), loop()]).then(([r]) => r);
}

describe("a2aSend", () => {
  it("fire-and-forget returns submitted without polling", async () => {
    const r = await send({ wait: false });
    expect(r.exitCode).toBe(0);
    expect(r.state).toBe("submitted");
    const { triggers } = await source.collect({ positions: {} });
    expect(triggers).toHaveLength(1); // the delegation is buffered on the remote
  });

  it("waits a remote ticket to completed and brings the report back (exit 0)", async () => {
    const r = await untilResolved(send(), new Executor(cfg("echo remote-agent-report: done-remote-work")));
    expect(r.exitCode).toBe(0);
    expect(r.state).toBe("completed");
    expect(r.report).toContain("done-remote-work");
    expect(engine.tickets().every((t) => t.state === "ended")).toBe(true); // the remote settled it
  });

  it("a remote that needs a person is input-required — exit 2, the report still travels", async () => {
    const r = await untilResolved(send(), new Executor(cfg(`mkdir -p .dsh && printf 'title: blocked\\nreason: needs a person\\nrequested action: decide\\n' > "$DSH_APPROVAL_FILE" && echo asked-for-a-person`)));
    expect(r.exitCode).toBe(2);
    expect(r.state).toBe("input-required");
  });

  it("a wrong bearer fails loudly at the transport (exit 1), nothing buffered", async () => {
    const r = await send({ token: "wrong-token" });
    expect(r.exitCode).toBe(1);
    const { triggers } = await source.collect({ positions: {} });
    expect(triggers).toHaveLength(0);
  });

  it("an unreachable endpoint fails at the transport (exit 1)", async () => {
    const r = await send({ url: "http://127.0.0.1:1/a2a" });
    expect(r.exitCode).toBe(1);
    expect(r.state).toBe("send-failed");
  });

  it("a delegation nobody processes exhausts the wait budget (exit 3)", async () => {
    const r = await send({ timeoutMs: 200 });
    expect(r.exitCode).toBe(3);
    expect(r.state).toBe("timeout");
  });
});

describe("the CLI surface (dsh a2a send)", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const CLI = join(REPO_ROOT, "src", "cli.ts");
  const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
  // async spawn: a synchronous execFileSync would starve this thread's event loop and the
  // in-process server could never answer its own client (live finding, first run).
  const run = (extra: string[]) =>
    execFile("node", ["--import", TSX_LOADER, CLI, "a2a", "send", ...extra], { encoding: "utf8" });

  it("no --wait prints the task id and where to poll, exit 0", async () => {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "a one-shot delegation\n");
    const { stdout } = await run(["--url", base, "--token", "t0k", "--prompt-file", promptFile, "--caller", "node-sg"]);
    expect(stdout).toMatch(/task [0-9a-f-]+ submitted — poll .+\/tasks\//);
    const { triggers } = await source.collect({ positions: {} });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].author.login).toBe("node-sg"); // metadata.caller is the identity the gate sees
  });

  it("missing every token source dies loudly before any request leaves", async () => {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "x\n");
    const r = await run(["--url", base, "--prompt-file", promptFile]).catch((e: { code?: number; stderr?: string }) => e);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a2a send needs a bearer");
  });
});
