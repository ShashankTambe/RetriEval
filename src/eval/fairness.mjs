/**
 * Fairness / residual-bias metric (DECISIONS.md §D.4).
 *
 * Two jobs:
 *  1. Report raw recall/precision per STRATUM × retriever, never averaged across
 *     strata — the human control set is the neutral ruler and must stay visible.
 *  2. Home-field delta — when a question author is the same family as a
 *     contestant (only possible once an agent retriever is added, build #2), does
 *     that contestant over-perform on its OWN authored questions vs the human
 *     control? A positive delta is home-field advantage. With no same-family
 *     contestant (this version's lexical retrievers), it's honestly N/A.
 *
 * Also surfaces "authored easiness": how much easier the auto strata are than the
 * human control — a high gap means the generated/llm questions aren't testing the
 * hard, human-type retrieval the control set does.
 */
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const pct = (a) => (a.length ? +(mean(a) * 100).toFixed(1) : null);

/** claude-opus-4-8 / "claude" both belong to family "claude"; codex → "codex". */
function family(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex") || n.includes("gpt") || n.includes("openai")) return "codex";
  return n;
}

export function computeFairness(results, retrievers) {
  // stratum -> retriever -> { rec:[], prec:[] }
  const strata = {};
  const authors = new Set();
  for (const r of results) {
    if (r.negative) continue;
    const st = r.stratum || "generated";
    if (st === "llm" && r.author) authors.add(r.author);
    for (const ret of retrievers) {
      const raw = r.by?.[ret]?.raw;
      if (!raw) continue;
      const b = ((strata[st] ||= {})[ret] ||= { rec: [], prec: [] });
      if (typeof raw.recall === "number") b.rec.push(raw.recall);
      if (typeof raw.precision === "number") b.prec.push(raw.precision);
    }
  }

  const by_stratum = {};
  for (const [st, rets] of Object.entries(strata)) {
    by_stratum[st] = {};
    for (const [ret, b] of Object.entries(rets))
      by_stratum[st][ret] = { mean_recall_pct: pct(b.rec), mean_precision_pct: pct(b.prec), n: b.rec.length };
  }

  // home-field delta: author family vs same-family contestant
  const home_field = [];
  for (const author of authors) {
    const fam = family(author);
    for (const ret of retrievers) {
      if (family(ret) !== fam) continue;
      const own = by_stratum.llm?.[ret]?.mean_recall_pct;
      const ctrl = by_stratum.control?.[ret]?.mean_recall_pct;
      if (own != null && ctrl != null)
        home_field.push({ author, retriever: ret, own_recall_pct: own, control_recall_pct: ctrl, delta_pct: +(own - ctrl).toFixed(1) });
    }
  }

  // authored-easiness gap: mean recall across retrievers, auto strata vs control
  const stratumMeanRecall = (st) => {
    const vals = Object.values(by_stratum[st] || {}).map((x) => x.mean_recall_pct).filter((v) => v != null);
    return vals.length ? +mean(vals).toFixed(1) : null;
  };
  const ctrl = stratumMeanRecall("control");
  const easiness = {};
  for (const st of ["generated", "llm"]) {
    const v = stratumMeanRecall(st);
    easiness[st] = v != null && ctrl != null ? { stratum_recall_pct: v, control_recall_pct: ctrl, gap_pct: +(v - ctrl).toFixed(1) } : null;
  }

  return {
    by_stratum,
    home_field,
    easiness,
    note: home_field.length
      ? undefined
      : "No same-family contestant present — the author-vs-own-questions home-field delta is N/A this run. Strata are still reported separately; the human control set is the neutral ruler.",
  };
}
