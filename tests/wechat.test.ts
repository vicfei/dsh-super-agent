// WeChat channel (v0.8 M8-4, issue #45) — the iLink Bot Protocol client against a mocked fetch:
// trigger mapping, route/context_token capture, cursor semantics, -14 clearing, login flow,
// and the reply channel echoing the routing fields. No network, no real QR.

import { describe, expect, it, vi } from "vitest";
import type { WeixinMessage } from "../src/wechat.js";
import {
  EngineWechatStore,
  chunkWechatReply,
  MemoryWechatStore,
  WechatApiClient,
  WechatReplyChannel,
  WechatSource,
  wechatLogin,
  wechatTriggerFromMessage,
} from "../src/wechat.js";
import { Engine } from "../src/engine.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

function msg(over: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: "88001",
    from_user_id: "wxid_alice",
    to_user_id: "bot",
    message_type: 1,
    create_time_ms: 1762000000000,
    item_list: [{ type: 1, text_item: { text: "fix the login bug" } }],
    context_token: "ctx_tok_1",
    ...over,
  };
}

describe("wechatTriggerFromMessage", () => {
  it("DM → im_dm, inherently addressed, ids stable", () => {
    const t = wechatTriggerFromMessage(msg())!;
    expect(t).toMatchObject({
      id: "wechat:msg/88001",
      source: "wechat",
      scope: "im_dm",
      threadId: "wechat:peer/wxid_alice",
      addressing: true,
      body: "fix the login bug",
    });
    expect(t.author).toEqual({ login: "wxid_alice", isBot: false });
  });

  it("group message → im_group and fail-closed addressing; media → placeholder", () => {
    const g = wechatTriggerFromMessage(msg({ group_id: "g1", item_list: [{ type: 2 }] }))!;
    expect(g.scope).toBe("im_group");
    expect(g.threadId).toBe("wechat:group/g1");
    expect(g.addressing).toBe(false);
    expect(g.body).toBe("[2]");
  });

  it("1:1 chats carry group_id as an empty string (verified live) — still im_dm", () => {
    const t = wechatTriggerFromMessage(msg({ group_id: "" }))!;
    expect(t.scope).toBe("im_dm");
    expect(t.threadId).toBe("wechat:peer/wxid_alice");
    expect(t.addressing).toBe(true);
  });

  it("BOT traffic is never a work request (self-echo at the source); idless → null", () => {
    expect(wechatTriggerFromMessage(msg({ message_type: 2 }))).toBeNull();
    expect(wechatTriggerFromMessage({})).toBeNull();
    expect(wechatTriggerFromMessage({ seq: 7 })!.id).toBe("wechat:msg/seq-7");
  });
});

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const data = handler(url.toString(), init);
    const status = (data as { __status?: number })?.__status ?? 200;
    const body = { ...data } as Record<string, unknown>;
    delete body.__status;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("WechatSource (iLink long-poll)", () => {
  it("collects messages, advances the cursor, and stores the reply route with context_token", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    const seen: { url: string; body: Record<string, unknown>; auth: string; uin: string }[] = [];
    const fetchImpl = mockFetch((url, init) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: headers.Authorization, uin: headers["X-WECHAT-UIN"] });
      return { ret: 0, msgs: [msg()], get_updates_buf: "Y3Vyc29yMg==" };
    });
    const src = new WechatSource({ store, fetchImpl, pollTimeoutMs: 3000 });
    const { triggers } = await src.collect({ positions: {} });

    expect(triggers.map((t) => t.id)).toEqual(["wechat:msg/88001"]);
    expect(store.loadCursor()).toBe("Y3Vyc29yMg==");
    const route = store.loadRoute("wechat:peer/wxid_alice");
    expect(route).toMatchObject({ toUserId: "wxid_alice", contextToken: "ctx_tok_1" });
    // wire discipline: bearer token, per-request random UIN, base_info in the body
    expect(seen[0].url).toContain("ilink/bot/getupdates");
    expect(seen[0].auth).toBe("Bearer t0");
    expect(seen[0].uin).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect((seen[0].body.base_info as { channel_version?: string })?.channel_version).toBe("2.0.0");
    expect(seen[0].body.get_updates_buf).toBe("");

    // cursor round-trips on the next poll
    await src.collect({ positions: {} });
    expect(seen[1].body.get_updates_buf).toBe("Y3Vyc29yMg==");
  });

  it("statusless success shape (verified live): no ret field, msgs flow, cursor saved", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    const fetchImpl = mockFetch(() => ({ msgs: [msg()], get_updates_buf: "YnVmMg==" })); // no ret — the real success shape
    const src = new WechatSource({ store, fetchImpl, pollTimeoutMs: 3000 });
    const { triggers } = await src.collect({ positions: {} });
    expect(triggers.map((t) => t.id)).toEqual(["wechat:msg/88001"]);
    expect(store.loadCursor()).toBe("YnVmMg==");
    expect(store.loadRoute("wechat:peer/wxid_alice")?.contextToken).toBe("ctx_tok_1");
  });

  it("not-logged-in is a logged no-op, not a crash; -14 clears all state", async () => {
    const store = new MemoryWechatStore();
    const logs: string[] = [];
    const empty = await new WechatSource({ store, log: (l) => logs.push(l) }).collect({ positions: {} });
    expect(empty.triggers).toEqual([]);
    expect(logs[0]).toContain("wechat-login");

    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    store.saveRoute("wechat:peer/x", { toUserId: "x", contextToken: "c" });
    const fetchImpl = mockFetch(() => ({ ret: 1, errcode: -14, errmsg: "session timeout" }));
    const out = await new WechatSource({ store, fetchImpl, log: (l) => logs.push(l) }).collect({ positions: {} });
    expect(out.triggers).toEqual([]);
    expect(store.loadAuth()).toBeNull();
    expect(store.loadRoute("wechat:peer/x")).toBeNull();
    expect(logs.some((l) => l.includes("-14"))).toBe(true);
  });
});

