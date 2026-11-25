// Node-routed delegation (v2.0 slice 4) — the full chain end to end, with dsh's own A2A
// server standing in for the remote node (a real HTTP hop, real protocol, real CLI): a
// parent worker writes delegate.md with `node:` → the engine opens children routed to that
// node → the child's executor template branches on $DSH_TARGET_URL and runs
// `dsh a2a send --wait` → the remote node's gate/ingest/work settle the delegation → the
// client's report becomes the child's assignment output → the last child completes the
// parent. Plus the failure postures: an unresolvable node parks the parent (config errors
// are child failures — the team's failure has one owner).

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { Executor, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";
import { parseDelegation } from "../src/teams.js";
import { A2ASource, startA2AServer, type A2AServer } from "../src/a2a.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
// tsx's loader entry is pinned by the devDependency range; if a tsx upgrade moves it, fail
// loudly here rather than with an opaque ENOENT inside every executor template.
const requireTsx = () => {
  if (!existsSync(TSX_LOADER)) throw new Error(`tsx loader not found at ${TSX_LOADER} — adjust this suite on a tsx upgrade`);
};

const TOKEN = "t0k";
const CALLER = "node-sg";
let dir: string;
let engine: Engine; // the LOCAL engine (parent + children)
let seq = 0;
const THREAD = "github:o/r/issues/7";

const policyOf = (endpoints: Record<string, string>): Policy => ({
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "auto",
  teams: { enabled: true, maxChildren: 4, endpoints },
  table: ["issue"].map((s) => ({
    scope: s as never, listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-teams-node-"));
  engine = new Engine(join(dir, "engine.db"));
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function gitRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main .", { cwd: repo });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repo });
  return repo;
}
const cfg = (command: string, name = "repo"): ExecutorConfig =>
  ({ command, repoDir: gitRepo(name), workRoot: join(dir, `work-${name}`), timeoutMs: 90_000, maxWorkers: 4, blockedCommands: [] });

function acceptItem(): IngestItem {
  const t: Trigger = {
    id: `github:issue:${++seq}`, source: "github", scope: "issue", threadId: THREAD,
    author: { login: "alice", isBot: false }, addressing: true, body: `task ${seq}`, ts: "2026-11-24T00:00:00Z",
  };
  const gate = evaluateGate(engine.policy()!, t);
  return { trigger: t, gate, resolution: resolveCandidate(engine.policy()!, gate, "positive") };
}

const ledgerRows = (kind: string) => engine.ledger.eventsAfter(0, 500).filter((e) => e.kind === kind);

/** The executor command an operator would write: one template, two halves — a local worker
 *  when the ticket is not routed, the thin A2A client when $DSH_TARGET_URL says otherwise. */
const routedTemplate = (): string => [
  `if [ -n "$DSH_TARGET_URL" ]; then`,
  `  exec node --import ${JSON.stringify(TSX_LOADER)} ${JSON.stringify(CLI)} a2a send --url "$DSH_TARGET_URL" --token ${TOKEN} --prompt-file "$DSH_PROMPT_FILE" --wait --interval 1 --caller ${CALLER};`,
  `fi`,
  `mkdir -p .dsh && printf '%s\\n' 'title: sub work' 'reason: independent piece' 'prompt: do the remote sub-work' 'count: 1' 'node: wsl2' > "$DSH_DELEGATE_FILE" && echo parent-worked`,
].join("\n");

/** The remote node: its own engine + A2A endpoint. `cycle()` is one watch pass over the
 *  delegation channel — explicit callers need no assessment, exactly like the daemon. */
async function remoteNode(): Promise<{ url: string; cycle: () => Promise<void>; shutdown: () => void }> {
  const rdir = mkdtempSync(join(tmpdir(), "dsh-teams-remote-"));
  const rengine = new Engine(join(rdir, "engine.db"));
  rengine.setPolicyIfChanged({
    version: 1, allowedList: [], botList: [], acceptMode: "auto",
    a2a: { enabled: true, path: "/a2a", allowedAgents: [CALLER] },
    table: [{ scope: "a2a" as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const }],
  } as Policy);
  const source = new A2ASource();
  const server = await startA2AServer({ engine: rengine, source, policy: rengine.policy()!, port: 0, host: "127.0.0.1", token: TOKEN, log: () => {} });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/a2a`;
  const remoteExec = new Executor(cfg("echo remote-agent-report: done-remote-work", "rrepo"));
  const cycle = async () => {
    const { triggers } = await source.collect({ positions: {} });
    if (triggers.length > 0) {
      const p = rengine.policy()!;
      rengine.ingest(triggers.map((t) => {
        const gate = evaluateGate(p, t);
        return { trigger: t, gate, resolution: resolveCandidate(p, gate, undefined) };
      }));
    }
    await runWork(rengine, remoteExec, "o/r", null);
  };
  return { url, cycle, shutdown: () => { server.shutdown(); rengine.close(); rmSync(rdir, { recursive: true, force: true }); } };
}

describe("parseDelegation node routing", () => {
  it("parses an optional node field (case-insensitive, slug-validated); absent = local", () => {
    expect(parseDelegation("title: T\nreason: R\nprompt: p\ncount: 2\nnode: wsl2")).toEqual({ title: "T", reason: "R", prompt: "p", count: 2, node: "wsl2" });
    expect(parseDelegation("title: T\nprompt: p\nnode: WSL2")!.node).toBe("wsl2");
    expect(parseDelegation("title: T\nprompt: p")).not.toHaveProperty("node");
    expect(parseDelegation("title: T\nprompt: p\nnode: not a slug!")!.node).toBeUndefined(); // invalid → local, never a bad route
  });
});

describe("node-routed delegation through runWork", () => {
  it("parent delegates with node: → the child runs over A2A at the remote node → report back → parent settles", async () => {
    requireTsx();
    const remote = await remoteNode();
    try {
      engine.setPolicyIfChanged(policyOf({ wsl2: remote.url }));
      engine.ingest([acceptItem()]);
      const r1 = await runWork(engine, new Executor(cfg(routedTemplate())), "o/r", null);
      expect(r1[0].detail).toMatch(/delegated to 1 child ticket\(s\)/);
      const parent = engine.tickets().find((t) => t.id === 1)!;
      expect(parent.stage).toBe("waiting-children");
      const child = engine.tickets().find((t) => t.parent === 1)!;
      expect(child.targetNode).toBe("wsl2"); // the tree carries the route
      expect(engine.ticketTargetNode(child.id)).toBe("wsl2");
      expect((ledgerRows("ticket.delegated")[0].payload as { node?: string }).node).toBe("wsl2");

      // the remote node keeps cycling while the child's `--wait` client polls it
      let childSettled = false;
      const remoteLoop = (async () => {
        for (let i = 0; i < 200 && !childSettled; i++) {
          await remote.cycle();
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
      const r2 = await runWork(engine, new Executor(cfg(routedTemplate())), "o/r", null); // claims the routed child, blocks in send --wait
      childSettled = true;
      await remoteLoop;

      expect(r2[0].outcome).toBe("done"); // the remote completed → exit 0
      const childAfter = engine.tickets().find((t) => t.parent === 1)!;
      expect(childAfter.state).toBe("ended");
      expect(engine.tickets().find((t) => t.id === 1)!.state).toBe("ended"); // the parent ends with the team
      const out = (engine.db.prepare("SELECT output FROM assignment WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(childAfter.id) as { output: string }).output;
      expect(out).toContain("done-remote-work"); // the remote's report IS the child's assignment output
      expect(ledgerRows("ticket.children-settled")).toHaveLength(1);
    } finally {
      remote.shutdown();
    }
  }, 60_000);

  it("a node with no endpoint in policy is a config error: child refused, parent parked for a person", async () => {
    engine.setPolicyIfChanged(policyOf({})); // wsl2 deliberately unmapped
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg(routedTemplate())), "o/r", null); // parent delegates to node: wsl2
    const r2 = await runWork(engine, new Executor(cfg("echo never-runs")), "o/r", null);
    expect(r2[0].outcome).toBe("refused");
    expect(r2[0].detail).toContain("no endpoint in policy.teams.endpoints");
    expect(engine.tickets().find((t) => t.id === 1)!.stage).toBe("needs-person"); // the parent parks — one owner per team failure
    expect(ledgerRows("ticket.child-failed")).toHaveLength(1);
    expect(engine.claimQueued(5)).toHaveLength(0); // parked pair: nothing claimable
  });

  it("a delegation without node: stays local — the template's else-half runs (regression)", async () => {
    engine.setPolicyIfChanged(policyOf({ wsl2: "http://127.0.0.1:1/a2a" }));
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg(
      `mkdir -p .dsh && printf '%s\\n' 'title: sub work' 'reason: local piece' 'prompt: do the local sub-work' 'count: 1' > "$DSH_DELEGATE_FILE" && echo parent-worked`,
    )), "o/r", null);
    const child = engine.tickets().find((t) => t.parent === 1)!;
    expect(child.targetNode).toBeUndefined();
    const r2 = await runWork(engine, new Executor(cfg(routedTemplate())), "o/r", null); // no DSH_TARGET_URL → local half
    expect(r2[0].outcome).toBe("done");
    expect(engine.tickets().find((t) => t.id === 1)!.state).toBe("ended");
  });
});
