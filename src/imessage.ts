// iMessage channel (v1.10 P2-2, issue #162) — macOS-only, bridged through AppleScript
// (osascript + the Messages app). The institutional posture for a channel riding your
// PERSONAL Messages: a handle watchlist is an admission layer BEFORE the admission table
// (an arbitrary sender cannot open a ticket on your phone), groups fail closed (WeChat
// posture — allowed members still produce inferred via listedNotAddressing), and dedup is
// a recent-id window — first poll baselines and emits nothing, restart never replays.
// The osascript runner is injected so the whole bridge tests on any OS; only collect()
// is darwin-guarded (loud, like the sandbox wrapper — never a silent no-op).

import { execFile } from "node:child_process";
import type { Trigger } from "./domain.js";
import type { ReplyChannel, Source, SourceState } from "./source.js";

// ── the osascript seam ──────────────────────────────────────────────────────────

export type OsascriptRunner = (script: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function defaultOsascript(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile("osascript", ["-e", script], { timeout: 15_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch {
      resolve({ code: 127, stdout: "", stderr: "spawn failed" });
    }
  });
}

/** AppleScript string literal escaping (send path). */
export function asQuoted(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Parse one TSV row of the message dump (id \t sender \t isFromMe \t text). */
export function parseMessageLine(line: string): { id: string; sender: string; isFromMe: boolean; text: string } | null {
  const [id, sender, isFromMe, ...rest] = line.split("\t");
  if (!id || isFromMe === undefined) return null;
  return {
    id,
    sender: sender || "unknown",
    isFromMe: isFromMe === "1",
    text: rest.join("\t").replace(/\\n/g, "\n").replace(/\\t/g, "\t"),
  };
}

// ── AppleScript bodies ──────────────────────────────────────────────────────────

/** Scan every chat: `guid \t participantCount \t handle,handle,…` per line. */
export const SCAN_CHATS_SCRIPT = `
tell application "Messages"
  set out to ""
  repeat with c in (every chat)
    set g to ""
    try
      set g to id of c
    end try
    set n to 0
    try
      set n to count of (participants of c)
    end try
    set hs to ""
    try
      repeat with p in (participants of c)
        set h to handle of p
        if hs is "" then
          set hs to h
        else
          set hs to hs & "," & h
        end if
      end repeat
    end try
    set out to out & g & tab & n & tab & hs & linefeed
  end repeat
  return out
end tell`;

/** Newest `limit` messages of a chat, newest first: `id \t sender \t isFromMe \t text`. */
export function recentMessagesScript(chatGuid: string, limit: number): string {
  return `
on esc(t)
  set {od, AppleScript's text item delimiters} to {AppleScript's text item delimiters, linefeed}
  set parts to text items of t
  set AppleScript's text item delimiters to "\\\\n"
  set t to parts as text
  set {tid, AppleScript's text item delimiters} to {AppleScript's text item delimiters, tab}
  set parts to text items of t
  set AppleScript's text item delimiters to "\\\\t"
  set t to parts as text
  set AppleScript's text item delimiters to od
  return t
end esc
tell application "Messages"
  set out to ""
  set msgs to {}
  try
    set msgs to (get messages 1 thru ${limit} of chat id "${asQuoted(chatGuid)}")
  end try
  repeat with m in msgs
    set g to "unknown"
    try
      set g to handle of (sender of m)
    end try
    set t to ""
    try
      set t to esc(text of m)
    end try
    set f to "0"
    try
      if isFromMe of m then set f to "1"
    end try
    set out to out & (id of m) & tab & g & tab & f & tab & t & linefeed
  end repeat
  return out
end tell`;
}

export function sendScript(chatGuid: string, text: string): string {
  return `tell application "Messages" to send "${asQuoted(text)}" to chat id "${asQuoted(chatGuid)}"`;
}

// ── trigger mapping ─────────────────────────────────────────────────────────────

export interface ImessageChat {
  guid: string;
  participants: number;
  handles: string[];
}

export function parseChatScan(stdout: string): ImessageChat[] {
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [guid, count, handles] = l.split("\t");
    return { guid: guid ?? "", participants: Number(count) || 0, handles: (handles ?? "").split(",").map((h) => h.trim()).filter(Boolean) };
  }).filter((c) => c.guid !== "");
}

/** One polled message → trigger. Our own sends (isFromMe) never become work. */
export function imessageTriggerFromMessage(chat: ImessageChat, m: { id: string; sender: string; isFromMe: boolean; text: string }): Trigger | null {
  if (m.isFromMe) return null; // echo filter, first layer; selfPosted remains the second
  const isGroup = chat.participants > 1;
  if (!m.text.trim()) return null; // taps/reactions carry no text in this bridge — nothing to gate
  return {
    id: `imessage:msg/${m.id}`,
    source: "imessage",
    scope: isGroup ? "im_group" : "im_dm",
    threadId: isGroup ? `imessage:group/${chat.guid}` : `imessage:peer/${m.sender}`,
    author: { login: m.sender, isBot: false },
    // DMs are inherently addressed; group text is not reliably @-parseable — fail closed
    addressing: !isGroup,
    body: m.text,
    ts: new Date().toISOString(),
  };
}

// ── Source ──────────────────────────────────────────────────────────────────────

/** The recent-id window (kv in production, memory in tests). Cap bounds memory per chat. */
export interface ImessageStore {
  loadSeen(chatGuid: string): string[];
  saveSeen(chatGuid: string, ids: string[]): void;
}

