// Locale (v1.5-era i18n, borrowed from the prototype's locale/*.json) — DSH_LOCALE=zh
// switches the human-facing strings; default English keeps every existing behavior.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { runApprovalSweep } from "../src/approval.js";
import type { ReplyChannel } from "../src/source.js";
import { approvalNeeded, disclaimer, receiptNothingPending, ticketNotice } from "../src/locale.js";

beforeEach(() => { process.env.DSH_LOCALE = undefined; });
afterEach(() => { delete process.env.DSH_LOCALE; });

describe("locale module", () => {
  it("defaults to English — the pre-i18n behavior", () => {
    expect(disclaimer()).toBe("This is by an automated agent, not a human.");
    expect(ticketNotice(7, "opened", "explicit")).toContain("Ticket #7 opened (explicit)");
  });

  it("DSH_LOCALE=zh switches the human-facing strings", () => {
    process.env.DSH_LOCALE = "zh";
    expect(disclaimer()).toContain("不是真人");
    expect(ticketNotice(7, "resumed", "inferred")).toContain("工单 #7 已恢复");
    expect(receiptNothingPending()).toContain("没有待回复数字");
    expect(approvalNeeded(9, "line")).toContain("1 重新排队");
  });
});

describe("zh flows through the approval sweep", () => {
  it("renders the 🔑 ask in Chinese when DSH_LOCALE=zh", async () => {
    process.env.DSH_LOCALE = "zh";
    const dir = mkdtempSync(join(tmpdir(), "dsh-loc-"));
    const engine = new Engine(join(dir, "engine.db"));
    try {
      const policy = {
        version: 1, allowedList: ["alice"], botList: [], acceptMode: "observe" as const,
        table: [{ scope: "im_dm" as const, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const }],
        approval: { enabled: true },
      } satisfies Policy;
      engine.setPolicyIfChanged(policy);
      engine.ingest([{ trigger: { id: "wechat:msg/1", source: "wechat", scope: "im_dm", threadId: "wechat:peer/wx_alice", author: { login: "alice", isBot: false }, addressing: true, body: "做点事", ts: new Date().toISOString() }, gate: { strength: "explicit", row: policy.table[0] }, resolution: { action: "accept", basis: "explicit" } }], { wechat: { positions: {} } });
      const aid = engine.startAssignment(1, "");
      engine.endAssignment(aid, 1, false, "boom");
      const sent: string[] = [];
      const ch: ReplyChannel = { matches: (t) => t.startsWith("wechat:"), deliver: async (_t, b) => { sent.push(b); return { externalId: "m1" }; } };
      // one drain for the ticket-open notice, one for the approval ask
      await runApprovalSweep(engine, policy, [ch]);
      const ask = sent.find((b) => b.includes("需要人工") || b.includes("approval needed"));
      expect(ask).toBeDefined();
      expect(ask).toContain("1 重新排队");
    } finally {
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