describe("WechatReplyChannel", () => {
  it("echoes the route: to_user_id, group/session ids, and the context_token verbatim", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    store.saveRoute("wechat:group/g1", { toUserId: "wxid_alice", groupId: "g1", sessionId: "s9", contextToken: "ctx_g1" });
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = mockFetch((_u, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ret: 0, message_id: "99001" };
    });
    const ch = new WechatReplyChannel(store, (auth) => new WechatApiClient({ token: auth.token, baseUrl: auth.baseUrl, fetchImpl }));
    expect(ch.matches("wechat:group/g1")).toBe(true);
    const { externalId } = await ch.deliver("wechat:group/g1", "done: fixed");
    expect(externalId).toBe("msg/99001");
    const sent = bodies[0].msg as WeixinMessage;
    expect(sent.to_user_id).toBe("wxid_alice");
    expect(sent.group_id).toBe("g1");
    expect(sent.session_id).toBe("s9");
    expect(sent.message_type).toBe(2);
    expect(sent.message_state).toBe(2); // FINISH — the protocol's terminal send state
    expect(sent.client_id).toMatch(/[0-9a-f-]{36}/); // per-message uuid — the protocol's dedup key
    expect(sent.context_token).toBe("ctx_g1");
    expect(sent.item_list?.[0]?.text_item?.text).toBe("done: fixed");
  });

  it("every outbound message carries a UNIQUE client_id — same/absent ids get server-deduped into the void (live finding 2026-11-05: first message lands, the rest vanish, API still returns message_id)", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    store.saveRoute("wechat:peer/a", { toUserId: "a", contextToken: "ctx" });
    const clientIds: string[] = [];
    const fetchImpl = mockFetch((_u, init) => {
      const msg = JSON.parse(String(init?.body)).msg as WeixinMessage;
      clientIds.push(msg.client_id ?? "");
      return { message_id: `m${clientIds.length}` };
    });
    const ch = new WechatReplyChannel(store, (auth) => new WechatApiClient({ token: auth.token, baseUrl: auth.baseUrl, fetchImpl }));
    await ch.deliver("wechat:peer/a", "one"); // first message
    await ch.deliver("wechat:peer/a", "two"); // second message seconds later — must NOT dedup away
    await ch.deliver("wechat:peer/a", "p ".repeat(1200)); // chunked → multiple parts, each unique too
    expect(clientIds.length).toBeGreaterThan(3);
    expect(new Set(clientIds).size).toBe(clientIds.length); // all unique, none empty
  });

  it("statusless sendmessage success (verified live): absent ret = delivered", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    store.saveRoute("wechat:peer/wxid_alice", { toUserId: "wxid_alice", contextToken: "ctx" });
    const fetchImpl = mockFetch(() => ({ message_id: "77" })); // no ret — the real success shape
    const ch = new WechatReplyChannel(store, (auth) => new WechatApiClient({ token: auth.token, baseUrl: auth.baseUrl, fetchImpl }));
    await expect(ch.deliver("wechat:peer/wxid_alice", "hi")).resolves.toMatchObject({ externalId: "msg/77" });
  });

  it("no route → clear error (thread never sent us anything)", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    const ch = new WechatReplyChannel(store, (auth) => new WechatApiClient({ token: auth.token, baseUrl: auth.baseUrl }));
    await expect(ch.deliver("wechat:peer/ghost", "hi")).rejects.toThrow(/no wechat route/);
  });
});

