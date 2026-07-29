/**
 * Question bank, the "question setter" assembly (DECISIONS.md §D).
 *
 * Merges three provenance-tagged strata, reported SEPARATELY downstream so a
 * clean human ruler is never hidden behind an average:
 *   - control   (author: human):      the curated gold seed. Doubles as the
 *                                       neutral ruler AND the dialect exemplars.
 *   - generated (author: mechanical):  ts-morph templated questions, deterministic.
 *   - llm       (author: <model>):     styleguided, answer-anchored authoring,
 *                                       FROZEN to disk by tools/authorQuestions.mjs
 *                                       and loaded here. The eval never invokes an
 *                                       LLM live, that would break determinism.
 *
 * Every question is answer-anchored to the mechanical dump (control/llm by
 * construction; generated because it IS the dump), the answer never comes from
 * a contestant. This function is fully deterministic: it only reads frozen files.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { generate } from "./genQuestionsLib.mjs";

const MODULE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const tag = (q, author, stratum) => ({ ...q, author, stratum, source: q.source || stratum });

/**
 * Sample down to `limit` questions while PRESERVING the category mix.
 *
 * generate() emits every Location question first, then Relationship, then Flow,
 * so a flat slice(0, limit) yields a Location-ONLY bank (measured: angular/core
 * at limit=1000 gave 1000 Location and zero of everything else). Location is
 * both the easiest category and the one lexical retrieval does best on, so that
 * silently turned every limited run into a benchmark that flattered grep.
 *
 * Three properties this has to get right, each of which a naive version misses:
 *   - EXACTLY `limit` questions. Independently-rounded per-bucket quotas do not
 *     sum to the total, so the count would drift by repo and "questions run"
 *     would stop being comparable between targets.
 *   - Every category represented, even when `limit` is tiny. Otherwise small
 *     limits quietly reproduce the original Location-only bug.
 *   - Picks spanning each bucket's FULL range. A fixed stride can never reach
 *     the final entries, so questions about files that sort last would be
 *     permanently invisible no matter how many runs you do.
 *
 * Deterministic by construction: Map iteration is insertion-ordered, insertion
 * follows generate()'s deterministic walk, and every tie-break falls back to
 * that order. No randomness anywhere.
 */
export function sampleStratified(questions, limit) {
  if (!limit || questions.length <= limit) return questions;

  const groups = new Map();
  for (const q of questions) {
    const key = (q.id || "").replace(/[0-9]/g, "") || q.category || "?";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const keys = [...groups.keys()];
  const size = (k) => groups.get(k).length;
  const quota = new Map(keys.map((k) => [k, 0]));

  if (limit <= keys.length) {
    // Fewer slots than categories: one each to the largest, so even limit=3
    // spans three categories rather than collapsing onto Location.
    [...keys]
      .sort((a, b) => size(b) - size(a) || keys.indexOf(a) - keys.indexOf(b))
      .slice(0, limit)
      .forEach((k) => quota.set(k, 1));
  } else {
    // One guaranteed slot per category, then largest-remainder over what's left
    // so the quotas sum to exactly `limit` and stay proportional.
    const rest = limit - keys.length;
    const exact = new Map(keys.map((k) => [k, (size(k) / questions.length) * rest]));
    let placed = 0;
    for (const k of keys) {
      const whole = Math.floor(exact.get(k));
      quota.set(k, 1 + whole);
      placed += whole;
    }
    const frac = (k) => exact.get(k) - Math.floor(exact.get(k));
    const byRemainder = [...keys].sort((a, b) => frac(b) - frac(a) || keys.indexOf(a) - keys.indexOf(b));
    for (let i = 0; i < rest - placed; i++) {
      const k = byRemainder[i % byRemainder.length];
      quota.set(k, quota.get(k) + 1);
    }
  }

  // A bucket can be handed more slots than it holds; give the surplus back to
  // buckets that still have room so the total still lands exactly on `limit`.
  let surplus = 0;
  for (const k of keys) {
    if (quota.get(k) > size(k)) {
      surplus += quota.get(k) - size(k);
      quota.set(k, size(k));
    }
  }
  while (surplus > 0) {
    const room = keys.filter((k) => quota.get(k) < size(k));
    if (!room.length) break;
    for (const k of room) {
      if (surplus === 0) break;
      quota.set(k, quota.get(k) + 1);
      surplus--;
    }
  }

  const out = [];
  for (const k of keys) {
    const list = groups.get(k);
    const take = quota.get(k);
    if (!take) continue;
    if (take >= list.length) {
      out.push(...list);
      continue;
    }
    // Endpoints included, so the last questions in a bucket stay reachable.
    for (let i = 0; i < take; i++) {
      out.push(list[take === 1 ? 0 : Math.round((i * (list.length - 1)) / (take - 1))]);
    }
  }
  return out;
}

/** Read a frozen question file for this repo from answer-key/<repo>/<file>. */
function loadFrozen(repoName, file) {
  const p = join(MODULE_ROOT, "answer-key", repoName, file);
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // frozen sets are optional; never fail a run over one
  }
}

/**
 * Build the merged question bank (deterministic).
 * opts: { limit }
 */
export function buildQuestionBank(dump, opts = {}) {
  const { limit } = opts;

  const curated = loadFrozen(dump.repo.name, "curated.questions.json");
  const control = (curated?.questions || []).map((q) => tag(q, "human", "control"));

  const authoredDoc = loadFrozen(dump.repo.name, "authored.questions.json");
  const llm = (authoredDoc?.questions || []).map((q) =>
    tag(q, q.author || authoredDoc.author || "llm", "llm"));

  let generated = generate(dump).map((q) => tag(q, "mechanical", "generated"));
  if (limit) generated = sampleStratified(generated, limit);

  return {
    questions: [...control, ...llm, ...generated],
    counts: { control: control.length, llm: llm.length, generated: generated.length },
  };
}
