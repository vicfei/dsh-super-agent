// Reply discipline — the article §3.3 / prototype docs/004 rule: chat replies are one sentence by
// default with a hard limit of 100 words. clipReply enforces the hard limit; being concise is the
// caller's (prompt's) job.

/** Latin tokens count as words; every CJK char counts as one word. */
export function wordCount(text: string): number {
  const latin = (text.match(/[A-Za-z0-9'’_-]+/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return latin + cjk;
}

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_WORD = /[A-Za-z0-9'’_-]/;

export function clipReply(text: string, maxWords = 100): string {
  const trimmed = text.trim();
  if (wordCount(trimmed) <= maxWords) return trimmed;
  let used = 0;
  let out = "";
  let latin = "";
  for (const ch of trimmed) {
    if (used >= maxWords) break;
    if (LATIN_WORD.test(ch)) { latin += ch; continue; }
    if (latin) { out += latin; used++; latin = ""; }
    if (CJK.test(ch)) { out += ch; used++; } // CJK has no spaces: charge per char
    else out += ch; // separators/punctuation ride along
  }
  if (latin && used < maxWords) out += latin;
  return `${out.trimEnd()} …`;
}