describe("chunkWechatReply + chunked delivery", () => {
  it("short stays whole; long splits at boundaries, parts reassemble losslessly", () => {
    expect(chunkWechatReply("short")).toEqual(["short"]);
    const paras = Array.from({ length: 30 }, (_, i) => `paragraph ${i} ${"x".repeat(90)}`).join("\n\n");
    const parts = chunkWechatReply(paras);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1800);
    expect(parts.join("\n\n").replace(/\n+/g, "\n")).toContain("paragraph 29");
  });

  it("the channel sends each part as its own message, same context_token", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth({ token: "t0", baseUrl: "https://ilink.test" });
    store.saveRoute("wechat:peer/a", { toUserId: "a", contextToken: "ctx" });
    const bodies: { text: string; token: string }[] = [];
    let id = 0;
    const fetchImpl = mockFetch((_u, init) => {
      const msg = (JSON.parse(String(init?.body)).msg) as WeixinMessage;
      bodies.push({ text: msg.item_list![0]!.text_item!.text!, token: msg.context_token! });
      return { message_id: `m${++id}` };
    });
    const ch = new WechatReplyChannel(store, (auth) => new WechatApiClient({ token: auth.token, baseUrl: auth.baseUrl, fetchImpl }));
    await ch.deliver("wechat:peer/a", "p1 ".repeat(1200)); // ~3600 chars → 2-3 parts
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((b) => b.token === "ctx")).toBe(true);
    expect(bodies.map((b) => b.text).join("").replace(/ /g, "")).toContain("p1p1");
  });
});

