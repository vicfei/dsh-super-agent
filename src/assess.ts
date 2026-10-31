// Assessment (Slow Path) — only inferred candidates reach an LLM judgement (docs/002: accepting
// an inferred candidate always requires an assessment). Model-agnostic: any OpenAI-compatible
// /chat/completions endpoint. Fails closed: any error or ambiguous reply counts as negative.

import type { Trigger } from "./domain.js";
import type { Assessment } from "./gate.js";

export interface Assessor {
  assess(trigger: Trigger): Promise<Assessment>;
}

export function stubAssessor(verdict: Assessment): Assessor {
  return { assess: async () => verdict };
}

export interface LlmAssessorOptions {
  baseUrl: string;
  model: string;
  apiKey?: string; // from env at the CLI boundary, never stored
  fetchImpl?: typeof fetch;
}

const SYSTEM = [
  "You are the assessment layer of a coding-team agent. Decide whether this event should start (or resume) work.",
  'Reply with exactly one word: positive or negative.',
  "Work = a concrete task the team's agent could usefully do or answer in its repository: a bug report, a feature request, a question to answer, a review comment to address.",
  "Negative = social chatter, acknowledgements, bot/CI noise, off-topic content, or anything that needs no action.",
].join(" ");

export function llmAssessor(opts: LlmAssessorOptions): Assessor {
  const doFetch = opts.fetchImpl ?? fetch;
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
            max_tokens: 8,
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
          console.warn(`[assess] endpoint ${res.status} — failing closed to negative`);
          return "negative";
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = (data.choices?.[0]?.message?.content ?? "").toLowerCase();
        if (content.includes("positive")) return "positive";
        if (content.includes("negative")) return "negative";
        console.warn(`[assess] ambiguous reply ${JSON.stringify(content)} — failing closed to negative`);
        return "negative";
      } catch (e) {
        console.warn(`[assess] ${e instanceof Error ? e.message : e} — failing closed to negative`);
        return "negative";
      }
    },
  };
}
