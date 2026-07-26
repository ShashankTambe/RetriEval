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
  if (limit) generated = generated.slice(0, limit);

  return {
    questions: [...control, ...llm, ...generated],
    counts: { control: control.length, llm: llm.length, generated: generated.length },
  };
}
