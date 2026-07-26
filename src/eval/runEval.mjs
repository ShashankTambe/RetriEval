#!/usr/bin/env node
/** CLI entry for the evaluation engine: node src/eval/runEval.mjs <repoPath> [limit] */
import { runEvaluation } from "./pipeline.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.argv[2];
const limit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
if (!repo) {
  console.error("usage: node src/eval/runEval.mjs <repoPath> [limit]");
  process.exit(1);
}

const RETRIEVAL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const report = await runEvaluation(repo, {
  limit,
  onProgress: (p) => console.log(`[${p.phase}] ${p.msg || ""}`),
});

const outDir = join(RETRIEVAL_ROOT, "eval-results");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${report.repo.name || "repo"}-latest.json`);
writeFileSync(out, JSON.stringify(report, null, 2));

console.log("\n================ RETRIEVER COMPARISON (raw metrics) ================");
console.log(`${"retriever".padEnd(16)} ${"recall".padStart(7)} ${"precis".padStart(7)} ${"med ms".padStart(7)} ${"p95 ms".padStart(7)} ${"tok/q".padStart(7)} ${"vs whole".padStart(9)} ${"composite".padStart(10)}`);
for (const name of report.retrievers) {
  const h = report.summaryByRetriever[name].headline;
  console.log(
    `${(report.retrieverLabels[name] || name).padEnd(16)} ` +
      `${(h.mean_recall_pct + "%").padStart(7)} ${(h.mean_precision_pct + "%").padStart(7)} ` +
      `${String(h.median_latency_ms).padStart(7)} ${String(h.p95_latency_ms).padStart(7)} ` +
      `${String(h.mean_context_tokens).padStart(7)} ${((h.token_reduction_pct ?? 0) + "%").padStart(9)} ` +
      `${(h.mean_score_pct + "%").padStart(10)}`,
  );
}
const ib = report.summaryByRetriever.lesstokenify?.headline.index_build_ms;
if (ib != null) console.log(`\nLessTokenify one-time index build: ${ib} ms`);
console.log(`tokenizer: ${report.tokenizer}`);

console.log("\nRecall by lexical-overlap bucket (the anti-overfit panel):");
const overlaps = ["exact", "partial", "none"];
console.log(`${"".padEnd(16)} ${overlaps.map((o) => o.padStart(10)).join("")}`);
for (const name of report.retrievers) {
  const bo = report.summaryByRetriever[name].by_overlap || {};
  console.log(
    `${(report.retrieverLabels[name] || name).padEnd(16)} ` +
      overlaps.map((o) => (bo[o] ? bo[o].mean_recall_pct + "% (" + bo[o].n + ")" : "–").padStart(10)).join(""),
  );
}

console.log("\nPer-category composite (mean_score %):");
const cats = [...new Set(report.retrievers.flatMap((n) => Object.keys(report.summaryByRetriever[n].by_category)))];
console.log(`${"".padEnd(16)} ${report.retrievers.map((n) => (report.retrieverLabels[n] || n).slice(0, 10).padStart(11)).join("")}`);
for (const c of cats)
  console.log(`${c.padEnd(16)} ${report.retrievers.map((n) => { const v = report.summaryByRetriever[n].by_category[c]; return ((v ? (v.mean_score * 100).toFixed(0) : "-") + "%").padStart(11); }).join("")}`);
if (report.questionCounts) {
  const q = report.questionCounts;
  console.log(`\nQuestion bank strata: ${q.control} control (human) · ${q.generated} generated (mechanical) · ${q.llm} llm-authored`);
}

if (report.fairness) {
  console.log("\nRecall by question-author STRATUM (reported separately, control is the human ruler):");
  const strata = ["control", "generated", "llm"];
  const present = strata.filter((s) => report.fairness.by_stratum[s]);
  console.log(`${"".padEnd(16)} ${present.map((s) => s.padStart(12)).join("")}`);
  for (const name of report.retrievers) {
    console.log(
      `${(report.retrieverLabels[name] || name).padEnd(16)} ` +
        present.map((s) => { const v = report.fairness.by_stratum[s][name]; return (v && v.mean_recall_pct != null ? `${v.mean_recall_pct}% (${v.n})` : "–").padStart(12); }).join(""),
    );
  }
  if (report.fairness.home_field?.length) {
    console.log("\nHome-field delta (author over-performs on its OWN questions vs human control):");
    for (const h of report.fairness.home_field)
      console.log(`  ${h.author} → ${h.retriever}: own ${h.own_recall_pct}% vs control ${h.control_recall_pct}% = ${h.delta_pct >= 0 ? "+" : ""}${h.delta_pct}pp`);
  } else if (report.fairness.note) {
    console.log(`\nHome-field: ${report.fairness.note}`);
  }
}

console.log(`\nwritten -> ${out}`);
