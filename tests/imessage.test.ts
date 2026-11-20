// iMessage channel (v1.10 P2-2, #162) — the whole bridge tests on any OS via an injected
// osascript runner. Posture assertions matter as much as plumbing: watchlist-only polling,
// fail-closed groups, isFromMe never triggers, baseline-no-replay.

import { describe, expect, it } from "vitest";
import {
  asQuoted, imessageTriggerFromMessage, ImessageReplyChannel, ImessageSource,
  MemoryImessageStore, parseChatScan, parseMessageLine, SCAN_CHATS_SCRIPT, sendScript,
  type ImessageChat, type OsascriptRunner,
} from "../src/imessage.js";
import type { SourceState } from "../src/source.js";

const FROM: SourceState = { positions: {} };

const CHAT_SCAN = [
  "iMessage;-;+15550001111;-;chatA\t1\t+15550001111",
  "iMessage;+;8615550002222;+;chatB\t3\t+15550002222,+15550003333,+15550004444",
  "",
].join("\n");

function chatOf(guid: string, participants: number): ImessageChat {
  return { guid, participants, handles: [] };
}

describe("parsing", () => {
  it("message TSV roundtrips escaped newlines and tabs", () => {
    const m = parseMessageLine("iMessage;-;+1;-;x\t+15550001111\t0\tline1\\nline2\\tindented");
    expect(m).toMatchObject({ sender: "+15550001111", isFromMe: false, text: "line1\nline2\tindented" });
  });

  it("chat scan parses guid, participant count, handle list", () => {
    const chats = parseChatScan(CHAT_SCAN);
    expect(chats).toHaveLength(2);
    expect(chats[1]).toEqual({ guid: "iMessage;+;8615550002222;+;chatB", participants: 3, handles: ["+15550002222", "+15550003333", "+15550004444"] });
  });

  it("send script escapes quotes and backslashes", () => {
    expect(sendScript("g", 'say "hi" \\ done')).toContain('send "say \\"hi\\" \\\\ done" to chat id "g"');
  });
});

describe("trigger mapping", () => {
  it("a DM is im_dm, inherently addressed, a peer thread", () => {
    const t = imessageTriggerFromMessage(chatOf("gA", 1), { id: "m1", sender: "+15550001111", isFromMe: false, text: "ship it" })!;
    expect(t).toMatchObject({ source: "imessage", scope: "im_dm", threadId: "imessage:peer/+15550001111", addressing: true, body: "ship it" });
    expect(t.id).toBe("imessage:msg/m1");
  });

  it("a group chat is im_group and fails closed on addressing; own sends never trigger; empty text never triggers", () => {
    const g = imessageTriggerFromMessage(chatOf("gB", 3), { id: "m2", sender: "+15550002222", isFromMe: false, text: "hello" })!;
    expect(g).toMatchObject({ scope: "im_group", threadId: "imessage:group/gB", addressing: false });
    expect(imessageTriggerFromMessage(chatOf("gA", 1), { id: "m3", sender: "me", isFromMe: true, text: "my own echo" })).toBeNull();
    expect(imessageTriggerFromMessage(chatOf("gA", 1), { id: "m4", sender: "+15550001111", isFromMe: false, text: "  " })).toBeNull();
  });
});

