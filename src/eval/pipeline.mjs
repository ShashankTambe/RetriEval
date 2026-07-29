/**
 * Evaluation pipeline. For a target repo:
 *   1. sandbox-copy source (never touch the real repo)
 *   2. Phase 0, independent static analysis (ts-morph) -> mechanical answer key
 *   3. build the question set: generated (grounded in the key) + curated
 *      paraphrase set when one exists for this repo (brings the
 *      zero-lexical-overlap "none" bucket that machines can't derive)
 *   4. run EACH query variant (canonical + paraphrases) through EACH retriever
 *      (LessTokenify + ripgrep + whole-file), timing every call
 *   5. score: raw file-level Precision/Recall (VISION.md, first-class) +
 *      the weighted composite (secondary) + real token counts + latency
 *   6. aggregate per retriever, per category, per lexical-overlap bucket
 *
 * Phase 0 runs EVERY time and derives ground truth independently, the tool
 * never trusts that the author knows their own repo.
 */
import { makeSandbox, hasSource, SOURCE_DIRS, ROOT_ENTRIES } from "./sandbox.mjs";
import { analyze } from "./staticAnalysisLib.mjs";
import { buildQuestionBank } from "./questionBank.mjs";
import { ltRetrieve, loadLT, findLTRunner } from "./ltAdapter.mjs";
import { ripgrepRetrieve, wholeFileRetrieve, clearLexicalCache } from "./retrievers/lexical.mjs";
import { scoreQuestion, aggregate, rawPR } from "./scorer.mjs";
import { computeFairness } from "./fairness.mjs";
import { tokenizerName, clearTokenMemo } from "./tokens.mjs";

// grep + whole-file are the ZERO-DEPENDENCY core: they run on any TS/JS repo with
// nothing else installed. LessTokenify is an OPTIONAL plugged-in retriever, added
// only when it's actually present (RETRIEVAL_LT_RUNNER / sibling checkout).
const LT_RETRIEVER = { name: "lesstokenify", fn: ltRetrieve, label: "LessTokenify" };
const CORE_RETRIEVERS = [
  { name: "ripgrep", fn: ripgrepRetrieve, label: "grep (lexical)" },
  { name: "wholefile", fn: wholeFileRetrieve, label: "whole-file" },
];
export const RETRIEVER_LABELS = Object.fromEntries([LT_RETRIEVER, ...CORE_RETRIEVERS].map((r) => [r.name, r.label]));

