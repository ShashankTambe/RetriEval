/**
 * Sampled agent-retriever run (DECISIONS.md §E).
 *
 * Runs a bring-your-own agent retriever over a SAMPLE of the same questions the
 * deterministic core used, scoring file-level Precision/Recall against the same
 * independent answer key. Deliberately sampled + non-deterministic, so it lives
 * beside the deterministic table, never inside it. Returns one compact "card" of
 * quality + cost-of-searching metrics.
 *
 * The caller passes already-sampled question stubs (id, query, negative,
 * ground_truth) — sampling happens renderer-side so the payload stays small and
 * the user sees exactly how many queries will be run (and billed).
 */
import { agentRetrieve } from "./retrievers/agent.mjs";
import { rawPR } from "./scorer.mjs";

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const quantile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/**
 * opts: { provider, model, effort, onProgress }
 * questions: [{ id, query, negative, ground_truth }]
 */
export async function runAgentRetriever(sandbox, questions, opts = {}) {
  const { provider, model, effort, onProgress = () => {} } = opts;
  if (!questions?.length) throw new Error("No questions to run the agent retriever on.");

  const rows = [];
  let usedAgent = provider;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const emit = (step) => onProgress({ phase: "agent", done: i, total: questions.length, query: q.query, step, msg: `Query ${i + 1}/${questions.length}: ${step}` });
    emit("starting…");
    try {
      const ret = await agentRetrieve(sandbox, q.query, { agent: provider, model, effort, onStep: emit });
      usedAgent = ret.agent;
      emit("done");
      const pr = rawPR(q, ret.files); // file-level P/R vs the independent answer key
      rows.push({
        id: q.id, query: q.query, category: q.category || "?", overlap: q.overlap || null,
        recall: pr.recall, precision: pr.precision,
        latencyMs: ret.latencyMs, agentTokens: ret.agentTokens, costUsd: ret.costUsd,
        returned: ret.files.map((f) => f.file),
        answer_text: (q.ground_truth && q.ground_truth.answer_text) || "",
      });
    } catch (e) {
      // First-query failure is almost always auth/CLI (not logged in) — abort with
      // the clear message rather than silently scoring an empty run.
      if (i === 0) throw e;
      rows.push(null); // a mid-run timeout drops one question, run continues
    }
    onProgress({ phase: "agent", msg: `Agent retriever: ${i + 1}/${questions.length} queries`, done: i + 1, total: questions.length });
  }

  const ok = rows.filter(Boolean);
  const rec = ok.map((x) => x.recall).filter((v) => typeof v === "number");
  const prec = ok.map((x) => x.precision).filter((v) => typeof v === "number");
  const lat = ok.map((x) => x.latencyMs);
  const toks = ok.map((x) => x.agentTokens).filter((v) => typeof v === "number");
  const costs = ok.map((x) => x.costUsd).filter((v) => typeof v === "number");

  return {
    provider: usedAgent,
    model: model || "(provider default)",
    effort: effort || "(provider default)",
    requested_n: questions.length,
    sample_n: ok.length,
    mean_recall_pct: rec.length ? +(mean(rec) * 100).toFixed(1) : null,
    mean_precision_pct: prec.length ? +(mean(prec) * 100).toFixed(1) : null,
    median_latency_ms: lat.length ? +quantile(lat, 0.5).toFixed(0) : null,
    mean_agent_tokens: toks.length ? Math.round(mean(toks)) : null,
    total_cost_usd: costs.length ? +costs.reduce((s, x) => s + x, 0).toFixed(4) : null,
    total_wall_s: lat.length ? +(lat.reduce((s, x) => s + x, 0) / 1000).toFixed(1) : null,
    // Same depth the deterministic retrievers expose: per-bucket, per-category, per-question.
    by_overlap: groupStat(ok.filter((r) => r.overlap), (r) => r.overlap),
    by_category: groupStat(ok, (r) => r.category),
    results: ok, // per-question rows (returned files + correct answer) for the misses view
    ranAt: new Date().toISOString(),
  };
}

/** Mean recall/precision (as %) grouped by a key — mirrors the deterministic breakdowns. */
function groupStat(rows, keyFn) {
  const g = {};
  for (const r of rows) {
    const k = keyFn(r);
    (g[k] ||= { rec: [], prec: [] });
    if (typeof r.recall === "number") g[k].rec.push(r.recall);
    if (typeof r.precision === "number") g[k].prec.push(r.precision);
  }
  const out = {};
  for (const [k, v] of Object.entries(g))
    out[k] = {
      recall_pct: v.rec.length ? +(mean(v.rec) * 100).toFixed(1) : null,
      precision_pct: v.prec.length ? +(mean(v.prec) * 100).toFixed(1) : null,
      n: v.rec.length,
    };
  return out;
}
