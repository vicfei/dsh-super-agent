import { describe, expect, it } from "vitest";
import { defaultRow, type Policy, type Trigger } from "../src/domain.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";

const policy: Policy = {
  version: 1,
  allowedList: ["alice", "bob"],
  botList: ["ci-bot"],
  acceptMode: "observe",
  table: ["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci"].map(defaultRow),
};

function trig(partial: Partial<Trigger> = {}): Trigger {
  return {
    id: "t1",
    source: "github",
    scope: "issue_comment",
    threadId: "github:o/r/issues/42",
    author: { login: "alice", isBot: false },
    addressing: true,
    body: "please fix",
    ts: "2026-11-01T00:00:00Z",
    ...partial,
  };
}

describe("evaluateGate (deterministic Fast Path)", () => {
  it("allowed person addressing the agent → explicit", () => {
    expect(evaluateGate(policy, trig())).toMatchObject({ strength: "explicit" });
  });

  it("allowed person not addressing in a receive-all scope → inferred", () => {
    expect(evaluateGate(policy, trig({ addressing: false }))).toMatchObject({ strength: "inferred" });
  });

  it("unlisted person addressing → ignored by default cell", () => {
    expect(evaluateGate(policy, trig({ author: { login: "eve", isBot: false } }))).toMatchObject({ strength: null });
  });

  it("unlisted person not addressing → ignored", () => {
    expect(evaluateGate(policy, trig({ addressing: false, author: { login: "eve", isBot: false } }))).toMatchObject({ strength: null });
  });

  it("listed bot addressing → inferred, never explicit (even if on allowedList)", () => {
    const botFriendly: Policy = { ...policy, allowedList: ["alice", "ci-bot"] };
    const g = evaluateGate(botFriendly, trig({ author: { login: "ci-bot", isBot: true } }));
    expect(g).toMatchObject({ strength: "inferred" });
  });

  it("known bot not addressing → follows cell (default ignore; configured inferred admits)", () => {
    expect(
      evaluateGate(policy, trig({ addressing: false, author: { login: "ci-bot", isBot: true }, scope: "issue" })),
    ).toMatchObject({ strength: null });
    const ciListen: Policy = {
      ...policy,
      table: policy.table.map((r) =>
        r.scope === "ci" ? { ...r, unlistedNotAddressing: "inferred" as const } : r,
      ),
    };
    expect(
      evaluateGate(ciListen, trig({ addressing: false, author: { login: "ci-bot", isBot: true }, scope: "ci" })),
    ).toMatchObject({ strength: "inferred" });
  });

  it("cell override: unlisted-addressing set to inferred → inferred", () => {
    const open: Policy = {
      ...policy,
      table: policy.table.map((r) =>
        r.scope === "issue_comment" ? { ...r, unlistedAddressing: "inferred" as const } : r,
      ),
    };
    expect(evaluateGate(open, trig({ author: { login: "eve", isBot: false } }))).toMatchObject({ strength: "inferred" });
  });

  it("missing scope row → all cells ignore (explicit is identity-based, needs no cell)", () => {
    const empty: Policy = { ...policy, table: [] };
    expect(evaluateGate(empty, trig({ author: { login: "eve", isBot: false } }))).toMatchObject({ strength: null });
    expect(evaluateGate(empty, trig({ addressing: false, author: { login: "eve", isBot: false } }))).toMatchObject({ strength: null });
    expect(evaluateGate(empty, trig({ addressing: false }))).toMatchObject({ strength: null });
    expect(evaluateGate(empty, trig())).toMatchObject({ strength: "explicit" });
  });
});

describe("resolveCandidate (mode ladder)", () => {
  const gate = evaluateGate(policy, trig()); // alice → explicit
  const inferredGate = evaluateGate(policy, trig({ addressing: false })); // alice not addressing → inferred
  const ignoredGate = evaluateGate(policy, trig({ author: { login: "eve", isBot: false } }));

  it("explicit works in every mode, even with a negative assessment", () => {
    for (const acceptMode of ["off", "observe", "auto"] as const) {
      const r = resolveCandidate({ ...policy, acceptMode }, gate, "negative");
      expect(r).toMatchObject({ action: "accept", strength: "explicit" });
    }
  });

  it("ignored triggers never become candidates", () => {
    expect(resolveCandidate(policy, ignoredGate, "positive")).toMatchObject({ action: "reject" });
  });

  it("off: nothing inferred becomes a candidate", () => {
    const r = resolveCandidate({ ...policy, acceptMode: "off" }, inferredGate, "positive");
    expect(r).toMatchObject({ action: "reject" });
  });

  it("observe: positive assessment recorded as shadow 'would accept', nothing accepted", () => {
    const r = resolveCandidate({ ...policy, acceptMode: "observe" }, inferredGate, "positive");
    expect(r).toMatchObject({ action: "shadow", wouldAccept: true });
  });

  it("auto: positive assessment accepts", () => {
    const r = resolveCandidate({ ...policy, acceptMode: "auto" }, inferredGate, "positive");
    expect(r).toMatchObject({ action: "accept", strength: "inferred" });
  });

  it("negative assessment rejects an inferred candidate in every mode", () => {
    for (const acceptMode of ["off", "observe", "auto"] as const) {
      expect(resolveCandidate({ ...policy, acceptMode }, inferredGate, "negative")).toMatchObject({ action: "reject" });
    }
  });

  it("inferred candidate cannot be resolved without an assessment (direct accept refused)", () => {
    expect(() => resolveCandidate(policy, inferredGate, undefined)).toThrow(/assessment/);
  });
});
