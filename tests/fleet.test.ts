// v1.8 A3 — the fleet panel aggregates engines through a same-origin proxy.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { startPanel } from "../src/panel.js";
import { startFleet } from "../src/fleet.js";

let dir: string;
let up: Awaited<ReturnType<typeof startPanel>>;
let fleet: Awaited<ReturnType<typeof startFleet>>;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dsh-fleet-"));
  const engine = new Engine(join(dir, "e.db"));
  engine.setPolicyIfChanged({ version: 4, allowedList: ["alice"], botList: [], acceptMode: "observe",
    table: ["issue"].map(s => ({ scope: s as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const })) });
  up = await startPanel(engine, 0);
  const upPort = (up.address() as AddressInfo).port;
  fleet = await startFleet([{ name: "dogfood", port: upPort }, { name: "ghost", port: 9 }], 0);
  base = `http://127.0.0.1:${(fleet.address() as AddressInfo).port}`;
});
afterEach(async () => {
  fleet.shutdown();
  await new Promise((r) => fleet.closeAllConnections ? (fleet.closeAllConnections(), setTimeout(r, 20)) : setTimeout(r, 20));
  up.shutdown();
  await new Promise((r) => setTimeout(r, 20));
  rmSync(dir, { recursive: true, force: true });
});

describe("fleet panel", () => {
  it("serves the page with engines embedded", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("dsh fleet");
    expect(html).toContain('"dogfood"');
    expect(html).toContain('"ghost"');
  });

  it("proxies a live engine's state and reports an unknown one", async () => {
    const st = (await (await fetch(`${base}/api/engine/dogfood/api/state`)).json()) as { policy?: { version?: number } };
    expect(st.policy?.version).toBe(4);
    const missing = await fetch(`${base}/api/engine/nope/api/state`);
    expect(missing.status).toBe(404);
    const dead = await fetch(`${base}/api/engine/ghost/api/state`);
    expect(dead.status).toBe(502);
  });
});
