/**
 * Tests for the scoring math — every number that shows up in a report comes out
 * of these functions, so this is the correctness core of the whole harness.
 *
 * Discipline: each expected value is derived BY HAND from the documented formula
 * (shown in the comment), never by pasting whatever the code happened to print.
 * A test that just echoes the implementation proves nothing.
 *
 * Run: `npm test`  (Node's built-in runner — no dependencies).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rawPR, scoreQuestion, aggregate, relevantFiles } from "../src/eval/scorer.mjs";

const close = (a, b, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} expected ${b}, got ${a}`);
const ret = (...files) => ({ files: files.map((f) => (typeof f === "string" ? { file: f } : f)) });

// ── relevantFiles: the union of every ground-truth shape ─────────────────────
test("relevantFiles unions required + dependents + path + components", () => {
  const q = {
    ground_truth: {
      required: [{ file: "a.ts" }],
      dependents: [{ file: "b.ts" }],
      path: [{ file: "c.ts" }],
      components: [{ anyOf_files: ["d.ts", "e.ts"] }],
    },
  };
  assert.deepEqual([...relevantFiles(q)].sort(), ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
});

// ── rawPR: file-level precision/recall (the headline numbers) ─────────────────
test("rawPR — 1 of 2 returned relevant, 1 of 2 relevant found → P=0.5 R=0.5", () => {
  // rel = {a,b}; returned = [a,c]; hits = {a}
  // precision = 1/2, recall = 1/2
  const q = { ground_truth: { required: [{ file: "a.ts" }, { file: "b.ts" }] } };
  const pr = rawPR(q, [{ file: "a.ts" }, { file: "c.ts" }]);
  close(pr.precision, 0.5, "precision");
  close(pr.recall, 0.5, "recall");
});

test("rawPR — perfect retrieval → P=1 R=1", () => {
  const q = { ground_truth: { required: [{ file: "a.ts" }] } };
  const pr = rawPR(q, [{ file: "a.ts" }]);
  close(pr.precision, 1, "precision");
  close(pr.recall, 1, "recall");
});

test("rawPR — negative question is unscored (null/null)", () => {
  const q = { negative: true, ground_truth: { required: [] } };
  const pr = rawPR(q, [{ file: "x.ts" }]);
  assert.equal(pr.precision, null);
  assert.equal(pr.recall, null);
});

test("rawPR — empty ground truth is unscored (null/null)", () => {
  const pr = rawPR({ ground_truth: {} }, [{ file: "x.ts" }]);
  assert.equal(pr.precision, null);
  assert.equal(pr.recall, null);
});

test("rawPR — duplicate returned files are de-duped, not double-counted", () => {
  // returned [a,a] → unique {a}; rel {a,b}; precision = 1/1, recall = 1/2
  const q = { ground_truth: { required: [{ file: "a.ts" }, { file: "b.ts" }] } };
  const pr = rawPR(q, [{ file: "a.ts" }, { file: "a.ts" }]);
  close(pr.precision, 1, "precision");
  close(pr.recall, 0.5, "recall");
});

// ── scoreQuestion: per-category composites ───────────────────────────────────
test("Location — exact symbol in snippet → 0.7·1 + 0.2·1 + 0.1·1 = 1.0", () => {
  const q = { category: "Location", ground_truth: { required: [{ symbol: "addLead", file: "a.ts" }] } };
  const s = scoreQuestion(q, ret({ file: "a.ts", snippet: "function addLead() {}" }));
  close(s.score, 1.0);
});

test("Location — right file, symbol NOT in snippet → 0.7·0.5 + 0.2·1 + 0.1·1 = 0.65", () => {
  // matchTarget = 0.5 (file hit, no symbol), mrr = 1 (file at rank 1), precision = 1
  const q = { category: "Location", ground_truth: { required: [{ symbol: "addLead", file: "a.ts" }] } };
  const s = scoreQuestion(q, ret({ file: "a.ts", snippet: "nothing relevant here" }));
  close(s.score, 0.65);
});

test("Location — wrong file entirely → 0", () => {
  const q = { category: "Location", ground_truth: { required: [{ symbol: "addLead", file: "a.ts" }] } };
  const s = scoreQuestion(q, ret({ file: "z.ts", snippet: "addLead" }));
  close(s.score, 0);
});

test("Negative — score 1 only if the retriever returned nothing", () => {
  const q = { category: "Location", negative: true, ground_truth: {} };
  close(scoreQuestion(q, ret()).score, 1);
  close(scoreQuestion(q, ret("x.ts")).score, 0);
});

test("Relationship — 1 of 2 dependents found → 0.6·ceiling + 0.4·f1 = 0.5", () => {
  // deps {a,b}; returned [a,c] (k=2); recall = 1/2
  // ceiling = min(1, 0.5 / min(1, 2/2)) = 0.5 ; precision = 1/2 ; f1 = 0.5
  // score = 0.6·0.5 + 0.4·0.5 = 0.5
  const q = { category: "Relationship", ground_truth: { dependents: [{ file: "a.ts" }, { file: "b.ts" }] } };
  close(scoreQuestion(q, ret("a.ts", "c.ts")).score, 0.5);
});

test("Flow — half the path covered → 0.8·0.5 = 0.4", () => {
  const q = { category: "Flow", ground_truth: { path: [{ file: "a.ts" }, { file: "b.ts" }] } };
  close(scoreQuestion(q, ret("a.ts")).score, 0.4);
});

test("Architecture — 1 of 2 components hit → 0.5", () => {
  const q = {
    category: "Architecture",
    ground_truth: { components: [{ anyOf_files: ["a.ts", "b.ts"] }, { anyOf_files: ["c.ts"] }] },
  };
  close(scoreQuestion(q, ret("a.ts")).score, 0.5);
});

// ── aggregate: the report-level rollup ───────────────────────────────────────
test("aggregate — headline means, per-category, per-overlap, counts", () => {
  const items = [
    { score_detail: { category: "Location", score: 1.0 }, raw: { precision: 1, recall: 1 }, contextTokens: 100, latencyMs: 10, overlap: "exact" },
    { score_detail: { category: "Location", score: 0.4 }, raw: { precision: 0.5, recall: 0.5 }, contextTokens: 200, latencyMs: 20, overlap: "partial" },
    { score_detail: { category: "Relationship", score: 0.7 }, raw: { precision: 0, recall: 0 }, contextTokens: 300, latencyMs: 30, overlap: "none" },
  ];
  const a = aggregate(items);
  // recall/precision means of [1, .5, 0] = 0.5 → 50.0%
  assert.equal(a.headline.mean_recall_pct, 50.0);
  assert.equal(a.headline.mean_precision_pct, 50.0);
  // score mean of [1, .4, .7] = 0.7 → 70.0%
  assert.equal(a.headline.mean_score_pct, 70.0);
  // latency nearest-rank: median = idx floor(.5·3)=1 → 20 ; p95 = idx floor(.95·3)=2 → 30
  assert.equal(a.headline.median_latency_ms, 20);
  assert.equal(a.headline.p95_latency_ms, 30);
  // tokens mean of [100,200,300] = 200
  assert.equal(a.headline.mean_context_tokens, 200);
  // per-category composite: Location = (1.0+0.4)/2 = 0.7
  close(a.by_category.Location.mean_score, 0.7, "Location mean_score");
  assert.equal(a.by_category.Location.n, 2);
  // per-overlap recall: exact 100%, partial 50%, none 0%
  assert.equal(a.by_overlap.exact.mean_recall_pct, 100);
  assert.equal(a.by_overlap.partial.mean_recall_pct, 50);
  assert.equal(a.by_overlap.none.mean_recall_pct, 0);
  assert.deepEqual(a.counts, { scored: 3, total: 3 });
});
