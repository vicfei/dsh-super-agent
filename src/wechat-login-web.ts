// `dsh wechat-login --web` — a localhost page for the iLink QR login (v1.3).
// Why: the QR's server-side lifetime is shorter than any "render to terminal → pick up
// your phone" round trip on a remote box (live finding, 2026-11-06); a page where the
// human clicks and scans instantly removes the race. Zero new runtime deps: node:http,
// the qrcode package (already a dependency), and the same iLink endpoints as wechatLogin.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { Engine } from "./engine.js";
import { EngineWechatStore, WECHAT_DEFAULT_BASE } from "./wechat.js";

const QR_LIFETIME_MS = 110_000; // refresh just before the server expires the QR (~2min live)

export const LOGIN_WEB_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>dsh — WeChat login</title><style>
:root{color-scheme:dark}
body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0d1117;color:#c9d1d9;display:flex;flex-direction:column;align-items:center;padding:32px;margin:0}
h1{font-size:18px;color:#e6edf3;margin:0 0 4px}.sub{color:#8b949e;font-size:13px;margin-bottom:24px}
button{font:inherit;font-size:15px;padding:10px 24px;border-radius:8px;border:1px solid #3fb95066;background:#23863633;color:#3fb950;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
img{margin:20px 0;border-radius:8px;background:#fff;padding:10px;width:min(280px,80vw)}
#st{font-size:14px;min-height:22px}.ok{color:#3fb950;font-weight:700;font-size:16px}
.q{color:#8b949e;max-width:420px;text-align:center;font-size:12px;margin-top:18px;line-height:1.6}
</style></head><body>
<h1>dsh-super-agent — WeChat login</h1>
<div class="sub">scan with WeChat, confirm on your phone — credentials land in the engine db</div>
<button id="btn" onclick="gen()">Show QR code</button>
<div id="qr"></div><div id="st"></div>
<div class="q">The QR is short-lived: the page refreshes it by itself — just keep the scanner open.<br>
This page binds localhost only; nothing leaves this machine.</div>
<script>
let busy=false, done=false;
async function gen(){ if(busy||done)return; busy=true;
  btn.disabled=true; st.className=''; st.textContent='fetching…'; qr.innerHTML='';
  let r; try{ r=await (await fetch('/qr')).json(); }catch(e){ st.textContent='error: '+e; busy=false; btn.disabled=false; return; }
  if(r.err){ st.textContent='error: '+r.err; busy=false; btn.disabled=false; return; }
  qr.innerHTML='<img src="'+r.img+'">'; st.textContent='waiting for scan…'; busy=false;
  await poll(r.born);}
async function poll(born){ for(;;){ await new Promise(x=>setTimeout(x,1500)); if(done)return;
  let s; try{ s=await (await fetch('/status')).json(); }catch{ continue; }
  if(s.state==='wait'){ st.textContent='waiting for scan…'; }
  else if(s.state==='scaned'){ st.textContent='scanned — confirm on your phone'; }
  else if(s.state==='confirmed'){ done=true; st.className='ok'; st.textContent='\\u2705 logged in — the watch daemon (same --db) picks it up automatically'; btn.style.display='none'; return; }
  if(Date.now()-born>${QR_LIFETIME_MS}){ st.textContent='QR expired — refreshing…'; return gen(); } } }
</script></body></html>`;

/** The same request headers wechatLogin sends (bot-token auth + random UIN). */
function ilinkHeaders(): Record<string, string> {
  return { "content-type": "application/json", AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": randomBytes(4).toString("hex") };
}

export interface LoginWebHandle {
  server: Server;
  /** resolves with the binder once the login completes and the server has closed */
  done: Promise<{ binder: string | null }>;
}

export interface LoginWebOptions {
  engine: Engine;
  port: number;
  host?: string;
  /** → data URL for the QR image (injectable for tests) */
  qrOf?: (content: string) => Promise<string>;
  /** fetch override for the iLink endpoints (tests); the page's own /qr /status drive the flow */
  iLinkFetch?: typeof fetch;
  log?: (l: string) => void;
}

/**
 * Serve the login page on localhost. The page drives the flow (its /qr and /status
 * calls); when the phone confirms, credentials + binder are stored exactly as the
 * terminal `wechat-login` stores them, the server closes, and `done` resolves.
 */
export function wechatLoginWeb(opts: LoginWebOptions): Promise<LoginWebHandle> {
  const store = new EngineWechatStore(opts.engine);
  const doFetch = opts.iLinkFetch ?? (fetch as typeof fetch);
  const toDataUrl =
    opts.qrOf ??
    (async (content: string) => {
      const { default: QR } = await import("qrcode");
      return QR.toDataURL(content, { width: 280, margin: 1 });
    });

  // the two iLink endpoints, routed through the injectable fetch (the page drives the flow)
  const getQr = async () => {
    const res = await doFetch(`${WECHAT_DEFAULT_BASE.replace(/\/$/, "")}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: "POST",
      headers: ilinkHeaders(),
      body: JSON.stringify({ local_token_list: [] }),
    });
    const qr = (await res.json()) as { qrcode?: string; qrcode_img_content?: string };
    if (!qr.qrcode) throw new Error("get_bot_qrcode returned no qrcode");
    return { qrcode: qr.qrcode, imgContent: qr.qrcode_img_content ?? "" };
  };
  const getStatus = async (qrcode: string) => {
    const res = await doFetch(`${WECHAT_DEFAULT_BASE.replace(/\/$/, "")}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { headers: ilinkHeaders() });
    return (await res.json()) as { status?: string; bot_token?: string; baseurl?: string; ilink_user_id?: string; user_id?: string };
  };

  let current: { qrcode: string; born: number } | null = null;
  let finished = false;

  return new Promise<LoginWebHandle>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const send = (code: number, type: string, body: string) => {
        res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
      };
      const url = new URL(req.url ?? "/", "http://local");
      try {
        if (req.method === "GET" && url.pathname === "/") return send(200, "text/html; charset=utf-8", LOGIN_WEB_PAGE);
        if (req.method === "POST" && url.pathname === "/qr") {
          if (finished) return send(200, "application/json", JSON.stringify({ err: "already logged in" }));
          const qr = await getQr();
          current = { qrcode: qr.qrcode, born: Date.now() };
          const img = await toDataUrl(qr.imgContent);
          return send(200, "application/json", JSON.stringify({ img, born: current.born }));
        }
        if (req.method === "GET" && url.pathname === "/status") {
          if (finished) return send(200, "application/json", JSON.stringify({ state: "confirmed" }));
          if (!current) return send(200, "application/json", JSON.stringify({ state: "none" }));
          const st = await getStatus(current.qrcode);
          if (st.status === "confirmed" && st.bot_token) {
            finished = true;
            store.saveAuth({ token: st.bot_token, baseUrl: st.baseurl ?? WECHAT_DEFAULT_BASE });
            const binder = st.ilink_user_id ?? st.user_id ?? null;
            if (binder) opts.engine.kvSet("wechat_binder", binder);
            opts.log?.(`[wechat] logged in via web page — binder ${binder ?? "(unknown)"}`);
            server.close();
            return send(200, "application/json", JSON.stringify({ state: "confirmed" }));
          }
          const state = st.status === "expired" ? "expired" : st.status === "scaned" ? "scaned" : "wait";
          return send(200, "application/json", JSON.stringify({ state }));
        }
        send(404, "text/plain", "not found");
      } catch (e) {
        send(200, "application/json", JSON.stringify({ state: "wait", err: e instanceof Error ? e.message : String(e) }));
      }
    });
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const done = new Promise<{ binder: string | null }>((resolveDone) => {
        server.once("close", () => resolveDone({ binder: opts.engine.kvGet("wechat_binder") }));
      });
      resolve({ server, done });
    });
  });
}
