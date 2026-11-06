// WeChat channel (v0.8 M8-4, issue #45) — the iLink Bot Protocol: an HTTP, Telegram-bot-shaped
// API on WeChat's own domain (ilinkai.weixin.qq.com), documented at wechatbot.dev/zh/protocol
// and mirrored by the wire types of weixin-agent-sdk (derived from @tencent-weixin/openclaw-weixin).
// Zero reverse-engineering: QR login → bot_token, long-poll getupdates with an opaque cursor,
// sendmessage echoing the per-peer context_token. Text-first; media/AES is a later slice.
//
// Persistence is injected (Engine kv in production, in-memory in tests): credentials, the
// getupdates cursor, and per-thread reply routes {toUserId, groupId, sessionId, contextToken}.

import { randomBytes, randomUUID } from "node:crypto";
import type { Trigger } from "./domain.js";
import type { ReplyChannel, Source, SourceState } from "./source.js";

export const WECHAT_DEFAULT_BASE = "https://ilinkai.weixin.qq.com";

// ── wire types (subset we consume; field names mirror the protocol) ────────────

export interface WeixinMessage {
  message_id?: string;
  seq?: number;
  from_user_id?: string;
  to_user_id?: string;
  session_id?: string;
  group_id?: string;
  /** 1 = USER, 2 = BOT. */
  message_type?: number;
  /** 1 = sending, 2 = FINISH. Outbound replies send 2. */
  message_state?: number;
  /** Per-message unique uuid — the protocol's dedup key. Absent/repeated values make the
   * server silently drop the message after the first one (live finding, 2026-11-05). */
  client_id?: string;
  create_time_ms?: number;
  item_list?: { type?: number; text_item?: { text?: string } }[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

export interface SendMessageResp {
  ret?: number;
  errmsg?: string;
  message_id?: string;
}

// ── persisted state ─────────────────────────────────────────────────────────────

export interface WechatAuth {
  token: string;
  baseUrl: string;
}

export interface WechatRoute {
  toUserId: string;
  groupId?: string;
  sessionId?: string;
  contextToken: string;
}

export interface WechatStore {
  loadAuth(): WechatAuth | null;
  saveAuth(auth: WechatAuth): void;
  loadCursor(): string;
  saveCursor(buf: string): void;
  loadRoute(threadId: string): WechatRoute | null;
  saveRoute(threadId: string, route: WechatRoute): void;
  /** Optional generic kv — the production store exposes engine keys (e.g. wechat_binder). */
  kvGet?(key: string): string | null;
  kvSet?(key: string, value: string): void;
  /** Session expired (-14): drop everything, a new QR scan is required. */
  clearAll(): void;
}

export class MemoryWechatStore implements WechatStore {
  private auth: WechatAuth | null = null;
  private cursor = "";
  private readonly routes = new Map<string, WechatRoute>();
  private readonly kv = new Map<string, string>();
  loadAuth() { return this.auth; }
  saveAuth(auth: WechatAuth) { this.auth = auth; }
  loadCursor() { return this.cursor; }
  saveCursor(buf: string) { this.cursor = buf; }
  loadRoute(threadId: string) { return this.routes.get(threadId) ?? null; }
  saveRoute(threadId: string, route: WechatRoute) { this.routes.set(threadId, route); }
  kvGet(key: string) { return this.kv.get(key) ?? null; }
  kvSet(key: string, value: string) { this.kv.set(key, value); }
  clearAll() { this.auth = null; this.cursor = ""; this.routes.clear(); }
}

/** Production store over the engine's kv (same db as the tickets — one backup story). */
export class EngineWechatStore implements WechatStore {
  constructor(private readonly kv: { kvGet(k: string): string | null; kvSet(k: string, v: string): void; kvDelete(k: string): void }) {}

  loadAuth(): WechatAuth | null {
    try {
      const raw = this.kv.kvGet("wechat_auth");
      return raw ? (JSON.parse(raw) as WechatAuth) : null;
    } catch {
      return null;
    }
  }

  saveAuth(auth: WechatAuth): void {
    this.kv.kvSet("wechat_auth", JSON.stringify(auth));
  }

  loadCursor(): string {
    return this.kv.kvGet("wechat_cursor") ?? "";
  }

  saveCursor(buf: string): void {
    this.kv.kvSet("wechat_cursor", buf);
  }

  kvGet(key: string): string | null { return this.kv.kvGet(key); }
  kvSet(key: string, value: string): void { this.kv.kvSet(key, value); }

  loadRoute(threadId: string): WechatRoute | null {
    try {
      const raw = this.kv.kvGet(`wechat_route:${threadId}`);
      return raw ? (JSON.parse(raw) as WechatRoute) : null;
    } catch {
      return null;
    }
  }

  saveRoute(threadId: string, route: WechatRoute): void {
    this.kv.kvSet(`wechat_route:${threadId}`, JSON.stringify(route));
    const index = new Set((this.kv.kvGet("wechat_route_index") ?? "").split("\n").filter(Boolean));
    index.add(threadId);
    this.kv.kvSet("wechat_route_index", [...index].join("\n"));
  }

  clearAll(): void {
    // route keys are namespaced; policy/positions keys are unaffected
    this.kv.kvGet("wechat_route_index")?.split("\n").filter(Boolean).forEach((k) => this.kv.kvDelete(`wechat_route:${k}`));
    this.kv.kvSet("wechat_route_index", "");
    this.kv.kvDelete("wechat_auth");
    this.kv.kvDelete("wechat_cursor");
  }
}

// ── API client ──────────────────────────────────────────────────────────────────

/** X-WECHAT-UIN: random uint32 → decimal string → base64, fresh per request. */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0) >>> 0)).toString("base64");
}

