// Telegram channel (v0.8.1, issue #51) — the official Bot API, the simplest of the five
// channels: one token from @BotFather, documented HTTP long-poll (getUpdates + offset cursor)
// and sendMessage. The bot's own username comes from getMe, so group @mention detection is
// precise with zero manual config (the Slack auth.test pattern). Bots never receive their own
// sends — the echo filter remains as the second layer.

import type { Trigger } from "./domain.js";
import type { ReplyChannel, Source, SourceState } from "./source.js";

export const TELEGRAM_DEFAULT_BASE = "https://api.telegram.org";

/** The Update.message body (fields we consume). */
export interface TgMessage {
  message_id?: number;
  date?: number;
  chat?: { id?: number; type?: "private" | "group" | "supergroup" | "channel" | string };
  from?: { id?: number; username?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
}

export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
}

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TelegramClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly token: string;

  constructor(opts: TelegramClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = (opts.baseUrl ?? TELEGRAM_DEFAULT_BASE).replace(/\/$/, "");
    this.token = opts.token;
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`telegram ${method} → HTTP ${res.status}`);
    const data = (await res.json()) as { ok?: boolean; description?: string } & T;
    if (data.ok === false) throw new Error(`telegram ${method}: ${data.description ?? "not ok"}`);
    return data;
  }

  getMe(): Promise<{ result?: { id?: number; username?: string } }> {
    return this.call("getMe", {});
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<{ result?: TgUpdate[] }> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, signal);
  }

  sendMessage(chatId: number, text: string): Promise<{ result?: { message_id?: number } }> {
    return this.call("sendMessage", { chat_id: chatId, text });
  }
}

// ── trigger mapping ─────────────────────────────────────────────────────────────

export function telegramTriggerFromMessage(m: TgMessage, botUsername?: string): Trigger | null {
  const chatId = m.chat?.id;
  const msgId = m.message_id;
  if (chatId === undefined || msgId === undefined) return null;
  const isPrivate = m.chat?.type === "private";
  const text = m.text ?? m.caption ?? "";
  const addressing =
    isPrivate ? true // a DM is inherently addressed
    : botUsername ? (m.text ?? "").includes(`@${botUsername}`)
    : false; // unknown bot username → fail closed (inferred via listedNotAddressing remains)
  const login = m.from?.username ?? (m.from?.id !== undefined ? String(m.from.id) : "unknown");
  return {
    id: `telegram:msg/${chatId}/${msgId}`,
    source: "telegram",
    scope: isPrivate ? "im_dm" : "im_group",
    threadId: `telegram:chat/${chatId}`,
    author: { login, isBot: m.from?.is_bot === true },
    addressing,
    body: m.text !== undefined ? text : text ? `[caption] ${text}` : "",
    ts: m.date ? new Date(m.date * 1000).toISOString() : new Date().toISOString(),
  };
}

// ── Source ──────────────────────────────────────────────────────────────────────

export interface TelegramSourceOptions {
  token: string;
  /** Persisted offset (update_id + 1); kv in production, memory in tests. */
  loadOffset(): number;
  saveOffset(offset: number): void;
  /** Abort the long-poll after this many ms so a watch cycle is never blocked (default 8s). */
  pollTimeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (l: string) => void;
}

export class TelegramSource implements Source {
  readonly kind = "telegram" as const;
  private botUsername: string | undefined;
  private me: Promise<void> | null = null;

  constructor(private readonly opts: TelegramSourceOptions) {}

  private discoverMe(): Promise<void> {
    this.me ??= (async () => {
      const client = new TelegramClient({ token: this.opts.token, ...(this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {}), ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}) });
      try {
        const me = await client.getMe();
        this.botUsername = me.result?.username;
        this.opts.log?.(`[telegram] bot @${this.botUsername ?? "?"} — group @mention detection ${this.botUsername ? "armed" : "unavailable (fail-closed)"}`);
      } catch (e) {
        this.opts.log?.(`[telegram] getMe failed: ${e instanceof Error ? e.message : e} — group @mentions fail closed until it succeeds`);
      }
    })();
    return this.me;
  }

  async collect(from: SourceState, opts: { exclude?: ReadonlySet<string> } = {}): Promise<{ triggers: Trigger[]; next: SourceState }> {
    await this.discoverMe();
    const client = new TelegramClient({ token: this.opts.token, ...(this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {}), ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}) });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.opts.pollTimeoutMs ?? 8000);
    let updates: TgUpdate[];
    try {
      const res = await client.getUpdates(this.opts.loadOffset(), Math.floor((this.opts.pollTimeoutMs ?? 8000) / 1000), abort.signal);
      updates = res.result ?? [];
    } catch (e) {
      if (abort.signal.aborted) return { triggers: [], next: from }; // our own timeout — offset hasn't moved, lossless
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const triggers: Trigger[] = [];
    for (const u of updates) {
      if (u.update_id !== undefined) this.opts.saveOffset(u.update_id + 1);
      const t = u.message ? telegramTriggerFromMessage(u.message, this.botUsername) : null;
      if (t && !opts.exclude?.has(t.id)) triggers.push(t);
    }
    return { triggers, next: from };
  }
}

// ── ReplyChannel ────────────────────────────────────────────────────────────────

export class TelegramReplyChannel implements ReplyChannel {
  constructor(
    private readonly clientOf: () => TelegramClient,
    private readonly chatIdOf: (threadId: string) => number,
  ) {}

  matches(threadId: string): boolean {
    return threadId.startsWith("telegram:");
  }

  async deliver(threadId: string, body: string): Promise<{ externalId: string }> {
    const chatId = this.chatIdOf(threadId);
    const res = await this.clientOf().sendMessage(chatId, body);
    const msgId = res.result?.message_id;
    if (msgId === undefined) throw new Error("telegram sendMessage returned no message_id");
    return { externalId: `msg/${chatId}/${msgId}` };
  }
}
