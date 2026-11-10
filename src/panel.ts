// Panel — one page listing only what awaits a human (docs/000: "A healthy state takes no space";
// docs/005: minimal panel). Zero runtime deps: node:http + inline HTML. Bind localhost.
// v1.3 slice 1 (docs/designs/local-web-ui.md): the read model grows into a dashboard —
// routines with their next fire (the same truth `dsh routines list` prints) and the
// watchdog's health vitals. Reads only; writes stay on the acting surfaces.

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { Policy } from "./domain.js";
import type { Engine } from "./engine.js";
import { healthReport } from "./watchdog.js";
import { lastKey, nextRoutineFire, renderSchedule, routineDefinitions, routinesEnabled } from "./routines.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import { sandboxWrapperBin, shellProbe } from "./init.js";

const PAGE = readFileSync(new URL("./panel.html", import.meta.url), "utf8");

const NO_POLICY: Policy = { version: 0, allowedList: [], botList: [], acceptMode: "off", table: [] };

/** What the host command knows and the panel alone cannot: the executor config, repo, db path. */
export interface PanelDoctorContext {
  executor?: { command: string; sandbox?: { enabled?: boolean; allowNetwork?: boolean }; prepare?: string };
  repo?: string;
  dbPath?: string;
}

const DOCTOR_CACHE_MS = 60_000; // the page polls every 3s; probes spawn subprocesses — cache hard

export interface RoutinePanelItem {
  id: string;
  schedule: string;
  next: string;
  overdue: boolean;
  reportTo: string;
}

export interface PanelState {
  policy: ReturnType<Engine["policy"]>;
  tickets: ReturnType<Engine["tickets"]>;
  decisions: ReturnType<Engine["decisions"]>;
  deliveries: ReturnType<Engine["deliveries"]>;
  approvals: ReturnType<Engine["pendingApprovals"]>;
  /** v1.3: the daemon's pulse — stage counts, oldest stuck ages, effect backlog. */
  health: ReturnType<typeof healthReport>;
  /** v1.3: the clock — each routine with its next fire, from the engine's timer positions. */
  routines: { enabled: boolean; items: RoutinePanelItem[] };
  /** v1.4: the durable tier — distilled facts with provenance; candidates are the would-inject evidence. */
  memory: ReturnType<Engine["memoryView"]>;
  /** v1.3 slice 2: the doctor's checks, embedded (offline facts only; cached server-side). Null when not wired. */
  doctor: DoctorReport | null;
}

