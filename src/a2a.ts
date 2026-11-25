// A2A channel (v2.0 Phase 3, issue #176; design: docs/designs/delegation-governance.md) —
// external agents knock through the SAME admission table. Inbound: a JSON-RPC
// `message/send` over HTTP normalizes into an `a2a`-scope trigger, buffered and drained by
// the watch cycle (the FeishuSource pattern — push events, pull collection). Outbound:
// replies ride a relay channel — pushed to the caller's registered callback when one was
// declared, and always readable at the task status endpoint.
//
// The A2A protocol carries no admission and no evidence. dsh supplies the constitution:
// the bearer token is transport auth (refuse loudly without it); the caller identity is
// admission input (unlisted agents fall to the `unlistedAddressing` cell, recorded as
// evidence like any other ignore); the hash-chained ledger keeps one row per delegation.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Policy, Trigger } from "./domain.js";
import { a2aPolicyOf } from "./domain.js";
import type { ReplyChannel, Source, SourceState } from "./source.js";
import type { Engine } from "./engine.js";

// ── Agent Card ───────────────────────────────────────────────────────────────────

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: { id: string; name: string; description: string }[];
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  securitySchemes: Record<string, { type: string; scheme: string }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

/** The capability surface — what MAY be asked. The admission table decides what IS. */
export function agentCardOf(policy: Policy, endpointUrl: string): AgentCard {
  return {
    name: "dsh-super-agent",
    description: "admission-controlled agent delegation — every request passes the same admission table as any other trigger; one hash-chained ledger row per delegation",
    url: endpointUrl,
    version: "1.0.0",
    skills: [
      {
        id: "delegated-work",
        name: "Delegated work",
        description: "submit a work request; it is gated (observe shadows / auto works), runs in a sandboxed worktree, and reports back",
      },
    ],
    capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: true },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  };
}

// ── trigger mapping ──────────────────────────────────────────────────────────────

/** The A2A `message/send` params we consume (A2A v0.2 JSON shapes, tolerantly read). */
export interface A2AMessageParams {
  id?: string;
  message?: {
    role?: string;
    parts?: { kind?: string; type?: string; text?: string }[];
    metadata?: { caller?: string };
  };
  configuration?: { pushNotificationConfig?: { url?: string } };
}

export function a2aTaskIdOf(params: A2AMessageParams): string {
  return String(params.id ?? crypto.randomUUID());
}

export function a2aTriggerFromMessage(params: A2AMessageParams, fallbackCaller: string): Trigger | null {
  const taskId = a2aTaskIdOf(params);
  const parts = params.message?.parts ?? [];
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : `[${p.kind ?? p.type ?? "part"}]`))
    .join("\n")
    .trim();
  const caller = String(params.message?.metadata?.caller ?? fallbackCaller ?? "unknown-agent");
  if (!text) return null;
  return {
    id: `a2a:task/${taskId}`,
    source: "a2a",
    scope: "a2a",
    threadId: `a2a:${caller}/${taskId}`,
    author: { login: caller, isBot: false },
    addressing: true, // delegation is by definition addressed
    body: text,
    ts: new Date().toISOString(),
  };
}

// ── Source (push-buffer, the FeishuSource pattern) ───────────────────────────────

const BUFFER_CAP = 500;

export class A2ASource implements Source {
  readonly kind = "a2a" as const;
  private readonly buffer: Trigger[] = [];
  constructor(private readonly log: (l: string) => void = () => {}) {}
  /** The HTTP handler pushes here; the watch cycle drains. */
  push(t: Trigger): void {
    if (this.buffer.length >= BUFFER_CAP) this.buffer.shift();
    this.buffer.push(t);
  }
  async collect(from: SourceState, opts: { exclude?: ReadonlySet<string> } = {}): Promise<{ triggers: Trigger[]; next: SourceState }> {
    const triggers = this.buffer.splice(0).filter((t) => !opts.exclude?.has(t.id));
    return { triggers, next: from }; // replay safety is the engine's trigger-id exactly-once
  }
}

// ── the HTTP surface ─────────────────────────────────────────────────────────────

function bearerMatch(got: string, want: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(got), h(want));
}

