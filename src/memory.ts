// Two-tier memory (v1.4, issue #110) — the distill pass. When a ticket completes, an
// OpenAI-compatible model extracts durable facts (conventions, decisions, gotchas) from the
// report; the engine records them with source-ticket provenance. Fails soft: a distill error
// never fails the ticket — the ticket is already done, memory is a bonus tier.

export interface MemoryDistillInput {
  repo: string;
  ticketId: number;
  /** The completed ticket's report body (worker stdout summary + delivery lines). */
  report: string;
}

/** Returns 0–3 durable facts, each a single line. Empty = nothing worth remembering. */
export type MemoryDistiller = (input: MemoryDistillInput) => Promise<string[]>;

export interface LlmDistillerOptions {
  baseUrl: string;
  model: string;
  apiKey?: string; // from env at the CLI boundary, never stored
  fetchImpl?: typeof fetch;
}

const SYSTEM = [
  "You extract durable project memory from a completed agent ticket.",
  "Keep only facts useful to FUTURE work on this repository: conventions to follow, decisions made (and why), pitfalls discovered, environment quirks.",
  "Discard: one-off details, anything already obvious from the repo, task-specific narration.",
  "Reply with AT MOST 3 lines, each a single bullet starting with '- ' (max 160 chars), or the single word NONE.",
].join(" ");

export function llmDistiller(opts: LlmDistillerOptions): MemoryDistiller {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (input) => {
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
          // 512 like the assessor: reasoning models spend the budget on the chain of thought
          // first, and an empty-content length-cut must not read as "NONE" by accident —
          // we treat a missing/overlong reply as no memories at all (fails soft).
          max_tokens: 512,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `repo: ${input.repo}\nticket #${input.ticketId} report:\n${input.report.slice(0, 4000)}` },
          ],
        }),
      });
      if (!res.ok) {
        console.warn(`[memory] distill endpoint ${res.status} — skipping (ticket already complete)`);
        return [];
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content ?? "";
      return parseMemories(content);
    } catch (e) {
      console.warn(`[memory] distill ${e instanceof Error ? e.message : e} — skipping`);
      return [];
    }
  };
}

/** Deterministic parse: '- ' bullets only, deduped, capped at 3, each trimmed to 160 chars. */
export function parseMemories(content: string): string[] {
  if (/\bnone\b/i.test(content.trim()) && !content.includes("-")) return [];
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    if (!line || line.toLowerCase() === "none") continue;
    if (/^(here are|sure[,!]|i (extracted|found))/i.test(line)) continue; // preamble chatter
    const body = line.slice(0, 160).trim();
    if (body && !out.some((o) => o.toLowerCase() === body.toLowerCase())) out.push(body);
    if (out.length >= 3) break;
  }
  return out;
}
