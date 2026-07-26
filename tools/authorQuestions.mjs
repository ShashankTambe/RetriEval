#!/usr/bin/env node
/**
 * Offline styleguided question authoring (DECISIONS.md §D), the build-time step
 * that FREEZES an LLM-authored question stratum to disk. Kept out of the live
 * eval so runs stay deterministic; you author once, review, and commit.
 *
 *   node tools/authorQuestions.mjs <repoPath> [maxFacts] [--agent claude|codex]
 *
 * Writes answer-key/<repoName>/authored.questions.json, which the deterministic
 * pipeline then loads as the `llm` stratum. Requires a logged-in claude/codex.
 *
 * Integrity (DECISIONS.md §C): the model only phrases questions; every answer is
 * attached from the ts-morph dump, never from the model.
 */
import { makeSandbox, hasSource } from "../src/eval/sandbox.mjs";
import { analyze } from "../src/eval/staticAnalysisLib.mjs";
import { authorQuestions } from "../src/eval/authoring.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const maxFacts = parseInt(args.find((a) => /^\d+$/.test(a)) || "15", 10);
const agentIdx = args.indexOf("--agent");
const agent = agentIdx !== -1 ? args[agentIdx + 1] : undefined;

if (!repo) {
  console.error("usage: node tools/authorQuestions.mjs <repoPath> [maxFacts] [--agent claude|codex]");
  process.exit(1);
}

const RETRIEVAL_ROOT = fileURLToPath(new URL("../", import.meta.url));

const sandbox = makeSandbox(repo);
if (!hasSource(sandbox)) { console.error("No src/ found, is this a TS/JS project?"); process.exit(1); }
const dump = analyze(sandbox, "authoring");
console.log(`Answer key: ${dump.stats.symbols} symbols, ${dump.stats.callEdges} call edges.`);

// dialect exemplars come from the human control set, if one exists
const keyDir = join(RETRIEVAL_ROOT, "answer-key", dump.repo.name);
let exemplars = [];
const curatedPath = join(keyDir, "curated.questions.json");
if (existsSync(curatedPath)) {
  try { exemplars = JSON.parse(readFileSync(curatedPath, "utf8")).questions || []; } catch {}
}
console.log(`${exemplars.length} human exemplars loaded for the dialect prompt.`);

const questions = await authorQuestions(dump, sandbox, {
  agent, maxFacts, exemplars,
  onProgress: (p) => console.log(`  [${p.phase}] ${p.msg || ""}`),
});

if (!questions.length) {
  console.error("No questions authored (agent returned nothing, or not logged in). Nothing written.");
  process.exit(2);
}

mkdirSync(keyDir, { recursive: true });
const outPath = join(keyDir, "authored.questions.json");
const doc = {
  _status: "CANDIDATE, LLM-authored, answers anchored to ts-morph. Review before trusting as a frozen stratum.",
  repo: dump.repo.name,
  author: questions[0].author,
  generatedAt: new Date().toISOString(),
  count: questions.length,
  questions,
};
writeFileSync(outPath, JSON.stringify(doc, null, 2));
console.log(`\n✓ ${questions.length} questions authored by ${doc.author} → ${outPath}`);
console.log(`Review it, then a normal run will pick it up as the "llm" stratum.`);
