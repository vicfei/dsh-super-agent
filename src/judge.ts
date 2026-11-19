// Decision-model assessor (#133, BYO-judge) — probability mass instead of sampled text.
//
// The judge is being commoditized as a model class (Piccolo ships "decision models for
// agent tool review"). dsh's answer is judge-agnosticism: ANY endpoint that can put
// probability mass on the candidates can serve as the slow path. The universal adapter
// is an OpenAI-compatible /chat/completions call with `logprobs` — the top-logprobs of
// the first generated token give P(admit) vs P(reject) for any model; native decision
// endpoints (Piccolo /v1/systemone) can slot in behind the same interface once probed.
//
// Fails closed exactly like the llm assessor: any error, missing mass, or ambiguous
// candidates count as negative — a broken judge must never admit work.

import type { Trigger } from "./domain.js";
import type { Assessment } from "./gate.js";
import type { Assessor } from "./assess.js";

export interface DecisionAssessorOptions {
  baseUrl: string;
  model: string;
  apiKey?: string; // from env at the CLI boundary, never stored
  /** Candidate tokens, in (positive, negative) order. */
  candidates?: { positive: string; negative: string };
  /** P(positive) ≥ threshold → positive. Default 0.5. */
  threshold?: number;
  /** Name recorded on the decision row (default: the model id). */
  judgeName?: string;
  fetchImpl?: typeof fetch;
}

const SYSTEM = [
  "You are the decision layer of a coding-team agent. Decide whether this event should start (or resume) work.",
  "Reply with exactly one word, nothing else: admit or reject.",
  "Admit = a concrete task the team's agent could usefully do or answer in its repository: a bug report, a feature request, a question to answer, a review comment to address.",
  "Reject = social chatter, acknowledgements, bot/CI noise, off-topic content, or anything that needs no action.",
].join(" ");

interface LogprobEntry { token: string; logprob: number }

/** Sum probability mass per verdict across the candidate tokens found in the first
 *  token's top_logprobs (case/leading-space tolerant). Returns null when NEITHER
 *  candidate carries mass — an ambiguous judge is a failed judge. */
export function candidateMass(
  top: LogprobEntry[],
  candidates: { positive: string; negative: string },
): { positive: number; negative: number } | null {
  const norm = (tok: string) => tok.trim().toLowerCase();
  const want = { positive: norm(candidates.positive), negative: norm(candidates.negative) };
  const mass = { positive: 0, negative: 0 };
  let seen = 0;
  for (const e of top) {
    const tok = norm(e.token);
    if (tok === want.positive) { mass.positive += Math.exp(e.logprob); seen++; }
    else if (tok === want.negative) { mass.negative += Math.exp(e.logprob); seen++; }
  }
  return seen === 0 ? null : mass;
}

export function decisionAssessor(opts: DecisionAssessorOptions): Assessor {
  const doFetch = opts.fetchImpl ?? fetch;
  const candidates = opts.candidates ?? { positive: "admit", negative: "reject" };
  const threshold = opts.threshold ?? 0.5;
  const judge = opts.judgeName ?? opts.model;
  return {
    async assess(trigger: Trigger): Promise<Assessment> {
      try {
        const res = await doFetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: opts.model,
            temperature: 0,
            max_tokens: 1,
            // The whole trick: probability mass over the candidate token, not a sampled sentence.
            logprobs: true,
            top_logprobs: 20,
            messages: [
              { role: "system", content: SYSTEM },
              {
                role: "user",
                content: JSON.stringify({
                  author: trigger.author.login,
                  isBot: trigger.author.isBot,
                  addressing: trigger.addressing,
                  scope: trigger.scope,
                  thread: trigger.threadId,
                  body: trigger.body.slice(0, 2000),
                }),
              },
            ],
          }),
        });
        if (!res.ok) {
          console.warn(`[judge] endpoint ${res.status} — failing closed to negative`);
          return { verdict: "negative", judge };
        }
        const data = (await res.json()) as {
          choices?: { logprobs?: { content?: { top_logprobs?: LogprobEntry[] }[] } }[];
        };
        const top = data.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
        if (!top || top.length === 0) {
          console.warn(`[judge] endpoint returned no top_logprobs — failing closed to negative`);
          return { verdict: "negative", judge };
        }
        const mass = candidateMass(top, candidates);
        if (!mass) {
          console.warn(`[judge] neither "${candidates.positive}" nor "${candidates.negative}" carries mass — failing closed to negative`);
          return { verdict: "negative", judge };
        }
        const total = mass.positive + mass.negative;
        const p = mass.positive / total; // normalized confidence over the two candidates
        return { verdict: p >= threshold ? "positive" : "negative", score: Math.round(p * 100) / 100, judge };
      } catch (e) {
        console.warn(`[judge] ${e instanceof Error ? e.message : e} — failing closed to negative`);
        return { verdict: "negative", judge };
      }
    },
  };
}