describe("wechatLogin (QR flow)", () => {
  it("fetches the QR, polls until confirmed, returns credentials + returned baseurl", async () => {
    let calls = 0;
    const fetchImpl = mockFetch((url) => {
      if (url.includes("get_bot_qrcode")) return { qrcode: "QRID", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" };
      calls++;
      return calls === 1 ? { status: "scaned" } : { status: "confirmed", bot_token: "tok_1", baseurl: "https://ilink.redirected" };
    });
    const qrs: { qrcode: string; imgContent: string }[] = [];
    const auth = await wechatLogin((qr) => qrs.push({ qrcode: qr.qrcode, imgContent: qr.imgContent }), { fetchImpl, pollMs: 1 });
    expect(qrs).toEqual([{ qrcode: "QRID", imgContent: "https://liteapp.weixin.qq.com/q/x" }]);
    expect(auth).toEqual({ token: "tok_1", baseUrl: "https://ilink.redirected" });
  });

  it("expired QR throws with a re-run hint", async () => {
    const fetchImpl = mockFetch((url) => (url.includes("get_bot_qrcode") ? { qrcode: "QRID" } : { status: "expired" }));
    await expect(wechatLogin(() => {}, { fetchImpl, pollMs: 1 })).rejects.toThrow(/expired/);
  });
});

describe("EngineWechatStore", () => {
  let dir: string;
  let engine: Engine;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-wechat-"));
    engine = new Engine(join(dir, "engine.db"));
  });
  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists auth/cursor/routes over kv; clearAll wipes wechat keys only", () => {
    const store = new EngineWechatStore(engine);
    engine.kvSet("unrelated", "keep");
    store.saveAuth({ token: "t", baseUrl: "b" });
    store.saveCursor("c1");
    store.saveRoute("wechat:peer/x", { toUserId: "x", contextToken: "c" });

    const store2 = new EngineWechatStore(engine);
    expect(store2.loadAuth()).toEqual({ token: "t", baseUrl: "b" });
    expect(store2.loadCursor()).toBe("c1");
    expect(store2.loadRoute("wechat:peer/x")?.contextToken).toBe("c");

    store2.clearAll();
    expect(store2.loadAuth()).toBeNull();
    expect(store2.loadCursor()).toBe("");
    expect(store2.loadRoute("wechat:peer/x")).toBeNull();
    expect(engine.kvGet("unrelated")).toBe("keep");
  });
});

describe("typing heartbeat (v1.2.1)", () => {
  const auth = { token: "t0", baseUrl: "https://ilink.test" };
  const polling = { msgs: [], get_updates_buf: "cur1" }; // statusless success shape

  function heartbeats(fetchImpl: typeof fetch) {
    return (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .map(([u, init]) => ({ url: u, body: String(init?.body ?? "") }))
      .filter((c) => c.url.includes("typing") || c.url.includes("getconfig"));
  }

  it("fires on a cold session (getconfig → typing on → off) and persists the throttle in positions", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth(auth);
    store.kvSet("wechat_binder", "ilink-1");
    const fetchImpl = mockFetch((url) =>
      url.includes("getconfig") ? { ret: 0, typing_ticket: "tk1" }
      : url.includes("sendtyping") ? { ret: 0 }
      : polling);
    const src = new WechatSource({ store, fetchImpl, pollTimeoutMs: 100, typingEveryMs: 60_000 });
    const { next } = await src.collect({ positions: {} }, {});
    const calls = heartbeats(fetchImpl as unknown as typeof fetch);
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining("getconfig"),
      expect.stringContaining("sendtyping"),
      expect.stringContaining("sendtyping"),
    ]);
    expect(next.positions.typingAt).toBeGreaterThan(0);
  });

  it("throttled within the interval — no second heartbeat", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth(auth);
    store.kvSet("wechat_binder", "ilink-1");
    const fetchImpl = mockFetch((url) =>
      url.includes("getconfig") ? { ret: 0, typing_ticket: "tk1" }
      : url.includes("sendtyping") ? { ret: 0 }
      : polling);
    const src = new WechatSource({ store, fetchImpl, pollTimeoutMs: 100, typingEveryMs: 60_000 });
    const { next } = await src.collect({ positions: { typingAt: Date.now() } }, {});
    expect(heartbeats(fetchImpl as unknown as typeof fetch)).toHaveLength(0);
    expect(next.positions.typingAt).toBeGreaterThan(Date.now() - 60_000); // passthrough untouched
  });

  it("a failing heartbeat marks the throttle anyway (never becomes its own storm) and never breaks polling", async () => {
    const store = new MemoryWechatStore();
    store.saveAuth(auth);
    store.kvSet("wechat_binder", "ilink-1");
    const fetchImpl = mockFetch((url) =>
      url.includes("getconfig") ? { ret: -2, errmsg: "no" }
      : polling);
    const src = new WechatSource({ store, fetchImpl, pollTimeoutMs: 100, typingEveryMs: 60_000 });
    const { triggers, next } = await src.collect({ positions: {} }, {});
    expect(triggers).toHaveLength(0); // polling unaffected
    expect(next.positions.typingAt).toBeGreaterThan(0); // throttled despite failure
  });
});