/** A fake osascript answering the scan and per-chat message dumps. */
function fakeRunner(dumps: Record<string, string>, logs: string[] = []): OsascriptRunner {
  return async (script: string) => {
    if (script === SCAN_CHATS_SCRIPT) return { code: 0, stdout: CHAT_SCAN, stderr: "" };
    for (const [guid, out] of Object.entries(dumps)) {
      if (script.includes(guid)) return { code: 0, stdout: out, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "no such chat" };
  };
}

function src(runner: OsascriptRunner, logs: string[] = []) {
  return new ImessageSource({
    handles: ["+15550001111", "+15550002222"],
    store: new MemoryImessageStore(),
    runner, platform: "darwin", log: (l) => logs.push(l),
  });
}

describe("ImessageSource.collect", () => {
  it("watchlisted handles only, baseline-no-replay, then fresh ids emit once", async () => {
    const logs: string[] = [];
    const store = new MemoryImessageStore();
    let dump = "id-a1\t+15550001111\t0\told message";
    const s = src(fakeRunner({ "iMessage;-;+15550001111;-;chatA": dump }), logs);
    (s as unknown as { opts: { store: MemoryImessageStore } }).opts.store = store; // share the window

    const first = await s.collect(FROM);
    expect(first.triggers).toHaveLength(0); // first poll baselines — history never replays

    dump = "id-a2\t+15550001111\t0\tfix the flaky test\nid-a1\t+15550001111\t0\told message";
    const s2 = new ImessageSource({ handles: ["+15550001111"], store, runner: fakeRunner({ "iMessage;-;+15550001111;-;chatA": dump }), platform: "darwin", log: (l) => logs.push(l) });
    const second = await s2.collect(FROM);
    expect(second.triggers).toHaveLength(1);
    expect(second.triggers[0]).toMatchObject({ body: "fix the flaky test", threadId: "imessage:peer/+15550001111" });

    const third = await s2.collect(FROM); // same ids again — the window dedups
    expect(third.triggers).toHaveLength(0);
  });

  it("an unwatchlisted handle's chat is never polled", async () => {
    const logs: string[] = [];
    const s = src(fakeRunner({ "iMessage;-;+15550009999;-;chatZ": "id-z\t+15550009999\t0\tlet me in" }), logs);
    const r = await s.collect(FROM);
    expect(r.triggers).toHaveLength(0); // +15550009999 is in no other watchlist — its chat is invisible
  });

  it("exclude skips a trigger but still records the id (the echo second layer)", async () => {
    const dump = "id-b1\t+15550001111\t0\thello";
    const store = new MemoryImessageStore();
    const mk = () => new ImessageSource({ handles: ["+15550001111"], store, runner: fakeRunner({ "chatA": dump }), platform: "darwin" });
    await mk().collect(FROM); // baseline
    const r = await mk().collect(FROM, { exclude: new Set(["imessage:msg/id-b1"]) });
    expect(r.triggers).toHaveLength(0);
    expect((await mk().collect(FROM)).triggers).toHaveLength(0); // excluded id was still windowed — no late replay
  });

  it("a throwing or failing chat poll skips the chat, never the cycle", async () => {
    const logs: string[] = [];
    const boom: OsascriptRunner = async (script) => {
      if (script === SCAN_CHATS_SCRIPT) return { code: 0, stdout: CHAT_SCAN, stderr: "" };
      throw new Error("osascript lost its Automation permission");
    };
    const r = await src(boom, logs).collect(FROM);
    expect(r.triggers).toHaveLength(0);
    expect(logs.some((l) => l.includes("skipped"))).toBe(true);
  });

  it("refuses loudly off macOS", async () => {
    const s = new ImessageSource({ handles: ["+1"], store: new MemoryImessageStore(), runner: fakeRunner({}), platform: "linux" });
    await expect(s.collect(FROM)).rejects.toThrow(/requires macOS/);
  });
});

describe("ImessageReplyChannel", () => {
  it("matches imessage threads; sends via the bridge; failures throw for the outbox", async () => {
    const sent: string[] = [];
    const fakeRun = async (script: string) => {
      sent.push(script);
      return script.includes('send "ok"') ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "Messages not running" };
    };
    const ch = new ImessageReplyChannel(() => fakeRun, () => "guid-A");
    expect(ch.matches("imessage:peer/+1")).toBe(true);
    expect(ch.matches("wechat:peer/x")).toBe(false);
    expect((await ch.deliver("imessage:peer/+1", "ok")).externalId).toContain("imessage-sent:");
    await expect(ch.deliver("imessage:peer/+1", "not ok")).rejects.toThrow(/send failed/);
    expect(sent[0]).toContain('chat id "guid-A"');
  });
});
