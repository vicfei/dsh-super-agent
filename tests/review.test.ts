// `dsh review` (v1.6) — longitudinal trust from the decision log. Pure reads, offline.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { reviewReport, formatReview } from "../src/review.js";

let dir: string;
let engine: Engine;

const base: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "observe",
  table: ["issue", "issue_comment", "im_dm"].map((s) => ({
    scope: s as never,
    listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  })),
};

const trig = (n: number, scope: string, thread: string): Trigger => ({
  id: `github:${scope}:${n}`, source: "github", scope: scope as never, threadId: thread,
  author: { login: "alice", isBot: false }, addressing: false, body: `task ${n}`, ts: new Date().toISOString(),
});

function ingest(t: Trigger, assessment: "positive" | "negative" = "positive") {
  const gate = evaluateGate(engine.policy()!, t);
  engine.ingest([{ trigger: t, gate, resolution: resolveCandidate(engine.policy()!, gate, assessment) }]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-review-"));
  engine = new Engine(join(dir, "e.db"));
  engine.setPolicyIfChanged(base); // v1, observe
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("reviewReport", () => {
  it("accumulates scope evidence; only CURRENT-era shadows earn a rung suggestion", () => {
    // v1 observe: 12 shadows across 3 issue threads + 1 assessor rejection on im_dm
    for (let i = 0; i < 12; i++) ingest(trig(i, "issue", `github:o/r/issues/${100 + (i % 3)}`));
    ingest(trig(90, "im_dm", "wechat:peer/x"), "negative");

    let r = reviewReport(engine);
    expect(r.currentVersion).toBe(1);
    expect(r.overview).toEqual({ decisions: 13, shadows: 12, autoAccepts: 0, negatives: 1 });
    const issue = r.byScope.find((x) => x.scope === "issue")!;
    expect(issue.shadows).toBe(12);
    expect(issue.shadowsCurrent).toBe(12);
    expect(issue.suggestion).toBe("auto-candidate");
    expect(r.byScope.find((x) => x.scope === "im_dm")!.suggestion).toBe("hold");
    expect(r.byPolicyVersion).toEqual([{ version: 1, decisions: 13, wouldAccept: 12 }]);

    // v2 (still observe): the 12 v1-era shadows NO LONGER earn — the live-finding fix
    const v2: Policy = { ...base, version: 2 };
    engine.setPolicyIfChanged(v2);
    r = reviewReport(engine);
    const after = r.byScope.find((x) => x.scope === "issue")!;
    expect(after.shadows).toBe(12);
    expect(after.shadowsCurrent).toBe(0);
    expect(after.suggestion).toBe("insufficient"); // stale era, not current evidence
    expect(formatReview(r)).toContain("(0 under v2)");

    // fresh v2-era evidence re-earns the rung
    for (let i = 100; i < 110; i++) ingest(trig(i, "issue", `github:o/r/issues/${200 + (i % 3)}`));
    r = reviewReport(engine);
    expect(r.byScope.find((x) => x.scope === "issue")!.suggestion).toBe("auto-candidate");
    const text = formatReview(r);
    expect(text).toContain("**auto-candidate**");
    expect(text).toContain("github:o/r/issues/100");

    // v3 flips to auto: inferred candidates now ACCEPT; eras table shows all three
    const v3: Policy = { ...base, version: 3, acceptMode: "auto" };
    engine.setPolicyIfChanged(v3);
    ingest(trig(50, "issue", "github:o/r/issues/100"));
    r = reviewReport(engine);
    expect(r.overview.autoAccepts).toBe(1);
    expect(r.byPolicyVersion).toHaveLength(3);
    expect(r.byPolicyVersion[2]).toEqual({ version: 3, decisions: 1, wouldAccept: 0 });
    expect(formatReview(r)).toContain("the computable promotion review");
  });

  it("thin evidence is 'insufficient', window and scope filters apply", () => {
    for (let i = 0; i < 4; i++) ingest(trig(i, "issue_comment", "github:o/r/issues/9"));
    const r = reviewReport(engine, { scope: "issue_comment" });
    expect(r.byScope[0].suggestion).toBe("insufficient");
    expect(r.overview.decisions).toBe(4);
    expect(reviewReport(engine, { scope: "im_dm" }).overview.decisions).toBe(0);
  });
});
