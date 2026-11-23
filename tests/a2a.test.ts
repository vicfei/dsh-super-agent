// A2A channel (v2.0 Phase 3, #176): external agents knock through the SAME admission table.
// The protocol carries no admission — the tests prove dsh supplies the constitution:
// bearer is transport auth, the caller identity is admission input, unlisted callers are
// evidence, and the relay pushes to registered callbacks only.

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateGate } from "../src/gate.js";
import { agentCardOf, a2aTriggerFromMessage, A2ASource, A2AReplyChannel, startA2AServer } from "../src/a2a.js";

let dir: string;
let engine: Engine;

const policy = (): Policy => ({
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "auto",
  a2a: { enabled: true, path: "/a2a", allowedAgents: ["node-wsl2"] },
  table: [
    // the a2a row: a registered agent's delegation is explicit-capable; an unlisted one
    // falls to the unlisted cell — recorded as evidence, never executed in observe
    { scope: "a2a" as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const },
  ],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-a2a-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy());
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a2aTriggerFromMessage", () => {
  it("maps message/send params into an a2a-scope trigger with the caller identity", () => {
    const t = a2aTriggerFromMessage(
      { id: "task-42", message: { role: "user", parts: [{ kind: "text", text: "fix the flaky test" }], metadata: { caller: "node-wsl2" } } },
      "",
    )!;
    expect(t).toMatchObject({
      id: "a2a:task/task-42", source: "a2a", scope: "a2a",
      threadId: "a2a:node-wsl2/task-42", addressing: true, body: "fix the flaky test",
    });
    expect(t.author).toEqual({ login: "node-wsl2", isBot: false });
  });
  it("a non-text part rides as the [kind] placeholder (wechat posture), no text at all → null", () => {
    const file = a2aTriggerFromMessage({ message: { parts: [{ kind: "file" }] } }, "x")!;
    expect(file.body).toBe("[file]");
    expect(a2aTriggerFromMessage({ message: { parts: [] } }, "x")).toBeNull();
  });
});

describe("the admission constitution", () => {
  it("a registered agent's delegation evaluates as a candidate; an unlisted one is evidence", () => {
    const listed = evaluateGate(policy(), a2aTriggerFromMessage({ message: { parts: [{ kind: "text", text: "w" }], metadata: { caller: "node-wsl2" } } }, "")!);
    expect(listed.strength).toBe("explicit"); // allowedAgents member addressing — the strong tier
    const unlisted = evaluateGate(policy(), a2aTriggerFromMessage({ message: { parts: [{ kind: "text", text: "w" }], metadata: { caller: "stranger-agent" } } }, "")!);
    expect(unlisted.strength).toBeNull(); // unlistedAddressing=ignore — fail closed, still evidence
  });
});

describe("startA2AServer", () => {
  let base = "";
  const source = new A2ASource();
  let shutdown = () => {};

  beforeEach(async () => {
    const srv = await startA2AServer({ engine, source, policy: policy(), port: 0, host: "127.0.0.1", token: "s3cret-a2a", log: () => {} });
    const addr = srv.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    shutdown = () => srv.shutdown();
  });
  afterEach(() => shutdown());

  const rpc = (body: unknown, token = "s3cret-a2a") =>
    fetch(`${base}/a2a`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it("every request requires the bearer token — the page too, wrong token too", async () => {
    expect((await fetch(`${base}/a2a`)).status).toBe(401);
    expect((await rpc({}, "wrong")).status).toBe(401);
  });

  it("serves the Agent Card at the well-known path", async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`, { headers: { authorization: "Bearer s3cret-a2a" } });
    const card = (await res.json()) as { name: string; securitySchemes: Record<string, unknown>; skills: unknown[] };
    expect(card.name).toBe("dsh-super-agent");
    expect(card.securitySchemes.bearer).toBeDefined();
    expect(card.skills.length).toBeGreaterThan(0);
    expect(agentCardOf(policy(), "http://x").capabilities.pushNotifications).toBe(true);
  });

  it("message/send buffers an a2a trigger and answers submitted; push config lands in the engine", async () => {
    const res = await rpc({
      jsonrpc: "2.0", id: 7, method: "message/send",
      params: {
        id: "task-42",
        message: { role: "user", parts: [{ kind: "text", text: "summarize the ledger" }], metadata: { caller: "node-wsl2" } },
        configuration: { pushNotificationConfig: { url: "http://127.0.0.1:1/callback" } },
      },
    });
    const out = (await res.json()) as { result: { task: { id: string; state: string } } };
    expect(out.result.task).toMatchObject({ id: "task-42", state: "submitted" });
    const drained = await source.collect({ positions: {} });
    expect(drained.triggers).toHaveLength(1);
    expect(drained.triggers[0]).toMatchObject({ scope: "a2a", body: "summarize the ledger" });
    expect(engine.kvGet("a2a-push:task-42")).toBe("http://127.0.0.1:1/callback");
  });

  it("an unlisted caller's delegation is still buffered — the gate records the ignore as evidence", async () => {
    await rpc({ jsonrpc: "2.0", id: 8, method: "message/send", params: { id: "t9", message: { parts: [{ kind: "text", text: "let me in" }], metadata: { caller: "stranger-agent" } } } });
    const drained = await source.collect({ positions: {} });
    expect(drained.triggers).toHaveLength(1); // evidence, not enforcement at the transport
    const gate = evaluateGate(policy(), drained.triggers[0]);
    expect(gate.strength).toBeNull(); // the gate records the ignore — fail closed
  });

  it("unknown JSON-RPC methods answer -32601; task status reflects the ticket lifecycle", async () => {
    const bad = await rpc({ jsonrpc: "2.0", id: 1, method: "message/stream", params: {} });
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32601);
    const status = await fetch(`${base}/a2a/tasks/task-42`, { headers: { authorization: "Bearer s3cret-a2a" } });
    expect(((await status.json()) as { state: string }).state).toBe("unknown"); // no ticket yet
  });

  it("the relay pushes to the registered callback; without one it stays pollable", async () => {
    const received: unknown[] = [];
    const cb = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { received.push(JSON.parse(b)); res.end(); });
    });
    await new Promise<void>((r) => cb.listen(0, "127.0.0.1", r));
    const port = (cb.address() as { port: number }).port;
    engine.kvSet("a2a-push:task-99", `http://127.0.0.1:${port}/cb`);
    const ch = new A2AReplyChannel(engine);
    expect(ch.matches("a2a:node-wsl2/task-99")).toBe(true);
    const { externalId } = await ch.deliver("a2a:node-wsl2/task-99", "the work is done");
    expect(externalId).toContain("a2a-update");
    expect((received[0] as { params: { taskId: string; state: string } }).params).toMatchObject({ taskId: "task-99", state: "completed" });
    cb.close();
  });
});