import { createHash } from "node:crypto";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Stage → A2A task state, from the engine's own truth. */
function a2aStateOf(engine: Engine, taskId: string): { id: string; state: string; ticketId?: number; report?: string } | null {
  const tickets = engine.tickets().filter((t) => t.threadId.endsWith(`/${taskId}`));
  if (tickets.length === 0) return null;
  const t = tickets[0];
  const state = t.state === "ended" ? "completed" : t.stage === "working" ? "working" : t.stage === "needs-person" ? "input-required" : "submitted";
  const assignments = engine.db
    .prepare("SELECT substr(output, -600) tail FROM assignment WHERE ticket_id = ? AND state = 'ended' ORDER BY id DESC LIMIT 1")
    .get(t.id) as { tail?: string } | undefined;
  return { id: taskId, state, ticketId: t.id, ...(assignments?.tail ? { report: assignments.tail } : {}) };
}

export interface A2AServerOptions {
  engine: Engine;
  source: A2ASource;
  policy: Policy;
  port: number;
  host: string;
  /** Shared bearer token (env A2A_TOKEN). Refusing to start without it is the caller's job. */
  token: string;
  log: (l: string) => void;
}

export type A2AServer = Server & { shutdown(): void };

/** The delegation endpoint: Agent Card + JSON-RPC message/send + task status. */
export async function startA2AServer(opts: A2AServerOptions): Promise<A2AServer> {
  const a2a = a2aPolicyOf(opts.policy);
  const path = a2a.path.replace(/\/$/, "") || "/a2a";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (!bearerMatch(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), opts.token)) {
      sendJson(res, 401, { error: "a2a: bearer token required (A2A_TOKEN)" });
      return;
    }
    // Agent Card — the standard well-known path and a path-local alias
    if (req.method === "GET" && (url.pathname === "/.well-known/agent-card.json" || url.pathname === `${path}/card`)) {
      sendJson(res, 200, agentCardOf(opts.policy, `http://${req.headers.host ?? "localhost"}${path}`));
      return;
    }
    // Task status: the caller polls when it registered no push callback
    if (req.method === "GET" && url.pathname.startsWith(`${path}/tasks/`)) {
      const taskId = url.pathname.slice(`${path}/tasks/`.length);
      sendJson(res, 200, a2aStateOf(opts.engine, taskId) ?? { id: taskId, state: "unknown" });
      return;
    }
    if (req.method === "POST" && url.pathname === path) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let rpc: { id?: unknown; method?: unknown; params?: A2AMessageParams };
        try {
          rpc = JSON.parse(body || "{}");
        } catch {
          sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
          return;
        }
        if (rpc.method !== "message/send") {
          sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: `method not supported: ${String(rpc.method)}` } });
          return;
        }
        const t = a2aTriggerFromMessage(rpc.params ?? {}, "");
        if (!t) {
          sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32602, message: "no text parts in message" } });
          return;
        }
        if (rpc.params?.configuration?.pushNotificationConfig?.url) {
          opts.engine.kvSet(`a2a-push:${a2aTaskIdOf(rpc.params)}`, String(rpc.params.configuration.pushNotificationConfig.url));
        }
        opts.source.push(t);
        const admitted = a2a.allowedAgents?.some((a: string) => a.toLowerCase() === t.author.login.toLowerCase()) ?? false;
        opts.log(`[a2a] delegation from ${t.author.login}${admitted ? "" : " (UNLISTED — gate decides)"}: ${t.id}`);
        sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result: { task: { id: a2aTaskIdOf(rpc.params ?? {}), state: "submitted" } } });
      });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  const shuttingDown = { v: false };
  const out = server as A2AServer;
  out.shutdown = () => {
    if (shuttingDown.v) return;
    shuttingDown.v = true;
    server.close();
    server.closeAllConnections();
  };
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, () => resolve()));
  return out;
}

// ── the outbound half (slice 4): `dsh a2a send` — a thin A2A client ───────────────

