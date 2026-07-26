#!/usr/bin/env node
/**
 * Batch runner (DECISIONS.md build queue #3) — run the deterministic evaluation
 * across many repos and aggregate cross-repo, so a headline number isn't n=1.
 *
 *   node tools/batchEval.mjs <dir-of-repos> [limit]
 *
 * <dir-of-repos> is a folder whose immediate subdirectories are each a TS/JS
 * repo. Each is evaluated independently; per-repo reports are written and a
 * cross-repo mean is printed + saved. Agent retrievers are NOT run here (they're
 * interactive, sampled, and spend tokens) — this is the reproducible core.
 */
import { runEvaluation } from "../src/eval/pipeline.mjs";
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2];
const limit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
if (!root) {
  console.error("usage: node tools/batchEval.mjs <dir-of-repos> [limit]");
  process.exit(1);
}

const RETRIEVAL_ROOT = fileURLToPath(new URL("../", import.meta.url));
const outDir = join(RETRIEVAL_ROOT, "eval-results", "batch");
mkdirSync(outDir, { recursive: true });

const repos = readdirSync(root)
  .map((n) => join(root, n))
  .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });

if (!repos.length) { console.error(`No subdirectories found in ${root}`); process.exit(1); }

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const perRepo = [];

for (const repo of repos) {
  process.stdout.write(`\n▶ ${repo}\n`);
  try {
    const rep = await runEvaluation(repo, { limit, onProgress: (p) => process.stdout.write(`  [${p.phase}] ${p.msg || ""}\r`) });
    process.stdout.write("\n");
    const row = { repo: rep.repo.name, files: rep.repo.files, by: {} };
    for (const n of rep.retrievers) {
      const h = rep.summaryByRetriever[n].headline;
      row.by[n] = { recall: h.mean_recall_pct, precision: h.mean_precision_pct, tokens: h.mean_context_tokens, latency: h.median_latency_ms };
    }
    row.fairness = rep.fairness?.easiness?.generated || null; // control-vs-generated gap per repo
    perRepo.push(row);
    writeFileSync(join(outDir, `${rep.repo.name}.json`), JSON.stringify(rep, null, 2));
  } catch (e) {
    process.stdout.write(`  ✗ skipped (${e.message})\n`);
    perRepo.push({ repo: repo.split(/[\\/]/).pop(), error: e.message });
  }
}

const ok = perRepo.filter((r) => !r.error);
const retrievers = ok.length ? Object.keys(ok[0].by) : [];
const crossRepo = {};
for (const n of retrievers)
  crossRepo[n] = {
    mean_recall_pct: +(mean(ok.map((r) => r.by[n].recall).filter((v) => v != null)) || 0).toFixed(1),
    mean_precision_pct: +(mean(ok.map((r) => r.by[n].precision).filter((v) => v != null)) || 0).toFixed(1),
    mean_context_tokens: Math.round(mean(ok.map((r) => r.by[n].tokens).filter((v) => v != null)) || 0),
  };
const meanEasinessGap = +(mean(ok.map((r) => r.fairness?.gap_pct).filter((v) => v != null)) || 0).toFixed(1);

const summary = { repos: perRepo.length, evaluated: ok.length, crossRepo, meanEasinessGap, perRepo, generatedAt: new Date().toISOString() };
writeFileSync(join(outDir, "_summary.json"), JSON.stringify(summary, null, 2));

console.log(`\n================ CROSS-REPO (${ok.length}/${perRepo.length} repos) ================`);
console.log(`${"retriever".padEnd(16)} ${"recall".padStart(8)} ${"precis".padStart(8)} ${"tok/q".padStart(9)}`);
for (const n of retrievers)
  console.log(`${n.padEnd(16)} ${(crossRepo[n].mean_recall_pct + "%").padStart(8)} ${(crossRepo[n].mean_precision_pct + "%").padStart(8)} ${String(crossRepo[n].mean_context_tokens).padStart(9)}`);
console.log(`\nMean human-vs-generated easiness gap across repos: ${meanEasinessGap}pp`);
console.log(`written -> ${join(outDir, "_summary.json")}`);
