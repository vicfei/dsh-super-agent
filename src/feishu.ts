// Feishu channel (v0.8 M8-2, issue #45) — a self-built enterprise app over the official SDK's
// WebSocket long connection (no public callback URL needed). The push-based event stream is
// bridged onto the pull-based Source contract through an internal buffer; dedup is the engine's
// trigger-id exactly-once (`feishu:msg:<message_id>`). Replies go out via im/v1 messages.
// Pure mapping is separated from transport so it is unit-testable without an app.

import type { Trigger } from "./domain.js";
import type { ReplyChannel, Source, SourceState } from "./source.js";

/** The im.message.receive_v1 event body (fields we consume). */
export interface FeishuReceiveEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: "p2p" | "group";
    message_type?: string;
    content?: string;
    create_time?: string;
    mentions?: { id?: { open_id?: string } }[];
  };
}

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  /** The bot's own open_id — precise @mention detection in groups (FEISHU_BOT_OPEN_ID).
   * Without it, group messages are never "addressing" (fail-closed: allowed-list members
   * still produce inferred via the listedNotAddressing cell). */
  botOpenId?: string;
}

const BUFFER_CAP = 1000;

export function feishuTriggerFromEvent(e: FeishuReceiveEvent, botOpenId?: string): Trigger | null {
  const msg = e.message;
  if (!msg?.message_id || !msg.chat_id) return null;
  const text = extractText(msg.content, msg.message_type);
  const addressing =
    msg.chat_type !== "group"
      ? true // a DM is inherently addressed
      : botOpenId
        ? (msg.mentions ?? []).some((m) => m.id?.open_id === botOpenId)
        : false;
  return {
    id: `feishu:msg:${msg.message_id}`,
    source: "feishu",
    scope: msg.chat_type === "group" ? "im_group" : "im_dm",
    threadId: `feishu:chat/${msg.chat_id}`,
    author: { login: e.sender?.sender_id?.open_id ?? "unknown", isBot: e.sender?.sender_type === "app" },
    addressing,
    body: text,
    ts: msg.create_time ? new Date(Number(msg.create_time)).toISOString() : new Date().toISOString(),
  };
}

function extractText(content: string | undefined, type: string | undefined): string {
  if (type !== "text" || !content) return type ? `[${type}]` : "";
  try {
    return (JSON.parse(content) as { text?: string }).text ?? "";
  } catch {
    return "";
  }
}

export class FeishuSource implements Source {
  readonly kind = "feishu" as const;
  private readonly buffer: Trigger[] = [];
  private starting: Promise<void> | null = null;

  constructor(
    private readonly opts: FeishuOptions,
    /** Test seam: replaces the SDK's WebSocket subscription. */
    private readonly subscribe?: (onEvent: (e: FeishuReceiveEvent) => void) => Promise<void>,
  ) {}

  /** Connect the long connection (idempotent, concurrency-safe). */
  start(): Promise<void> {
    this.starting ??= this.connect();
    return this.starting;
  }

  private async connect(): Promise<void> {
    const onEvent = (e: FeishuReceiveEvent) => {
      const t = feishuTriggerFromEvent(e, this.opts.botOpenId);
      if (!t) return;
      if (this.buffer.length >= BUFFER_CAP) this.buffer.shift(); // drop oldest, never grow unbounded
      this.buffer.push(t);
    };
    if (this.subscribe) {
      await this.subscribe(onEvent);
      return;
    }
    const lark = await import("@larksuiteoapi/node-sdk");
    const ws = new lark.WSClient({ appId: this.opts.appId, appSecret: this.opts.appSecret });
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => onEvent(data as FeishuReceiveEvent),
    });
    await ws.start({ eventDispatcher: dispatcher });
  }

  async collect(from: SourceState, opts: { exclude?: ReadonlySet<string> } = {}): Promise<{ triggers: Trigger[]; next: SourceState }> {
    await this.start();
    const triggers = this.buffer.splice(0).filter((t) => !opts.exclude?.has(t.id));
    return { triggers, next: from }; // push source: replay safety is the engine's idempotence
  }
}

export type FeishuSender = (chatId: string, text: string) => Promise<{ messageId: string }>;

export class FeishuReplyChannel implements ReplyChannel {
  constructor(private readonly send: FeishuSender) {}

  matches(threadId: string): boolean {
    return threadId.startsWith("feishu:");
  }

  async deliver(threadId: string, body: string): Promise<{ externalId: string }> {
    const chatId = threadId.slice("feishu:chat/".length);
    if (!chatId || chatId.includes("/")) throw new Error(`cannot resolve chat id from thread ${threadId}`);
    const { messageId } = await this.send(chatId, body);
    return { externalId: `msg:${messageId}` };
  }
}

/** Build the real sender (tenant token managed by the SDK). */
export async function createFeishuSender(appId: string, appSecret: string): Promise<FeishuSender> {
  const lark = await import("@larksuiteoapi/node-sdk");
  const client = new lark.Client({ appId, appSecret });
  return async (chatId, text) => {
    const res = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" },
    });
    const messageId = (res as { data?: { message_id?: string } }).data?.message_id;
    if (!messageId) throw new Error("feishu send returned no message_id");
    return { messageId };
  };
}
