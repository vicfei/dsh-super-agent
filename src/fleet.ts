// fleet — one URL over every engine (v1.8, A3). The fleet panel PROXIES each engine's own
// panel API server-side (same-origin to the page, zero CORS/security change to engines),
// renders one card per engine: policy/mode, health, review suggestions, judge health.
// Read-only by construction — the only write path to an engine remains its own panel.

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";

export interface FleetEngine { name: string; port: number }
export type FleetServer = Server & { shutdown(): void };

export function startFleet(engines: FleetEngine[], port: number, host = "127.0.0.1"): Promise<FleetServer> {
  const base = (e: FleetEngine) => `http://127.0.0.1:${e.port}`;
  const PAGE = readFileSync(new URL("./fleet.html", import.meta.url), "utf8")
    .replace("__ENGINES__", JSON.stringify(engines));

  let closing = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method === "GET" && url.pathname === "/") return send(200, "text/html; charset=utf-8", PAGE);
    // /api/engine/<name>/<path> → proxy to that engine's own panel API
    const m = /^\/api\/engine\/([A-Za-z0-9_-]+)\/(.*)$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const engine = engines.find((e) => e.name === m[1]);
      if (!engine) return send(404, "application/json", JSON.stringify({ error: "unknown engine" }));
      try {
        const upstream = await fetch(`${base(engine)}/${m[2]}${url.search}`);
        const body = await upstream.text();
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
        return res.end(body);
      } catch (e) {
        return send(502, "application/json", JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    }
    if (closing) { res.writeHead(503); return res.end(); }
    return send(404, "text/plain", "not found");
  }) as FleetServer;
  server.shutdown = () => {
    closing = true;
    server.close();
    setTimeout(() => server.closeIdleConnections(), 200).unref();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
  };
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