export async function runEvaluation(repoRoot, opts = {}) {
  const { onProgress = () => {}, limit, ltRunnerPath } = opts;

  onProgress({ phase: "sandbox", msg: "Copying repo source to sandbox (your repo is untouched)…" });
  const sandbox = makeSandbox(repoRoot);
  if (!hasSource(sandbox))
    throw new Error(
      `No source root found (looked for ${SOURCE_DIRS.map((d) => d + "/").join(", ")} and root ${ROOT_ENTRIES.join(", ")}). Is this a TS/JS project?`,
    );

  onProgress({ phase: "analyze", msg: "Phase 0, independent static analysis (ts-morph)…" });
  const dump = analyze(sandbox, "gui-run");

  // Refuse to benchmark an empty answer key. hasSource() only proves SOME entry
  // point exists; it can pass on a bare root barrel file (e.g. a monorepo
  // package whose code sits beside index.ts rather than under src/), and the
  // analyzer then finds almost nothing. Without this guard the run completes,
  // scores a handful of questions, and publishes a confident-looking report
  // built on no data, which is far worse than failing outright.
  if (dump.stats.files < 2 || dump.stats.symbols === 0) {
    throw new Error(
      `Static analysis found ${dump.stats.files} source file(s) and ${dump.stats.symbols} symbol(s), too few to benchmark. ` +
      `RetriEval analyzes ${SOURCE_DIRS.map((d) => d + "/").join(" or ")} plus root entry files. ` +
      `If this is a monorepo package whose code sits directly in the package folder, point RetriEval at a directory that has a source folder.`,
    );
  }
  onProgress({ phase: "analyze", msg: `Answer key: ${dump.stats.symbols} symbols, ${dump.stats.callEdges} call edges, ${dump.stats.importEdges} import edges.` });

  onProgress({ phase: "questions", msg: "Building question set…" });
  const bank = buildQuestionBank(dump, { limit });
  const questions = bank.questions;

  // Expand each question into query variants tagged by lexical overlap.
  const runItems = [];
  for (const q of questions) {
    runItems.push({ q, text: q.query_canonical, overlap: "exact", variant: "canonical" });
    for (const p of q.query_paraphrases || [])
      runItems.push({ q, text: p.text, overlap: p.lexical_overlap || "partial", variant: "paraphrase" });
  }
  const c = bank.counts;
  onProgress({
    phase: "questions",
    msg: `${questions.length} questions (${c.control} control · ${c.generated} generated · ${c.llm} llm) → ${runItems.length} query variants.`,
  });

  const ctx = { files: dump.files, ltRunnerPath };
  clearLexicalCache();
  clearTokenMemo();

  // Assemble the active retriever set: LT first when present, else just the core.
  const ltRunner = findLTRunner(ltRunnerPath);
  const RETRIEVERS = ltRunner ? [LT_RETRIEVER, ...CORE_RETRIEVERS] : CORE_RETRIEVERS;

  let ltIndexBuildMs = null;
  if (ltRunner) {
    onProgress({ phase: "retrieve", msg: "Building LessTokenify index…" });
    await loadLT(ltRunner);
    const tIndex = performance.now();
    await ltRetrieve(sandbox, "warmup query", ctx); // builds the LT index once
    ltIndexBuildMs = +(performance.now() - tIndex).toFixed(0);
    onProgress({ phase: "retrieve", msg: `Index built in ${ltIndexBuildMs} ms. Running ${RETRIEVERS.length} retrievers…` });
  } else {
    onProgress({ phase: "retrieve", msg: `LessTokenify not configured, running ${RETRIEVERS.length} baseline retrievers (grep, whole-file).` });
  }

  const results = [];
  for (let i = 0; i < runItems.length; i++) {
    const { q, text, overlap, variant } = runItems[i];
    const by = {};
    for (const r of RETRIEVERS) {
      const t0 = performance.now();
      const ret = await r.fn(sandbox, text, ctx);
      const latencyMs = +(performance.now() - t0).toFixed(1);
      by[r.name] = {
        score_detail: scoreQuestion(q, ret),
        raw: rawPR(q, ret.files),
        returned: ret.files.map((f) => ({ file: f.file, score: f.score })),
        contextTokens: ret.contextTokens,
        latencyMs,
      };
    }
    // token reduction per query vs the whole-file baseline
    const base = by.wholefile.contextTokens || 0;
    for (const r of RETRIEVERS)
      by[r.name].tokenReduction = base > 0 ? 1 - by[r.name].contextTokens / base : null;

    results.push({
      id: q.id,
      category: q.category,
      split: q.split,
      source: q.source || "generated",
      author: q.author || "mechanical",
      stratum: q.stratum || "generated",
      query: text,
      variant,
      overlap,
      negative: !!q.negative,
      ground_truth: q.ground_truth,
      by,
    });

    if (i % 100 === 0 || i === runItems.length - 1)
      onProgress({ phase: "retrieve", msg: `scored ${i + 1}/${runItems.length} variants × ${RETRIEVERS.length} retrievers`, done: i + 1, total: runItems.length });
  }

  // Aggregate per retriever (raw P/R/latency/tokens first-class, buckets included).
  const summaryByRetriever = {};
  for (const r of RETRIEVERS) {
    summaryByRetriever[r.name] = aggregate(
      results.map((res) => ({
        score_detail: res.by[r.name].score_detail,
        raw: res.by[r.name].raw,
        contextTokens: res.by[r.name].contextTokens,
        latencyMs: res.by[r.name].latencyMs,
        overlap: res.negative ? null : res.overlap,
      })),
    );
  }
  const baseTokens = summaryByRetriever.wholefile.headline.mean_context_tokens || 0;
  for (const r of RETRIEVERS) {
    const h = summaryByRetriever[r.name].headline;
    h.token_reduction_pct = baseTokens > 0 ? +((1 - h.mean_context_tokens / baseTokens) * 100).toFixed(1) : null;
  }
  if (ltRunner) summaryByRetriever.lesstokenify.headline.index_build_ms = ltIndexBuildMs;

  // Fairness: per-stratum breakdown + residual home-field bias (DECISIONS.md §D).
  const fairness = computeFairness(results, RETRIEVERS.map((r) => r.name));

  // The "none" overlap bucket (query shares zero words with the answer) is the
  // only check that catches a retriever winning on filename-matching rather than
  // understanding the code. It can only be populated by hand-curated/authored
  // questions (answer-key/<repo>/curated.questions.json), never by the mechanical
  // generator, because writing a true none-overlap paraphrase requires knowing
  // what the code DOES, which a template can't derive. Surface it loudly rather
  // than let an empty bucket look like a clean run.
  const noneCoverage = RETRIEVERS.some((r) => (summaryByRetriever[r.name].by_overlap.none?.n || 0) > 0);
  const warnings = [];
  if (!noneCoverage) {
    const msg = `No "none"-overlap questions ran (bank has ${bank.counts.control} curated question(s) for this repo). Every retriever's paraphrase-robustness numbers below only cover exact/partial overlap, so they cannot show whether a result came from understanding the code vs. matching its name. Add answer-key/${dump.repo.name}/curated.questions.json with none-overlap paraphrases to close this gap.`;
    warnings.push(msg);
    onProgress({ phase: "done", msg: `Warning: ${msg}` });
  }

  const report = {
    repo: { root: repoRoot, name: dump.repo.name, sandbox, files: dump.stats.files, loc: dump.repo.loc, symbols: dump.stats.symbols },
    retrievers: RETRIEVERS.map((r) => r.name),
    retrieverLabels: RETRIEVER_LABELS,
    baselineRetriever: "wholefile",
    tokenizer: tokenizerName,
    curatedCount: bank.counts.control,
    questionCounts: bank.counts,
    fairness,
    warnings,
    generatedAt: new Date().toISOString(),
    summaryByRetriever,
    dumpStats: dump.stats,
    results,
  };
  onProgress({ phase: "done", msg: "Evaluation complete.", summary: summaryByRetriever });
  return report;
}
