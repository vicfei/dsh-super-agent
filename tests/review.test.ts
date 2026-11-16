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
  it("accumulates scope evidence, suggests rungs, and tracks policy eras", () => {
    // v1 observe: 12 shadows across 3 issue threads + 1 assessor rejection on im_dm
    for (let i = 0; i < 12; i++) ingest(trig(i, "issue", `github:o/r/issues/${100 + (i % 3)}`));
    ingest(trig(90, "im_dm", "wechat:peer/x"), "negative");

    let r = reviewReport(engine);
    expect(r.overview).toEqual({ decisions: 13, shadows: 12, autoAccepts: 0, negatives: 1 });
    const issue = r.byScope.find((s) => s.scope === "issue")!;
    expect(issue.shadows).toBe(12);
    expect(issue.threads).toBe(3);
    expect(issue.suggestion).toBe("auto-candidate");
    expect(r.byScope.find((s) => s.scope === "im_dm")!.suggestion).toBe("hold");
    expect(r.byPolicyVersion).toEqual([{ version: 1, decisions: 13, wouldAccept: 12 }]);

    // grant the rung: v2 flips issue to auto — inferred candidates now ACCEPT
    const v2: Policy = { ...base, version: 2, acceptMode: "auto" };
    engine.setPolicyIfChanged(v2);
    ingest(trig(50, "issue", "github:o/r/issues/100")); // inferred → accept in auto
    r = reviewReport(engine);
    expect(r.overview.autoAccepts).toBe(1);
    expect(r.byPolicyVersion).toHaveLength(2);
    expect(r.byPolicyVersion[1]).toEqual({ version: 2, decisions: 1, wouldAccept: 0 }); // would_accept marks SHADOW rows; a real auto-accept is not a shadow

    const text = formatReview(r);
    expect(text).toContain("the computable promotion review");
    expect(text).toContain("**auto-candidate**");
    expect(text).toContain("v2: 1 decisions, 0 would-accept");
    expect(text).toContain("github:o/r/issues/100");
  });

  it("thin evidence is 'insufficient', window and scope filters apply", () => {
    for (let i = 0; i < 4; i++) ingest(trig(i, "issue_comment", "github:o/r/issues/9"));
    const r = reviewReport(engine, { scope: "issue_comment" });
    expect(r.byScope[0].suggestion).toBe("insufficient");
    expect(r.overview.decisions).toBe(4);
    expect(reviewReport(engine, { scope: "im_dm" }).overview.decisions).toBe(0);
  });
});