/** The full, untruncated trigger behind a decision row — the audit depth (v1.3 slice 3). */
function dbTriggerOf(engine: Engine, id: string) {
  const t = engine.db.prepare("SELECT * FROM trigger WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!t) return null;
  const d = engine.db.prepare("SELECT kind, strength, basis, would_accept, ts FROM decision WHERE trigger_id = ? ORDER BY id DESC LIMIT 1").get(id) as Record<string, unknown> | undefined;
  return {
    id: String(t.id), source: String(t.source), scope: String(t.scope), threadId: String(t.thread_id),
    author: String(t.author_login), isBot: t.author_is_bot === 1, addressing: t.addressing === 1,
    body: String(t.body), ts: String(t.ts),
    ...(d ? { decision: { kind: String(d.kind), strength: d.strength ?? null, basis: String(d.basis), wouldAccept: d.would_accept === 1, ts: String(d.ts) } } : {}),
  };
}

export function startPanel(engine: Engine, port: number, host = "127.0.0.1", doctorCtx?: PanelDoctorContext): Promise<Server> {
  let doctorCache: { at: number; report: DoctorReport } | null = null;
  const doctorNow = async (): Promise<DoctorReport | null> => {
    if (!doctorCtx) return null;
    if (doctorCache && Date.now() - doctorCache.at < DOCTOR_CACHE_MS) return doctorCache.report;
    const wrapper = await shellProbe("which", [sandboxWrapperBin()], 3000);
    const report = await runDoctor({
      nodeVersion: process.version,
      env: process.env as Record<string, string | undefined>,
      policy: engine.policy() ?? NO_POLICY,
      executor: doctorCtx.executor,
      repo: doctorCtx.repo,
      dbPath: doctorCtx.dbPath,
      bwrapPresent: wrapper.code === 0 && wrapper.stdout.trim() !== "",
      agentVersion: async (bin) => {
        const r = await shellProbe(bin, ["--version"], 5000);
        return r.code === 0 ? r.stdout.trim().split("\n")[0] : "";
      },
      wechatAuthPresent: engine.kvGet("wechat_auth") !== null,
      probeNetwork: false, // the panel never probes network — reads only, offline by design
    });
    doctorCache = { at: Date.now(), report };
    return report;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (req.method === "GET" && url.pathname === "/") {
      send(200, "text/html; charset=utf-8", PAGE);
      return;
    }
    // v1.5 slice B: the evidence stream — cursor read + on-demand chain verification.
    if (req.method === "GET" && url.pathname === "/api/events") {
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
      const events = engine.ledger.eventsAfter(after, limit);
      const lastId = events.length > 0 ? events[events.length - 1].id : after;
      send(200, "application/json", JSON.stringify({ events, lastId }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events/verify") {
      const v = engine.ledger.verify();
      send(200, "application/json", JSON.stringify(v));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const policy = engine.policy() ?? NO_POLICY;
      const positions = engine.sourceState("timer").positions;
      const now = Date.now();
      const items: RoutinePanelItem[] = routineDefinitions(policy).map((d) => {
        const base = { id: d.id, schedule: renderSchedule(d), reportTo: d.reportTo };
        try {
          const next = nextRoutineFire(d, positions[lastKey(d.id)], now);
          return { ...base, next: new Date(next).toISOString(), overdue: next <= now };
        } catch {
          return { ...base, next: "(schedule error)", overdue: false };
        }
      });
      const state: PanelState = {
        policy: engine.policy(),
        tickets: engine.tickets(),
        decisions: engine.decisions(50),
        deliveries: engine.deliveries(30),
        approvals: engine.pendingApprovals(),
        health: healthReport(engine),
        routines: { enabled: routinesEnabled(policy), items },
        memory: engine.memoryView(),
        doctor: await doctorNow(),
      };
      send(200, "application/json", JSON.stringify(state));
      return;
    }
    // v1.3 slice 3 — the audit depth: every decision opens to its full trigger, every
    // ticket to its run history, the approval surface to its state machine. Reads only.
    if (req.method === "GET" && url.pathname === "/api/audit/trigger") {
      const id = url.searchParams.get("id");
      if (!id) return send(400, "application/json", JSON.stringify({ error: "id required" }));
      const row = dbTriggerOf(engine, id);
      if (!row) return send(404, "application/json", JSON.stringify({ error: "unknown trigger" }));
      return send(200, "application/json", JSON.stringify(row));
    }
    if (req.method === "GET" && url.pathname === "/api/audit/ticket") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id)) return send(400, "application/json", JSON.stringify({ error: "id required" }));
      const ticket = engine.tickets().find((t) => t.id === id);
      if (!ticket) return send(404, "application/json", JSON.stringify({ error: "unknown ticket" }));
      const assignments = (engine.db.prepare(
        "SELECT id, state, exit_code, timed_out, substr(COALESCE(output, ''), -400) AS tail, started_at, ended_at FROM assignment WHERE ticket_id = ? ORDER BY id",
      ).all(id) as Record<string, unknown>[]).map((a) => ({
        id: Number(a.id), state: String(a.state), exitCode: a.exit_code === null ? null : Number(a.exit_code),
        timedOut: a.timed_out === 1, tail: String(a.tail ?? ""), startedAt: String(a.started_at), endedAt: a.ended_at === null ? null : String(a.ended_at),
      }));
      const followups = (engine.db.prepare(
        "SELECT f.ts, tr.body, tr.author_login FROM ticket_followup f JOIN trigger tr ON tr.id = f.trigger_id WHERE f.ticket_id = ? ORDER BY f.id",
      ).all(id) as Record<string, unknown>[]).map((f) => ({ ts: String(f.ts), body: String(f.body), author: String(f.author_login) }));
      const requests = (engine.db.prepare(
        "SELECT id, kind, created_at, confirm_at, resolved_at, superseded_by FROM approval_request WHERE ticket_id = ? ORDER BY id",
      ).all(id) as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id), kind: String(r.kind), createdAt: String(r.created_at),
        confirmAt: r.confirm_at === null ? null : String(r.confirm_at),
        resolvedAt: r.resolved_at === null ? null : String(r.resolved_at),
        supersededBy: r.superseded_by === null ? null : Number(r.superseded_by),
      }));
      return send(200, "application/json", JSON.stringify({ ticket, assignments, followups, requests }));
    }
    if (req.method === "GET" && url.pathname === "/api/audit/approvals") {
      const rows = engine.db.prepare(
        "SELECT a.id, a.ops_thread, a.ticket_id, a.kind, a.created_at, a.confirm_at, a.resolved_at, a.superseded_by FROM approval_request a ORDER BY a.id DESC LIMIT 100",
      ).all() as Record<string, unknown>[];
      return send(200, "application/json", JSON.stringify(rows.map((r) => ({
        id: Number(r.id), opsThread: String(r.ops_thread), ticketId: Number(r.ticket_id), kind: String(r.kind),
        createdAt: String(r.created_at), confirmAt: r.confirm_at === null ? null : String(r.confirm_at),
        resolvedAt: r.resolved_at === null ? null : String(r.resolved_at),
        supersededBy: r.superseded_by === null ? null : Number(r.superseded_by),
      }))));
    }
    if (req.method === "POST" && (url.pathname === "/api/mode" || url.pathname === "/api/stop" || url.pathname === "/api/promote")) {
      // Loopback is not a CSRF exemption: a malicious page in ANY browser tab can fire a
      // no-cors text/plain POST at 127.0.0.1. Refuse cross-origin requests outright and
      // require the JSON content type (no-cors simple requests cannot send it).
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        send(403, "application/json", JSON.stringify({ error: "cross-origin POST refused" }));
        return;
      }
      const ctype = String(req.headers["content-type"] ?? "");
      if (!ctype.startsWith("application/json")) {
        send(415, "application/json", JSON.stringify({ error: "content-type must be application/json" }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}") as { mode?: string; id?: number };
          if (url.pathname === "/api/promote") {
            const ok = typeof parsed.id === "number" ? engine.promoteTicket(parsed.id, "panel") : false;
            send(ok ? 200 : 404, "application/json", JSON.stringify({ promoted: ok }));
            return;
          }
          if (url.pathname === "/api/mode") {
            if (parsed.mode !== "off" && parsed.mode !== "observe" && parsed.mode !== "auto") {
              send(400, "application/json", JSON.stringify({ error: "mode must be off|observe|auto" }));
              return;
            }
            const next = engine.setAcceptMode(parsed.mode);
            send(200, "application/json", JSON.stringify({ policy: next }));
            return;
          }
          const ok = typeof parsed.id === "number" ? engine.stopTicket(parsed.id, "panel") : false;
          send(ok ? 200 : 404, "application/json", JSON.stringify({ stopped: ok }));
        } catch (e) {
          send(400, "application/json", JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }
    send(404, "text/plain", "not found");
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
