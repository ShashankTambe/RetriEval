/**
 * Scoring — the match function + per-category formulas from the benchmark
 * design (../LessTokenify/HANDOFF.md §"Per-category scoring"). Grades a
 * retriever's returned files (rank order) against a question's ground truth.
 *
 * Match function (underlies Location):
 *   exact symbol in returned slice        -> 1.0
 *   correct file, symbol not in slice     -> 0.5
 *   else                                  -> 0
 */

// score one required target against the ranked results
function matchTarget(returned, target) {
  const hit = returned.find((r) => r.file === target.file);
  if (!hit) return 0;
  if (target.symbol && (hit.snippet || "").includes(target.symbol)) return 1.0;
  return 0.5;
}

/** The relevant-file set for a question, uniform across categories (VISION.md). */
export function relevantFiles(q) {
  const g = q.ground_truth || {};
  const files = new Set();
  for (const r of g.required || []) files.add(r.file);
  for (const d of g.dependents || []) files.add(d.file);
  for (const p of g.path || []) if (p.file) files.add(p.file);
  for (const c of g.components || []) for (const f of c.anyOf_files || []) files.add(f);
  return files;
}

/**
 * Raw file-level Precision/Recall per VISION.md — of everything retrieved, how
 * much was relevant; of everything relevant, how much was retrieved. No
 * weighting, no snippet-level credit. Null for negatives / empty ground truth.
 */
export function rawPR(q, returned) {
  if (q.negative) return { precision: null, recall: null };
  const rel = relevantFiles(q);
  if (!rel.size) return { precision: null, recall: null };
  const retFiles = [...new Set(returned.map((r) => r.file))];
  const hits = retFiles.filter((f) => rel.has(f)).length;
  return {
    precision: retFiles.length ? hits / retFiles.length : 0,
    recall: [...rel].filter((f) => retFiles.includes(f)).length / rel.size,
  };
}

export function scoreQuestion(q, ret) {
  const returned = ret.files; // rank order, top-k
  const g = q.ground_truth || {};
  const k = returned.length;

  if (q.negative) {
    // A retriever that always returns k>0 files cannot "say not found". LT always
    // returns 5, so this is a known limitation: score 1.0 only if it returned
    // nothing. Flagged as heuristic until retrievers can abstain.
    return { category: "Negative", score: returned.length === 0 ? 1 : 0, heuristic: true };
  }

  if (q.category === "Location") {
    const reqs = g.required || [];
    if (!reqs.length) return { category: q.category, score: null };
    const recall = reqs.reduce((a, r) => a + matchTarget(returned, r), 0) / reqs.length;
    let mrr = 0;
    for (let idx = 0; idx < k; idx++) {
      if (reqs.some((r) => r.file === returned[idx].file)) {
        mrr = 1 / (idx + 1);
        break;
      }
    }
    const good = new Set([...(g.required || []), ...(g.supporting || [])].map((x) => x.file));
    const precision = k ? returned.filter((r) => good.has(r.file)).length / k : 0;
    return {
      category: q.category,
      score: 0.7 * recall + 0.2 * mrr + 0.1 * precision,
      recall,
      mrr,
      precision,
    };
  }

  if (q.category === "Relationship") {
    const deps = [...new Set((g.dependents || []).map((d) => d.file))];
    if (!deps.length) return { category: q.category, score: null };
    const found = deps.filter((f) => returned.some((r) => r.file === f)).length;
    const recall = found / deps.length;
    const ceiling = Math.min(1, recall / Math.min(1, k / deps.length));
    const precision = k ? returned.filter((r) => deps.includes(r.file)).length / k : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return {
      category: q.category,
      score: 0.6 * ceiling + 0.4 * f1,
      recall,
      ceilingRecall: ceiling,
      f1,
    };
  }

  if (q.category === "Flow") {
    const nodes = [...new Set((g.path || []).map((p) => p.file))];
    if (!nodes.length) return { category: q.category, score: null };
    const coverage = nodes.filter((f) => returned.some((r) => r.file === f)).length / nodes.length;
    // OrderBonus = 0 until LT emits ordered paths
    return { category: q.category, score: 0.8 * coverage, nodeCoverage: coverage };
  }

  if (q.category === "Architecture") {
    const comps = g.components || [];
    if (!comps.length) return { category: q.category, score: null };
    const covered = comps.filter((c) =>
      (c.anyOf_files || []).some((f) => returned.some((r) => r.file === f)),
    ).length;
    return { category: q.category, score: covered / comps.length, componentCoverage: covered / comps.length };
  }

  return { category: q.category, score: null };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const quantile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/**
 * Aggregate one retriever's per-query results. Each item:
 *   { score_detail: {category, score}, raw: {precision, recall},
 *     contextTokens, latencyMs, overlap }
 * Raw Precision/Recall/Latency/Tokens are FIRST-CLASS (VISION.md); the weighted
 * composite is kept as a secondary summary.
 */
export function aggregate(results) {
  const cats = {};
  const score = [];
  const prec = [];
  const rec = [];
  const tok = [];
  const lat = [];
  const buckets = {}; // lexical_overlap -> { recall[], precision[], n }

  for (const r of results) {
    const c = r.score_detail.category;
    if (r.score_detail.score != null) {
      (cats[c] ||= { scoreSum: 0, n: 0 }).scoreSum += r.score_detail.score;
      cats[c].n += 1;
      score.push(r.score_detail.score);
    }
    if (r.raw && typeof r.raw.precision === "number") prec.push(r.raw.precision);
    if (r.raw && typeof r.raw.recall === "number") rec.push(r.raw.recall);
    if (typeof r.contextTokens === "number") tok.push(r.contextTokens);
    if (typeof r.latencyMs === "number") lat.push(r.latencyMs);
    if (r.overlap && r.raw && typeof r.raw.recall === "number") {
      const b = (buckets[r.overlap] ||= { recall: [], precision: [], n: 0 });
      b.recall.push(r.raw.recall);
      if (typeof r.raw.precision === "number") b.precision.push(r.raw.precision);
      b.n += 1;
    }
  }

  const by_category = {};
  for (const [c, v] of Object.entries(cats)) by_category[c] = { mean_score: v.scoreSum / v.n, n: v.n };

  const by_overlap = {};
  for (const [o, b] of Object.entries(buckets))
    by_overlap[o] = {
      mean_recall_pct: +(mean(b.recall) * 100).toFixed(1),
      mean_precision_pct: b.precision.length ? +(mean(b.precision) * 100).toFixed(1) : null,
      n: b.n,
    };

  const m = (a) => (a.length ? +(mean(a) * 100).toFixed(1) : null);
  return {
    headline: {
      // raw, first-class
      mean_recall_pct: m(rec),
      mean_precision_pct: m(prec),
      median_latency_ms: lat.length ? +quantile(lat, 0.5).toFixed(1) : null,
      p95_latency_ms: lat.length ? +quantile(lat, 0.95).toFixed(1) : null,
      mean_context_tokens: tok.length ? Math.round(mean(tok)) : null,
      // secondary composite
      mean_score_pct: m(score),
    },
    by_category,
    by_overlap,
    counts: { scored: score.length, total: results.length },
  };
}
