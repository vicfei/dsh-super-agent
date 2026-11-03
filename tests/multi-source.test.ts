// Multi-source base (v0.8, issue #45) — per-source read states, the v0.7 legacy-blob migration,
// and reply routing by threadId prefix with source-scoped self-echo keys.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine.js";
import type { ReplyChannel } from "../src/source.js";
import { drainReplyEffects } from "../src/work.js";

let dir: string;
let engine: Engine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-multisrc-"));
  engine = new Engine(join(dir, "engine.db"));
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeChannel(prefix: string, externalId: string): ReplyChannel & { delivered: [string, string][] } {
  const delivered: [string, string][] = [];
  return {
    matches: (threadId) => threadId.startsWith(`${prefix}:`),
    deliver: async (threadId, body) => {
      delivered.push([threadId, body]);
      return { externalId };
    },
    delivered,
  };
}

describe("multi-source read states", () => {
  it("positions are isolated per source namespace", () => {
    engine.ingest([], { github: { positions: { issue: 5 } }, wechat: { positions: { dm: 9 } } });
    expect(engine.sourceState("github").positions.issue).toBe(5);
    expect(engine.sourceState("wechat").positions.dm).toBe(9);
    expect(engine.sourceState("slack").positions).toEqual({});
  });

  it("v0.7 legacy single positions blob reads as github's (migration on first read)", () => {
    // pre-v0.8 engines stored the raw positions record under kv 'positions' — that was GitHub's
    engine.db.prepare("INSERT INTO kv (k, v) VALUES ('positions', ?)").run(JSON.stringify({ issue: 3, issue_comment: 8 }));
    expect(engine.sourceState("github").positions).toMatchObject({ issue: 3, issue_comment: 8 });
    // and after the next ingest writes the namespaced key, both reads agree
    engine.ingest([], { github: { positions: { issue: 4 } } });
    expect(engine.sourceState("github").positions.issue).toBe(4);
    expect(engine.sourceState("wechat").positions).toEqual({});
  });
});

describe("reply routing by threadId prefix", () => {
  it("delivers each effect to its own channel; self-echo keys are source-scoped", async () => {
    const gh = fakeChannel("github", "issue_comment:100");
    const wx = fakeChannel("wechat", "msg:200");
    engine.enqueueReply("k-gh", "github:o/r/issues/5", "to github");
    engine.enqueueReply("k-wx", "wechat:peer/wxid_abc", "to wechat");

    await drainReplyEffects(engine, [gh, wx]);

    expect(gh.delivered).toEqual([["github:o/r/issues/5", "to github"]]);
    expect(wx.delivered).toEqual([["wechat:peer/wxid_abc", "to wechat"]]);
    expect(engine.takeDue()).toHaveLength(0); // both completed
    const echo = engine.selfPosted();
    expect(echo.has("github:issue_comment:100")).toBe(true);
    expect(echo.has("wechat:msg:200")).toBe(true);
  });

  it("no channel for a thread → terminal failure with the thread named", async () => {
    engine.enqueueReply("k-x", "telegram:chat/42", "nowhere to go");
    await drainReplyEffects(engine, []);
    const fx = engine.db.prepare("SELECT status, last_error FROM effect WHERE key = 'k-x'").get() as { status: string; last_error: string };
    expect(fx.status).toBe("failed");
    expect(fx.last_error).toContain("no reply channel");
    expect(fx.last_error).toContain("telegram:chat/42");
  });

  it("delivery failure retries through the outbox backoff (channel contract)", async () => {
    const flaky: ReplyChannel = {
      matches: (t) => t.startsWith("wechat:"),
      deliver: vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue({ externalId: "msg:1" }),
    };
    engine.enqueueReply("k-retry", "wechat:peer/x", "hello");
    await drainReplyEffects(engine, [flaky]);
    expect(engine.takeDue()).toHaveLength(0); // backed off, not due yet
    await new Promise((r) => setTimeout(r, 50)); // let the 5s backoff... no — takeDue only returns when due
    const row = engine.db.prepare("SELECT status, attempts FROM effect WHERE key = 'k-retry'").get() as { status: string; attempts: number };
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
  });
});
