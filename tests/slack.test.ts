// Slack channel (v0.8 M8-3, issue #45) — mapper, buffer-bridged Source (injected subscribe),
// and reply routing. Same shape as the Feishu suite.

import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../src/slack.js";
import { SlackReplyChannel, SlackSource, slackTriggerFromEvent } from "../src/slack.js";

function ev(over: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U_alice",
    text: "please fix the login bug",
    ts: "1762000000.000101",
    ...over,
  };
}

describe("slackTriggerFromEvent", () => {
  it("channel message → im_group, ids stable, ts converted", () => {
    const t = slackTriggerFromEvent(ev())!;
    expect(t).toMatchObject({
      id: "slack:msg:C123/1762000000.000101",
      source: "slack",
      scope: "im_group",
      threadId: "slack:channel/C123",
      addressing: false,
      body: "please fix the login bug",
    });
    expect(t.author).toEqual({ login: "U_alice", isBot: false });
    expect(t.ts).toBe(new Date(1762000000 * 1000).toISOString());
  });

  it("DM → im_dm and inherently addressed; thread prefix differs", () => {
    const t = slackTriggerFromEvent(ev({ channel: "D123", channel_type: "im" }))!;
    expect(t.scope).toBe("im_dm");
    expect(t.addressing).toBe(true);
    expect(t.threadId).toBe("slack:dm/D123");
  });

  it("group @mention: precise with the bot id, fail-closed without it", () => {
    const mentioned = ev({ text: "<@U_bot> take a look" });
    expect(slackTriggerFromEvent(mentioned, "U_bot")!.addressing).toBe(true);
    expect(slackTriggerFromEvent(mentioned, "U_other")!.addressing).toBe(false);
    expect(slackTriggerFromEvent(mentioned)!.addressing).toBe(false);
  });

  it("bot senders are bots; subtypes other than thread_broadcast are ignored; malformed → null", () => {
    expect(slackTriggerFromEvent(ev({ bot_id: "B1" }))!.author.isBot).toBe(true);
    expect(slackTriggerFromEvent(ev({ subtype: "channel_join" }))).toBeNull();
    expect(slackTriggerFromEvent(ev({ subtype: "thread_broadcast" }))).not.toBeNull();
    expect(slackTriggerFromEvent({})).toBeNull();
    expect(slackTriggerFromEvent({ channel: "C1" })).toBeNull();
  });
});

describe("SlackSource (buffer bridge)", () => {
  it("drains pushed events once; exclude applies; malformed dropped", async () => {
    let push: ((e: SlackMessageEvent) => void) | null = null;
    const src = new SlackSource({ appToken: "xapp-1", botToken: "xoxb-1" }, async (onEvent) => { push = onEvent; });
    await src.collect({ positions: {} });
    push!(ev({ ts: "1.1" }));
    push!(ev({ ts: "2.2" }));
    push!({ type: "message", subtype: "channel_join", channel: "C", ts: "3.3" });
    const { triggers } = await src.collect({ positions: {} }, { exclude: new Set(["slack:msg:C123/1.1"]) });
    expect(triggers.map((t) => t.id)).toEqual(["slack:msg:C123/2.2"]);
    expect((await src.collect({ positions: {} })).triggers).toEqual([]);
  });
});

describe("SlackReplyChannel", () => {
  it("routes by prefix, externalId mirrors the trigger id shape", async () => {
    const sent: [string, string][] = [];
    const ch = new SlackReplyChannel(async (channel, text) => {
      sent.push([channel, text]);
      return { ts: "1762000001.000200" };
    });
    expect(ch.matches("slack:channel/C1")).toBe(true);
    expect(ch.matches("feishu:chat/oc")).toBe(false);
    const { externalId } = await ch.deliver("slack:dm/D9", "done");
    expect(externalId).toBe("msg:D9/1762000001.000200");
    expect(sent).toEqual([["D9", "done"]]);
  });
});
