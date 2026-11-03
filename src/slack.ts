// Slack channel (v0.8 M8-3, issue #45) — Socket Mode (no public URL) bridged onto the
// pull-based Source contract via a capped buffer, same pattern as the Feishu channel; replies
// via chat.postMessage. The bot's own user id is fetched once via auth.test, so group @mention
// detection (<@U…> in text) is precise without manual configuration.

import type { Trigger } from "./domain.js";
import type { ReplyChannel, Source, SourceState } from "./source.js";

/** The Events API `message` body (fields we consume). */
export interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: "channel" | "group" | "im" | "mpim";
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
}

export interface SlackOptions {
  /** xapp-… token (Socket Mode). */
  appToken: string;
  /** xoxb-… token (Web API). */
  botToken: string;
  /** The bot's own user id — defaults to auth.test discovery. */
  botUserId?: string;
}

const BUFFER_CAP = 1000;

export function slackTriggerFromEvent(e: SlackMessageEvent, botUserId?: string): Trigger | null {
  if (!e.channel || !e.ts) return null;
  if (e.subtype && e.subtype !== "thread_broadcast") return null; // joins/edits/deletes are not work requests
  const isDm = e.channel_type === "im";
  const text = e.text ?? "";
  const addressing =
    isDm ? true // a DM is inherently addressed
    : botUserId ? text.includes(`<@${botUserId}>`)
    : false; // unknown bot id → fail closed (inferred via listedNotAddressing remains)
  const author = e.user ?? e.bot_id ?? "unknown";
  return {
    id: `slack:msg:${e.channel}/${e.ts}`,
    source: "slack",
    scope: isDm ? "im_dm" : "im_group",
    threadId: `slack:${isDm ? "dm" : "channel"}/${e.channel}`,
    author: { login: author, isBot: e.bot_id !== undefined },
    addressing,
    body: text,
    ts: new Date(Number(e.ts.split(".")[0]) * 1000).toISOString(),
  };
}

export class SlackSource implements Source {
  readonly kind = "slack" as const;
  private readonly buffer: Trigger[] = [];
  private starting: Promise<void> | null = null;

  constructor(
    private readonly opts: SlackOptions,
    /** Test seam: replaces the Socket Mode subscription. */
    private readonly subscribe?: (onEvent: (e: SlackMessageEvent) => void) => Promise<void>,
  ) {}

  start(): Promise<void> {
    this.starting ??= this.connect();
    return this.starting;
  }

  private async connect(): Promise<void> {
    const onEvent = (e: SlackMessageEvent) => {
      const t = slackTriggerFromEvent(e, this.opts.botUserId);
      if (!t) return;
      if (this.buffer.length >= BUFFER_CAP) this.buffer.shift();
      this.buffer.push(t);
    };
    if (this.subscribe) {
      await this.subscribe(onEvent);
      return;
    }
    const { SocketModeClient } = await import("@slack/socket-mode");
    const socket = new SocketModeClient({ appToken: this.opts.appToken });
    socket.on("message", ({ body }) => {
      // Events API envelope: { type: "event_callback", event: {...} }
      const inner = (body as { event?: SlackMessageEvent }).event;
      if (inner) onEvent(inner);
    });
    await socket.start();
  }

  async collect(from: SourceState, opts: { exclude?: ReadonlySet<string> } = {}): Promise<{ triggers: Trigger[]; next: SourceState }> {
    await this.start();
    const triggers = this.buffer.splice(0).filter((t) => !opts.exclude?.has(t.id));
    return { triggers, next: from }; // push source: replay safety is the engine's idempotence
  }
}

export type SlackSender = (channel: string, text: string) => Promise<{ ts: string }>;

export class SlackReplyChannel implements ReplyChannel {
  constructor(private readonly send: SlackSender) {}

  matches(threadId: string): boolean {
    return threadId.startsWith("slack:");
  }

  async deliver(threadId: string, body: string): Promise<{ externalId: string }> {
    const channel = threadId.slice(threadId.indexOf("/") + 1);
    if (!channel || channel.includes("/")) throw new Error(`cannot resolve channel from thread ${threadId}`);
    const { ts } = await this.send(channel, body);
    return { externalId: `msg:${channel}/${ts}` };
  }
}

/** Build the real sender; also resolves the bot's own user id (auth.test) for @mention detection. */
export async function createSlackSender(botToken: string): Promise<{ send: SlackSender; botUserId?: string }> {
  const { WebClient } = await import("@slack/web-api");
  const web = new WebClient(botToken);
  const auth = await web.auth.test();
  const botUserId = (auth as { user_id?: string }).user_id;
  return {
    botUserId,
    send: async (channel, text) => {
      const res = await web.chat.postMessage({ channel, text });
      const ts = (res as { ts?: string }).ts;
      if (!ts) throw new Error("slack postMessage returned no ts");
      return { ts };
    },
  };
}