const BOT_AGENT = "dsh-super-agent/0.8.0";

export interface WechatClientOptions {
  token: string;
  baseUrl?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class WechatApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly token: string;

  constructor(opts: WechatClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = (opts.baseUrl ?? opts.apiBase ?? WECHAT_DEFAULT_BASE).replace(/\/$/, "");
    this.token = opts.token;
  }

  private async post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${path}`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${this.token}`,
        "X-WECHAT-UIN": randomWechatUin(),
      },
      body: JSON.stringify({ ...body, base_info: { channel_version: "2.0.0", bot_agent: BOT_AGENT } }),
    });
    if (!res.ok) throw new Error(`wechat ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  getUpdates(getUpdatesBuf: string, signal?: AbortSignal): Promise<GetUpdatesResp> {
    return this.post<GetUpdatesResp>("ilink/bot/getupdates", { get_updates_buf: getUpdatesBuf }, signal);
  }

  /** Typing heartbeat plumbing (v1.2.1): getconfig carries ilink_user_id and returns the typing_ticket. */
  getConfig(ilinkUserId: string): Promise<{ ret?: number; typing_ticket?: string; errmsg?: string }> {
    return this.post("ilink/bot/getconfig", { ilink_user_id: ilinkUserId });
  }

  /** status 1 = typing, 2 = stopped. ret 0 = accepted (live-verified 2026-11-06). */
  sendTyping(ilinkUserId: string, typingTicket: string, status: 1 | 2): Promise<{ ret?: number; errmsg?: string }> {
    return this.post("ilink/bot/sendtyping", { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status });
  }

  sendMessage(msg: WeixinMessage): Promise<SendMessageResp> {
    return this.post<SendMessageResp>("ilink/bot/sendmessage", { msg });
  }
}

// ── login (terminal QR) ─────────────────────────────────────────────────────────

export interface QrPayload {
  /** The QR id, used for status polling. */
  qrcode: string;
  /** The QR's encoded content — in practice a liteapp.weixin.qq.com URL to render as a QR. */
  imgContent: string;
}

/**
 * QR login flow: fetch a QR (the caller renders it — it must be scanned by the human's WeChat
 * app), long-poll status until confirmed, return credentials. Verified live: qrcode_img_content
 * is a URL, not an image payload.
 */
export async function wechatLogin(
  onQr: (qr: QrPayload) => void,
  opts: { apiBase?: string; fetchImpl?: typeof fetch; pollMs?: number; maxWaitMs?: number; onBinder?: (id: string | null) => void } = {},
): Promise<WechatAuth> {
  const onBinder = opts.onBinder;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? WECHAT_DEFAULT_BASE).replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  const qrRes = await fetchImpl(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: "POST",
    headers,
    body: JSON.stringify({ local_token_list: [] }),
  });
  if (!qrRes.ok) throw new Error(`wechat get_bot_qrcode → HTTP ${qrRes.status}`);
  const qr = (await qrRes.json()) as { qrcode?: string; qrcode_img_content?: string };
  if (!qr.qrcode) throw new Error("wechat get_bot_qrcode returned no qrcode");
  onQr({ qrcode: qr.qrcode, imgContent: qr.qrcode_img_content ?? "" });

  const deadline = Date.now() + (opts.maxWaitMs ?? 180_000);
  for (;;) {
    if (Date.now() > deadline) throw new Error("wechat login timed out waiting for the scan — run wechat-login again");
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
    const stRes = await fetchImpl(`${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { headers });
    if (!stRes.ok) throw new Error(`wechat get_qrcode_status → HTTP ${stRes.status}`);
    const st = (await stRes.json()) as { status?: string; bot_token?: string; baseurl?: string; ilink_user_id?: string; user_id?: string };
    if (st.status === "confirmed" && st.bot_token) {
      onBinder?.(st.ilink_user_id ?? st.user_id ?? null); // the scanner's identity, for the allowlist suggestion
      return { token: st.bot_token, baseUrl: st.baseurl ?? base };
    }
    if (st.status === "expired") throw new Error("wechat QR expired — run wechat-login again");
    // wait | scaned → keep polling
  }
}