export interface A2ASendOptions {
  /** The remote's JSON-RPC endpoint, path included — e.g. http://wsl2:8791/a2a */
  url: string;
  /** Shared bearer (transport auth, the same v1 identity the server side checks). */
  token: string;
  prompt: string;
  /** Caller identity the remote's policy.a2a.allowedAgents admits against. */
  caller: string;
  /** Poll tasks/<id> to a terminal state and surface the report. */
  wait: boolean;
  /** Poll interval (default 2s) and overall wait budget (default 30min). */
  intervalMs?: number;
  timeoutMs?: number;
  log?: (l: string) => void;
}

export interface A2ASendResult {
  taskId: string;
  /** Terminal A2A task state when waited out; "submitted" when fire-and-forget. */
  state: string;
  report?: string;
  /** 0 completed · 1 transport/protocol error · 2 remote ended not-done (input-required,
   *  failed, canceled) · 3 wait budget exhausted while still working. */
  exitCode: number;
}

const TERMINAL_NOT_DONE = new Set(["input-required", "failed", "canceled", "rejected"]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One delegation over the wire: message/send (client-chosen task id ⇒ idempotent — the
 *  server dedups on the trigger id), then optionally poll the status endpoint the same
 *  server always serves. "unknown" from the status endpoint means the remote's watch
 *  cycle has not ingested the buffered trigger yet — that is pending, not an error. */
export async function a2aSend(opts: A2ASendOptions): Promise<A2ASendResult> {
  const endpoint = opts.url.replace(/\/+$/, "");
  const taskId = crypto.randomUUID();
  const auth = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };
  const say = opts.log ?? (() => {});
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          id: taskId,
          message: { role: "user", parts: [{ kind: "text", text: opts.prompt }], metadata: { caller: opts.caller } },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { taskId, state: "send-failed", exitCode: 1, ...(e instanceof Error ? { report: e.message } : {}) };
  }
  const rpc = (await res.json().catch(() => null)) as
    | { result?: { task?: { id?: string; state?: string } }; error?: { message?: string } }
    | null;
  if (!res.ok || !rpc?.result?.task) {
    const why = rpc?.error?.message ?? `HTTP ${res.status}`;
    return { taskId, state: "send-failed", exitCode: 1, report: why };
  }
  say(`[a2a] task ${taskId} ${rpc.result.task.state} at ${endpoint} (caller: ${opts.caller})`);
  if (!opts.wait) return { taskId, state: String(rpc.result.task.state ?? "submitted"), exitCode: 0 };

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let st: { state?: string; report?: string } | null = null;
    try {
      const r = await fetch(`${endpoint}/tasks/${taskId}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
      st = (await r.json().catch(() => null)) as { state?: string; report?: string } | null;
    } catch {
      st = null; // transient poll failure — the next interval retries
    }
    const state = String(st?.state ?? "unknown");
    if (state === "completed") return { taskId, state, ...(st?.report ? { report: st.report } : {}), exitCode: 0 };
    if (TERMINAL_NOT_DONE.has(state)) return { taskId, state, ...(st?.report ? { report: st.report } : {}), exitCode: 2 };
    say(`[a2a] task ${taskId} ${state} — still waiting`);
  }
  return { taskId, state: "timeout", exitCode: 3 };
}

// ── relay: replies back to the delegating agent ──────────────────────────────────

/** The A2A relay: task updates for delegation-origin threads. Pushes to the caller's
 *  registered callback (kv a2a-push:<taskId>) when declared; the status endpoint is the
 *  fallback the caller can always poll. */
export class A2AReplyChannel implements ReplyChannel {
  private n = 0;
  constructor(
    private readonly engine: Engine,
    private readonly log: (l: string) => void = () => {},
  ) {}
  matches(threadId: string): boolean {
    return threadId.startsWith("a2a:");
  }
  async deliver(threadId: string, body: string): Promise<{ externalId: string }> {
    const taskId = threadId.split("/").pop() ?? "";
    const pushUrl = this.engine.kvGet(`a2a-push:${taskId}`);
    if (!pushUrl) {
      this.log(`[a2a] no push callback for ${taskId} — update readable at the task status endpoint`);
      return { externalId: `a2a-update/${++this.n}` };
    }
    const res = await fetch(pushUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "task/status", params: { taskId, state: "completed", artifact: { parts: [{ kind: "text", text: body }] } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`a2a relay POST → HTTP ${res.status}`);
    return { externalId: `a2a-update/${++this.n}` };
  }
}
