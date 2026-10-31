import { describe, expect, it, vi } from "vitest";
import type { Trigger } from "../src/domain.js";
import { llmAssessor } from "../src/assess.js";

const trigger: Trigger = {
  id: "github:issue:1", source: "github", scope: "issue", threadId: "github:o/r/issues/5",
  author: { login: "alice", isBot: false }, addressing: false,
  body: "the build fails on main since #12", ts: "2026-11-02T00:00:00Z",
};

function respondWith(content: string, status = 200): typeof fetch {
  return vi.fn(async (): Promise<Response> =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;
}

describe("llmAssessor", () => {
  it("parses positive / negative replies", async () => {
    expect(await llmAssessor({ baseUrl: "https://x/v1", model: "m", fetchImpl: respondWith("positive") }).assess(trigger)).toBe("positive");
    expect(await llmAssessor({ baseUrl: "https://x/v1", model: "m", fetchImpl: respondWith("Negative.") }).assess(trigger)).toBe("negative");
  });

  it("fails closed on HTTP errors, ambiguity, and network throws", async () => {
    const err = llmAssessor({ baseUrl: "https://x/v1", model: "m", fetchImpl: respondWith("denied", 401) });
    expect(await err.assess(trigger)).toBe("negative");
    const weird = llmAssessor({ baseUrl: "https://x/v1", model: "m", fetchImpl: respondWith("perhaps?") });
    expect(await weird.assess(trigger)).toBe("negative");
    const dead = llmAssessor({
      baseUrl: "https://x/v1", model: "m",
      fetchImpl: vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    });
    expect(await dead.assess(trigger)).toBe("negative");
  });

  it("sends the compact event JSON to any OpenAI-compatible endpoint", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      expect(body.messages[1].content).toContain("the build fails on main since #12");
      return new Response(JSON.stringify({ choices: [{ message: { content: "positive" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await llmAssessor({ baseUrl: "https://x/v1/", model: "m", fetchImpl }).assess(trigger);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