// ── trigger mapping ─────────────────────────────────────────────────────────────

/** threadId for a message: groups are threads; a DM peer is a thread. */
export function wechatThreadId(m: WeixinMessage): string {
  return m.group_id ? `wechat:group/${m.group_id}` : `wechat:peer/${m.from_user_id ?? "unknown"}`;
}

export function wechatTriggerFromMessage(m: WeixinMessage): Trigger | null {
  if (m.message_type === 2) return null; // BOT traffic (incl. our own) — never a work request
  if (!m.message_id && m.seq === undefined) return null;
  const firstText = m.item_list?.find((i) => i.type === 1)?.text_item?.text;
  const anyItem = m.item_list?.[0];
  const body = firstText ?? (anyItem?.type !== undefined && anyItem.type !== 1 ? `[${anyItem.type}]` : "");
  // Verified live: 1:1 chats carry group_id as an EMPTY string — truthiness, not presence.
  const isGroup = Boolean(m.group_id);
  return {
    id: `wechat:msg/${m.message_id ?? `seq-${m.seq}`}`,
    source: "wechat",
    scope: isGroup ? "im_group" : "im_dm",
    threadId: wechatThreadId(m),
    author: { login: m.from_user_id ?? "unknown", isBot: false }, // message_type 2 already excluded
    // DMs are inherently addressed; group @mention text format is not reliably parseable in
    // this protocol — fail closed (allowed-list members still produce inferred).
    addressing: !isGroup,
    body,
    ts: m.create_time_ms ? new Date(m.create_time_ms).toISOString() : new Date().toISOString(),
  };
}

// ── Source ──────────────────────────────────────────────────────────────────────

export interface WechatSourceOptions {
  store: WechatStore;
  /** Abort the long-poll after this many ms so a watch cycle is never blocked (default 8s). */
  pollTimeoutMs?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  log?: (l: string) => void;
  /** Typing heartbeat interval (default 45min). Set 0 to disable. */
  typingEveryMs?: number;
}

export class WechatSource implements Source {
  readonly kind = "wechat" as const;
  private warnedNoAuth = false;

  constructor(private readonly opts: WechatSourceOptions) {}