export class MemoryImessageStore implements ImessageStore {
  private readonly m = new Map<string, string[]>();
  loadSeen(guid: string): string[] {
    return this.m.get(guid) ?? [];
  }
  saveSeen(guid: string, ids: string[]): void {
    this.m.set(guid, ids);
  }
}

export interface ImessageSourceOptions {
  /** Handles whose chats may be polled — the watchlist IS an admission layer (personal phone). */
  handles: string[];
  store: ImessageStore;
  runner?: OsascriptRunner;
  /** Injected so tests run anywhere; default: the real platform. */
  platform?: NodeJS.Platform;
  /** Newest messages fetched per chat per cycle. */
  fetchLimit?: number;
  /** Window cap per chat (default 300). */
  windowCap?: number;
  log?: (l: string) => void;
}

export class ImessageSource implements Source {
  readonly kind = "imessage" as const;
  private readonly chats = new Map<string, ImessageChat>(); // handle → chat, resolved lazily
  private scanned = false;

  constructor(private readonly opts: ImessageSourceOptions) {}

  private norm(h: string): string {
    return h.trim().toLowerCase();
  }

  /** The chat guid a thread routes to — peers resolve by handle, groups by their own guid.
   *  Null when the handle never resolved (fresh daemon): the reply fails, the outbox retries. */
  chatGuidFor(threadId: string): string | null {
    if (threadId.startsWith("imessage:group/")) return threadId.slice("imessage:group/".length);
    if (threadId.startsWith("imessage:peer/")) return this.chats.get(this.norm(threadId.slice("imessage:peer/".length)))?.guid ?? null;
    return null;
  }

  private async resolveChats(runner: OsascriptRunner): Promise<void> {
    const missing = this.opts.handles.filter((h) => !this.chats.has(this.norm(h)));
    if (this.scanned && missing.length === 0) return;
    const r = await runner(SCAN_CHATS_SCRIPT);
    if (r.code !== 0) throw new Error(`imessage chat scan failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    this.scanned = true;
    for (const chat of parseChatScan(r.stdout)) {
      for (const h of chat.handles) {
        const key = this.norm(h);
        if (this.opts.handles.some((w) => this.norm(w) === key)) this.chats.set(key, chat);
      }
    }
    for (const h of missing) {
      if (!this.chats.has(this.norm(h))) this.opts.log?.(`[imessage] no chat found for ${h} — not watched (send it a message first, then it resolves)`);
    }
  }

  async collect(from: SourceState, opts: { exclude?: ReadonlySet<string> } = {}): Promise<{ triggers: Trigger[]; next: SourceState }> {
    const platform = this.opts.platform ?? process.platform;
    if (platform !== "darwin") {
      throw new Error("imessage source requires macOS (osascript + Messages) — refusing to poll anywhere else");
    }
    if (this.opts.handles.length === 0) return { triggers: [], next: from };
    const runner = this.opts.runner ?? defaultOsascript;
    try {
      await this.resolveChats(runner);
    } catch (e) {
      this.opts.log?.(`[imessage] ${e instanceof Error ? e.message : e} — cycle skipped`);
      return { triggers: [], next: from };
    }

    const triggers: Trigger[] = [];
    for (const chat of new Set(this.chats.values())) {
      let r: Awaited<ReturnType<OsascriptRunner>>;
      try {
        r = await runner(recentMessagesScript(chat.guid, this.opts.fetchLimit ?? 30));
      } catch (e) {
        this.opts.log?.(`[imessage] chat ${chat.guid.slice(0, 24)}… poll threw (${e instanceof Error ? e.message : e}) — skipped`);
        continue;
      }
      if (r.code !== 0) {
        this.opts.log?.(`[imessage] chat ${chat.guid.slice(0, 24)}… poll failed (exit ${r.code}) — skipped`);
        continue;
      }
      const msgs = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map(parseMessageLine).filter((m): m is NonNullable<typeof m> => m !== null);
      const seen = new Set(this.opts.store.loadSeen(chat.guid));
      if (seen.size === 0) {
        // first poll: baseline without replaying history (telegram-offset posture)
        this.opts.store.saveSeen(chat.guid, msgs.map((m) => m.id).slice(0, this.opts.windowCap ?? 300));
        continue;
      }
      const freshIds: string[] = [];
      for (const m of msgs) {
        if (!seen.has(m.id)) freshIds.push(m.id);
        const t = seen.has(m.id) ? null : imessageTriggerFromMessage(chat, m);
        if (t && !opts.exclude?.has(t.id)) triggers.push(t);
      }
      if (freshIds.length > 0) {
        const merged = [...freshIds, ...msgs.filter((m) => seen.has(m.id)).map((m) => m.id)];
        this.opts.store.saveSeen(chat.guid, merged.slice(0, this.opts.windowCap ?? 300));
      }
    }
    return { triggers, next: from };
  }
}

// ── ReplyChannel ────────────────────────────────────────────────────────────────

export class ImessageReplyChannel implements ReplyChannel {
  private n = 0;
  constructor(
    private readonly runnerOf: () => OsascriptRunner,
    private readonly guidOf: (threadId: string) => string,
  ) {}
  matches(threadId: string): boolean {
    return threadId.startsWith("imessage:");
  }
  async deliver(threadId: string, body: string): Promise<{ externalId: string }> {
    const guid = this.guidOf(threadId);
    const r = await this.runnerOf()(sendScript(guid, body));
    if (r.code !== 0) throw new Error(`imessage send failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    return { externalId: `imessage-sent:${++this.n}` }; // Messages gives back no message id; isFromMe is the echo filter
  }
}
