/**
 * Token counting, REAL tokenizer (gpt-tokenizer, o200k_base BPE, pure JS so it
 * works inside the packaged .exe). Counts are absolute, not estimates.
 *
 * A memo cache dedupes repeated counts (the whole-file baseline re-tokenizes
 * the same file contents across many queries). Falls back to the old chars/4
 * heuristic only if the tokenizer throws, and marks itself so reports can say
 * which counter produced the numbers.
 */
import { countTokens } from "gpt-tokenizer";

const memo = new Map();
const MEMO_CAP = 5000;

export let tokenizerName = "o200k_base (gpt-tokenizer)";

export function estimateTokens(text) {
  if (!text) return 0;
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let n;
  try {
    n = countTokens(text);
  } catch {
    n = Math.ceil(text.length / 4); // defensive fallback, should not happen
    tokenizerName = "chars/4 fallback";
  }
  if (memo.size >= MEMO_CAP) memo.clear();
  memo.set(text, n);
  return n;
}

export function clearTokenMemo() {
  memo.clear();
}