  async collect(from: SourceState, opts: { exclude?: ReadonlySet<string> } = {}): Promise<{ triggers: Trigger[]; next: SourceState }> {
    const auth = this.opts.store.loadAuth();
    if (!auth) {
      if (!this.warnedNoAuth) {
        this.warnedNoAuth = true;
        this.opts.log?.("[wechat] not logged in — run `wechat-login` with the same --db to arm this source");
      }
      return { triggers: [], next: from };
    }
    const client = new WechatApiClient({ token: auth.token, baseUrl: auth.baseUrl, ...(this.opts.apiBase ? { apiBase: this.opts.apiBase } : {}), ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}) });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.opts.pollTimeoutMs ?? 8000);
    let resp: GetUpdatesResp;
    try {
      resp = await client.getUpdates(this.opts.store.loadCursor(), abort.signal);
    } catch (e) {
      if (abort.signal.aborted) return { triggers: [], next: from }; // long-poll cut short by our own timeout — lossless, the cursor hasn't moved
      throw e;
    } finally {
      clearTimeout(timer);
    }
    // Success carries no status at all (verified live): {msgs, sync_buf?, get_updates_buf} —
    // ret/errcode appear only on failure. Treat absent-status as success, never as an error.
    if ((resp.ret === undefined || resp.ret === 0) && resp.errcode === undefined) {
      if (resp.get_updates_buf) this.opts.store.saveCursor(resp.get_updates_buf);
      const triggers: Trigger[] = [];
      for (const m of resp.msgs ?? []) {
        // remember how to reply into this thread — the context_token is the routing key
        if (m.from_user_id && m.context_token) {
          this.opts.store.saveRoute(wechatThreadId(m), {
            toUserId: m.from_user_id,
            ...(m.group_id ? { groupId: m.group_id } : {}),
            ...(m.session_id ? { sessionId: m.session_id } : {}),
            contextToken: m.context_token,
          });
        }
        const t = wechatTriggerFromMessage(m);
        if (t && !opts.exclude?.has(t.id)) triggers.push(t);
      }
      const next: SourceState = { positions: { ...from.positions } };
      // Typing heartbeat (v1.2.1): the send-side session ages out when the peer has been
      // quiet for hours — proactive sends then fail with ret=-2 until fresh inbound traffic
      // (live finding 2026-11-06: the 08:00 digest could not land at 08:00). A silent typing
      // touch every interval keeps the session warm; every attempt (success OR failure)
      // moves the throttle — a failing heartbeat must never become its own storm.
      const lastTyping = Number(from.positions["typingAt"] ?? 0);
      const typingEvery = this.opts.typingEveryMs ?? 45 * 60_000;
      if (typingEvery > 0 && Date.now() - lastTyping > typingEvery) {
        next.positions["typingAt"] = Date.now();
        const binder = this.opts.store.kvGet?.("wechat_binder") ?? null;
        if (binder) {
          try {
            const cfg = await client.getConfig(binder);
            if (cfg.ret === 0 && cfg.typing_ticket) {
              await client.sendTyping(binder, cfg.typing_ticket, 1);
              await new Promise((r) => setTimeout(r, 300));
              await client.sendTyping(binder, cfg.typing_ticket, 2);
            }
          } catch {
            /* heartbeat is best-effort — never breaks polling */
          }
        }
      }
      return { triggers, next };
    }
    if (resp.errcode === -14 || resp.ret === -14) {
      this.opts.store.clearAll();
      this.opts.log?.("[wechat] session expired (-14) — state cleared, run `wechat-login` again");
      return { triggers: [], next: from };
    }
    throw new Error(`wechat getupdates ret=${resp.ret} errcode=${resp.errcode ?? "-"}: ${resp.errmsg ?? ""}`.trim());
  }
}

// ── ReplyChannel ────────────────────────────────────────────────────────────────

/** Split a long reply for WeChat at ~1800 chars, preferring paragraph then newline then space
 * boundaries (the ecosystem norm: dsh-im 1800, dsh-dot 1900, dsh-wechat segmented). */
export function chunkWechatReply(body: string, limit = 1800): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < limit * 0.5) cut = limit; // no sane boundary — hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export class WechatReplyChannel implements ReplyChannel {
  constructor(
    private readonly store: WechatStore,
    private readonly clientOf: (auth: WechatAuth) => WechatApiClient,
    private readonly log: (l: string) => void = () => {},
  ) {}

  matches(threadId: string): boolean {
    return threadId.startsWith("wechat:");
  }

  async deliver(threadId: string, body: string): Promise<{ externalId: string }> {
    const auth = this.store.loadAuth();
    const route = this.store.loadRoute(threadId);
    if (!auth || !route) throw new Error(`no wechat route for thread ${threadId} (not logged in, or the thread never sent us a message)`);
    const client = this.clientOf(auth);
    const parts = chunkWechatReply(body);
    let lastMessageId = "unknown";
    for (const part of parts) {
      const resp = await client.sendMessage({
        to_user_id: route.toUserId,
        ...(route.groupId ? { group_id: route.groupId } : {}),
        ...(route.sessionId ? { session_id: route.sessionId } : {}),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        client_id: randomUUID(), // the protocol's dedup key — unique per message, or the server drops the rest
        item_list: [{ type: 1, text_item: { text: part } }],
        context_token: route.contextToken, // "回复时必须原样回传" — routes the reply
      });
      // Same live finding as getupdates: success carries no status at all — ret appears only
      // on failure. Absent status = delivered (verified by the message landing in WeChat).
      if (resp.ret !== undefined && resp.ret !== 0) throw new Error(`wechat sendmessage ret=${resp.ret}: ${resp.errmsg ?? ""}`.trim());
      if (resp.message_id) lastMessageId = resp.message_id;
    }
    return { externalId: `msg/${lastMessageId}` };
  }
}
