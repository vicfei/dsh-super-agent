// BYO-judge (#133) — the decision assessor turns probability mass over candidate tokens
// into a scored verdict. All offline: fetch is injected, exactly like the llm-assessor tests.
import { describe, expect, it, vi } from "vitest";
import type { Trigger } from "../src/domain.js";
import { decisionAssessor, candidateMass } from "../src/judge.js";
import { resolveCandidate, evaluateGate, type Assessment } from "../src/gate.js";
import type { Policy } from "../src/domain.js";

const trigger: Trigger = {
  id: "github:issue:1", source: "github", scope: "issue", threadId: "github:o/r/issues/5",
  // allowed + NOT addressing → inferred strength: the only path that consults the slow path
  author: { login: "alice", isBot: false }, addressing: false, body: "fix the crash on boot",
  ts: "2026-11-18T00:00:00Z",
};

const policy: Policy = {
  version: 1, allowedList: ["alice"], botList: [], acceptMode: "observe",
  table: ["issue"].map(s => ({ scope: s as never, listedNotAddressing: "inferred" as const, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const })),
};

const topLogprobs = (entries: [string, number][]) => ({ choices: [{ logprobs: { content: [{ top_logprobs: entries.map(([token, logprob]) => ({ token, logprob })) }] } }] });

describe("candidateMass", () => {
  it("sums and normalizes mass over the two candidates, tolerating case and padding", () => {
    const m = candidateMass([{ token: " Admit", logprob: Math.log(0.6) }, { token: "reject", logprob: Math.log(0.3) }], { positive: "admit", negative: "reject" });
    expect(m).not.toBeNull();
    expect(m!.positive).toBeCloseTo(0.6);
    expect(m!.negative).toBeCloseTo(0.3);
  });
  it("mass on other tokens is ignored for normalization purposes", () => {
    const m = candidateMass([{ token: "maybe", logprob: Math.log(0.5) }, { token: "admit", logprob: Math.log(0.25) }, { token: "reject", logprob: Math.log(0.25) }], { positive: "admit", negative: "reject" });
    expect(m!.positive).toBeCloseTo(0.25);
    expect(m!.negative).toBeCloseTo(0.25);
  });
  it("no mass on either candidate → null (ambiguous judge = failed judge)", () => {
    expect(candidateMass([{ token: "banana", logprob: 0 }], { positive: "admit", negative: "reject" })).toBeNull();
  });
});

describe("decisionAssessor", () => {
  it("P(admit) above threshold → scored positive verdict", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(topLogprobs([["admit", Math.log(0.91)], ["reject", Math.log(0.08)]])), { status: 200 }));
    const a = decisionAssessor({ baseUrl: "http://j", model: "piccolo-27b", fetchImpl: fetchImpl as unknown as typeof fetch });
    const v = await a.assess(trigger);
    expect(v).toEqual({ verdict: "positive", score: 0.92, judge: "piccolo-27b" });
  });

  it("P(admit) below threshold → scored negative — the threshold is the policy's floor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(topLogprobs([["admit", Math.log(0.4)], ["reject", Math.log(0.58)]])), { status: 200 }));
    const a = decisionAssessor({ baseUrl: "http://j", model: "m", threshold: 0.8, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await a.assess(trigger)).toEqual({ verdict: "negative", score: 0.41, judge: "m" });
  });

  it("fails closed: endpoint error, missing logprobs, and no candidate mass → negative tagged with the judge (visible as unreachable)", async () => {
    const err = decisionAssessor({ baseUrl: "http://j", model: "m", fetchImpl: vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch });
    expect(await err.assess(trigger)).toEqual({ verdict: "negative", judge: "m" });
    const noLp = decisionAssessor({ baseUrl: "http://j", model: "m", fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "admit" } }] }), { status: 200 })) as unknown as typeof fetch });
    expect(await noLp.assess(trigger)).toEqual({ verdict: "negative", judge: "m" });
    const offTopic = decisionAssessor({ baseUrl: "http://j", model: "m", fetchImpl: vi.fn(async () => new Response(JSON.stringify(topLogprobs([["banana", Math.log(0.9)]])), { status: 200 })) as unknown as typeof fetch });
    expect(await offTopic.assess(trigger)).toEqual({ verdict: "negative", judge: "m" });
    // the unreachable verdict lands in the basis as '· <judge> unreachable'
    const gate = evaluateGate(policy, trigger);
    expect(resolveCandidate(policy, gate, { verdict: "negative", judge: "m" }).basis).toContain("· m unreachable");
  });
});

describe("scored assessment lands in the decision basis", () => {
  it("observe-mode shadows and rejects carry the judge suffix; plain strings stay unchanged", () => {
    const gate = evaluateGate(policy, trigger);
    const scored: Assessment = { verdict: "positive", score: 0.91, judge: "piccolo-27b" };
    const shadow = resolveCandidate(policy, gate, scored);
    expect(shadow.action).toBe("shadow");
    expect(shadow.basis).toContain("· piccolo-27b 0.91");

    const rejected = resolveCandidate(policy, gate, { verdict: "negative", score: 0.83, judge: "piccolo-27b" });
    expect(rejected.action).toBe("reject");
    expect(rejected.basis).toContain("assessed negative");
    expect(rejected.basis).toContain("· piccolo-27b 0.83");

    // string assessments (stub/llm) keep their exact historical basis — no suffix noise
    expect(resolveCandidate(policy, gate, "positive").basis).not.toContain("judge");
    expect(resolveCandidate(policy, gate, "negative").basis).toBe("inferred candidate assessed negative (allowed alice not addressing)");
  });
});
