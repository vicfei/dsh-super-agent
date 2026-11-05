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

const PAGE = readFileSync(new URL("./panel.html", import.meta.url), "utf8");

const NO_POLICY: Policy = { version: 0, allowedList: [], botList: [], acceptMode: "off", table: [] };

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
}

export function startPanel(engine: Engine, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (req.method === "GET" && url.pathname === "/") {
      send(200, "text/html; charset=utf-8", PAGE);
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
      };
      send(200, "application/json", JSON.stringify(state));
      return;
    }
    if (req.method === "POST" && (url.pathname === "/api/mode" || url.pathname === "/api/stop")) {
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
