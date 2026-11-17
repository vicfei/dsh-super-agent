# BYO-judge — decision models as the slow-path assessor (#133)

> Design page for v1.6+/v1.7. The judge is being commoditized as a model class
> (Piccolo ships "decision models for agent tool review"; QwenPaw merged assess_tool_call).
> dsh's answer is judge-agnosticism: **bring your own judge — dsh supplies the
> constitution the judge operates under.**

## Contract

`--assessment` grows a third mode next to `stub` and `llm`:

```sh
dsh watch --assessment decision --judge-base-url … --judge-model piccolo-27b …
```

- The decision assessor talks to any endpoint exposing candidate probability mass
  (Piccolo natively via `/v1/systemone`; adapters may translate other formats).
- Input: the trigger envelope (author/scope/thread/body) as candidate options
  (`admit` / `reject`), plus the policy's assessment rubric as instructions.
- Output: candidate scores → verdict with the score attached:
  `positive 0.91` / `negative 0.83`. The score is recorded on the decision row
  (`basis` carries it), so `dsh review` can report calibration per judge —
  accuracy AND confidence quality (ECE), the Piccolo lesson.

## What dsh supplies around any judge

1. The deterministic admission table (who is even a candidate);
2. Versioned policy + the observe/auto ladder — a judge never flips modes;
3. The hash-chained ledger — every judgment is evidence, tamper-evident;
4. The human surface — rungs are granted by a person, not by a score.

A judge swap is a config change, not a governance change. Even a competitor's
decision model becomes dsh's assess layer.

## Open items (pre-implementation)

- [ ] Piccolo endpoint access (ModelScope free tier feasibility — sibling window owns the probe)
- [ ] Envelope schema: one page, verified against the generated Cordis catalog
- [ ] Score threshold policy: per-scope floor (default 0.5, policy-tunable)
