// Telegram channel (v0.8.1, issue #51) — mapper, offset-cursor long-poll source, getMe
// discovery, and replies; all against a mocked fetch (official Bot API shapes).

import { describe, expect, it, vi } from "vitest";
import type { TgMessage } from "../src/telegram.js";
import {
  TelegramClient,
  TelegramReplyChannel,
  TelegramSource,
  telegramTriggerFromMessage,
} from "../src/telegram.js";

function m(over: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 501,
    date: 1762000000,
    chat: { id: -100200, type: "supergroup" },
    from: { id: 42, username: "alice", is_bot: false },
    text: "please fix the login bug",
    ...over,
  };
}

describe("telegramTriggerFromMessage", () => {
  it("group message → im_group, ids stable, ts converted", () => {
    const t = telegramTriggerFromMessage(m())!;
    expect(t).toMatchObject({
      id: "telegram:msg/-100200/501",
      source: "telegram",
      scope: "im_group",
      threadId: "telegram:chat/-100200",
      addressing: false,
      body: "please fix the login bug",
    });
    expect(t.author).toEqual({ login: "alice", isBot: false });
  });

  it("DM → im_dm and inherently addressed; login falls back to numeric id", () => {
    const t = telegramTriggerFromMessage(m({ chat: { id: 77, type: "private" }, from: { id: 9, is_bot: false } }))!;
    expect(t.scope).toBe("im_dm");
    expect(t.addressing).toBe(true);
    expect(t.author.login).toBe("9");
  });

  it("group @mention: precise with the bot username, fail-closed without it", () => {
    const mentioned = m({ text: "@my_bot take a look" });
    expect(telegramTriggerFromMessage(mentioned, "my_bot")!.addressing).toBe(true);
    expect(telegramTriggerFromMessage(mentioned, "other_bot")!.addressing).toBe(false);
    expect(telegramTriggerFromMessage(mentioned)!.addressing).toBe(false);
  });

  it("bot senders are bots; media captions marked; malformed → null", () => {
    expect(telegramTriggerFromMessage(m({ from: { id: 1, username: "spam", is_bot: true } }))!.author.isBot).toBe(true);
    const cap = telegramTriggerFromMessage(m({ text: undefined, caption: "the error screenshot" }))!;
    expect(cap.body).toBe("[caption] the error screenshot");
    expect(telegramTriggerFromMessage({})).toBeNull();
    expect(telegramTriggerFromMessage({ message_id: 1 })).toBeNull();
  });
});

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const data = handler(url.toString(), init);
    return new Response(JSON.stringify({ ok: true, ...(data as object) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("TelegramSource (offset long-poll)", () => {
  it("discovers the bot via getMe, maps updates, advances the offset, excludes echoes", async () => {
    let offset = 0;
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = mockFetch((url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/getMe")) return { result: { id: 1, username: "my_bot" } };
      return { result: [{ update_id: 100, message: m({ text: "@my_bot do it" }) }, { update_id: 101, message: m({ message_id: 502 }) }] };
    });
    const logs: string[] = [];
    const src = new TelegramSource({
      token: "T0K",
      loadOffset: () => offset,
      saveOffset: (o) => (offset = o),
      fetchImpl,
      pollTimeoutMs: 3000,
      log: (l) => logs.push(l),
    });
    const { triggers } = await src.collect({ positions: {} }, { exclude: new Set(["telegram:msg/-100200/502"]) });
    expect(triggers.map((t) => [t.id, t.addressing])).toEqual([["telegram:msg/-100200/501", true]]);
    expect(offset).toBe(102); // last update_id + 1
    expect(logs[0]).toContain("@my_bot");
    // wire discipline: offset + server-side timeout + allowed_updates
    const poll = bodies.find((b) => "offset" in b)!;
    expect(poll.offset).toBe(0);
    expect(poll.timeout).toBe(3);
    expect(poll.allowed_updates).toEqual(["message"]);
  });

  it("self-abort on timeout returns empty without moving the offset (lossless)", async () => {
    let offset = 55;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().endsWith("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "my_bot" } }), { status: 200 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const src = new TelegramSource({ token: "T", loadOffset: () => offset, saveOffset: (o) => (offset = o), fetchImpl, pollTimeoutMs: 60 });
    const { triggers } = await src.collect({ positions: {} });
    expect(triggers).toEqual([]);
    expect(offset).toBe(55);
  });
});

describe("TelegramReplyChannel", () => {
  it("routes by prefix, sends to the chat, externalId mirrors the trigger id shape", async () => {
    const sent: { chat: number; text: string }[] = [];
    const fetchImpl = mockFetch((url, init) => {
      const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
      sent.push({ chat: body.chat_id, text: body.text });
      return { result: { message_id: 601 } };
    });
    const client = new TelegramClient({ token: "T", fetchImpl });
    const ch = new TelegramReplyChannel(() => client, (threadId) => Number(threadId.split("/")[1]));
    expect(ch.matches("telegram:chat/-100200")).toBe(true);
    expect(ch.matches("wechat:peer/x")).toBe(false);
    const { externalId } = await ch.deliver("telegram:chat/-100200", "done: fixed");
    expect(externalId).toBe("msg/-100200/601");
    expect(sent).toEqual([{ chat: -100200, text: "done: fixed" }]);
  });
});
