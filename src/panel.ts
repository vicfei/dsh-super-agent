// Panel — one page listing only what awaits a human (docs/000: "A healthy state takes no space";
// docs/005: minimal panel). Zero runtime deps: node:http + inline HTML. Bind localhost.

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { Engine } from "./engine.js";


const PAGE = readFileSync(new URL("./panel.html", import.meta.url), "utf8");

export interface PanelState {
  policy: ReturnType<Engine["policy"]>;
  tickets: ReturnType<Engine["tickets"]>;
  decisions: ReturnType<Engine["decisions"]>;
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
      const state: PanelState = {
        policy: engine.policy(),
        tickets: engine.tickets(),
        decisions: engine.decisions(50),
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
