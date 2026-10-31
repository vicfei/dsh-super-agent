import { describe, expect, it } from "vitest";
import { clipReply, wordCount } from "../src/clip.js";

describe("wordCount", () => {
  it("counts latin tokens and CJK chars", () => {
    expect(wordCount("hello world")).toBe(2);
    expect(wordCount("你好世界")).toBe(4);
    expect(wordCount("已修好 typo，tests pass")).toBe(6); // 3 CJK + 3 latin
  });
});

describe("clipReply (100-word hard limit)", () => {
  it("keeps short text untouched", () => {
    expect(clipReply("fixed in #12.")).toBe("fixed in #12.");
  });

  it("clips at word boundary with ellipsis", () => {
    const long = Array.from({ length: 150 }, (_, i) => `w${i}`).join(" ");
    const out = clipReply(long);
    expect(wordCount(out.replace("…", "").trim())).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("charges CJK chars one word each", () => {
    const long = "好".repeat(120);
    const out = clipReply(long);
    expect(out.replace(/…|\s/g, "").length).toBe(100);
  });
});
