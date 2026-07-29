/**
 * CLI wrapper around the mechanical answer-key analyzer.
 *
 * This used to be a second, standalone implementation (tools/staticAnalysis.ts)
 * that duplicated src/eval/staticAnalysisLib.mjs. The two drifted apart, which
 * meant `npm run analyze` and a live evaluation could produce DIFFERENT answer
 * keys for the same repo. In a tool whose whole claim is reproducible, neutral
 * measurement, that is not a cosmetic problem, so the duplicate is gone and
 * both paths now run exactly the same code.
 *
 * Usage: node tools/staticAnalysis.mjs <repoRoot> [commitSha] [outFile]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { analyze } from "../src/eval/staticAnalysisLib.mjs";

const repoRootArg = process.argv[2];
const commitSha = process.argv[3] ?? "unknown";
const outFile = process.argv[4];

if (!repoRootArg) {
  console.error("usage: node tools/staticAnalysis.mjs <repoRoot> [commitSha] [outFile]");
  process.exit(1);
}

const dump = analyze(resolve(repoRootArg), commitSha);
const out = outFile ?? join("answer-key", dump.repo.name ?? "repo", "mechanical.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(dump, null, 2));

console.log(`Analyzed ${dump.stats.files} files from ${repoRootArg}`);
console.table(dump.stats);
console.log(`\nWrote mechanical answer key -> ${out}`);
