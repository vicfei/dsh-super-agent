// Feishu channel (v0.8 M8-2, issue #45) — the pure event→Trigger mapper, the buffer-bridged
// Source (via an injected subscription — no real app needed), and the reply channel routing.

import { describe, expect, it } from "vitest";
import type { FeishuReceiveEvent } from "../src/feishu.js";
import { FeishuReplyChannel, FeishuSource, feishuTriggerFromEvent } from "../src/feishu.js";

function event(over: Partial<FeishuReceiveEvent> = {}): FeishuReceiveEvent {
  return {
    sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello there" }),
      create_time: "1762000000000",
    },
    ...over,
  };
}

describe("feishuTriggerFromEvent", () => {
  it("p2p text → im_dm, inherently addressed, ids stable", () => {
    const t = feishuTriggerFromEvent(event())!;
    expect(t).toMatchObject({
      id: "feishu:msg:om_1",
      source: "feishu",
      scope: "im_dm",
      threadId: "feishu:chat/oc_1",
      addressing: true,
      body: "hello there",
    });
    expect(t.author).toEqual({ login: "ou_alice", isBot: false });
    expect(t.ts).toBe(new Date(1762000000000).toISOString());
  });

  it("group + mention of the bot → addressing; without the bot's id it fails closed", () => {
    const mentions = [{ id: { open_id: "ou_bot" } }, { id: { open_id: "ou_other" } }];
    const group = { chat_type: "group" as const, mentions };
    expect(feishuTriggerFromEvent(event({ message: { ...event().message, ...group } }), "ou_bot")!.addressing).toBe(true);
    expect(feishuTriggerFromEvent(event({ message: { ...event().message, ...group } }), "ou_unknown")!.addressing).toBe(false);
    expect(feishuTriggerFromEvent(event({ message: { ...event().message, ...group } }))!.addressing).toBe(false);
  });

  it("group without botOpenId configured is never addressing (fail-closed, inferred path remains)", () => {
    const t = feishuTriggerFromEvent(event({ message: { ...event().message, chat_type: "group", mentions: [{ id: { open_id: "ou_x" } }] } }))!;
    expect(t.addressing).toBe(false);
    expect(t.scope).toBe("im_group");
  });

  it("app senders are bots (gate caps them at inferred); media becomes a placeholder", () => {
    const bot = feishuTriggerFromEvent(event({ sender: { sender_id: { open_id: "ou_app" }, sender_type: "app" } }))!;
    expect(bot.author.isBot).toBe(true);
    const media = feishuTriggerFromEvent(event({ message: { ...event().message, message_type: "image", content: "" } }))!;
    expect(media.body).toBe("[image]");
  });

  it("malformed events map to null, not to half-triggers", () => {
    expect(feishuTriggerFromEvent({})).toBeNull();
    expect(feishuTriggerFromEvent({ message: { chat_id: "oc" } })).toBeNull();
  });
});

describe("FeishuSource (buffer bridge)", () => {
  it("buffers pushed events and drains once via collect; exclude applies; second collect empty", async () => {
    let push: ((e: FeishuReceiveEvent) => void) | null = null;
    const src = new FeishuSource(
      { appId: "a", appSecret: "s" },
      async (onEvent) => { push = onEvent; },
    );
    const first = await src.collect({ positions: {} });
    expect(first.triggers).toEqual([]);
    push!({ ...event(), message: { ...event().message!, message_id: "om_a" } });
    push!({ ...event(), message: { ...event().message!, message_id: "om_b" } });
    push!({ message: { chat_id: "oc" } }); // malformed → dropped

    const { triggers } = await src.collect({ positions: {} }, { exclude: new Set(["feishu:msg:om_a"]) });
    expect(triggers.map((t) => t.id)).toEqual(["feishu:msg:om_b"]);
    expect((await src.collect({ positions: {} })).triggers).toEqual([]);
  });
});

describe("FeishuReplyChannel", () => {
  it("routes by prefix, extracts the chat id, externalId is msg:<id>", async () => {
    const sent: [string, string][] = [];
    const ch = new FeishuReplyChannel(async (chatId, text) => {
      sent.push([chatId, text]);
      return { messageId: "om_reply" };
    });
    expect(ch.matches("feishu:chat/oc_1")).toBe(true);
    expect(ch.matches("github:o/r/issues/1")).toBe(false);
    const { externalId } = await ch.deliver("feishu:chat/oc_1", "done");
    expect(externalId).toBe("msg:om_reply");
    expect(sent).toEqual([["oc_1", "done"]]);
  });

  it("a thread without a chat id fails loudly", async () => {
    const ch = new FeishuReplyChannel(async () => ({ messageId: "x" }));
    await expect(ch.deliver("feishu:weird", "x")).rejects.toThrow(/cannot resolve chat id/);
  });
});
