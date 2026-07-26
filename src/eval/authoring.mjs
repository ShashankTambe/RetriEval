/**
 * Styleguided LLM question authoring — the "question setter" from DECISIONS.md §D.
 *
 * The integrity rule (DECISIONS.md §C): the LLM may write the *question*, it must
 * NEVER own the *answer*. So we do NOT ask the model "what's the answer" — we hand
 * it a MECHANICAL FACT already extracted by ts-morph (symbol + file + neighbours),
 * and ask only for natural-language phrasings a human would actually type. The
 * ground truth is attached by US from that fact, so every authored question is
 * answer-anchored by construction, independent of any contestant.
 *
 * We inject a dialect prompt + real examples from the human control set so the
 * authored questions read like the gold seed (reduces, not erases, home-field
 * bias — the residual is then measured in fairness.mjs).
 *
 * Lights up only when `claude`/`codex` is logged in; otherwise returns [] and the
 * run proceeds on the deterministic control + generated strata alone.
 */
import { runAgent, extractJson } from "./semantic.mjs";

const pad = (p, n) => p + String(n).padStart(4, "0");
const base = (f) => f.split("/").pop();
const splitFor = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 4 === 0 ? "blind" : "dev";
};

/** camelCase/snake_case → spaced words, for the honesty check on "none" overlap. */
const spaceOut = (name) =>
  name.replace(/[_.]/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Pick a diverse, meaningful set of mechanical facts to turn into human-type
 * questions. Central symbols (high used-by in-degree) make the best semantic
 * questions, so we rank by that. Interleave Location / Relationship / Flow.
 */
function sampleFacts(dump, maxFacts) {
  const indeg = {};
  for (const [key, deps] of Object.entries(dump.usedBy || {})) indeg[key] = deps.length;

  const calleesByCaller = new Map();
  for (const e of dump.callEdges) {
    const k = `${e.callerFile}::${e.caller}`;
    (calleesByCaller.get(k) || calleesByCaller.set(k, []).get(k)).push({ symbol: e.callee, file: e.calleeFile });
  }

  const callable = new Set(["function", "arrowFunction", "method", "class"]);
  const loc = dump.symbols
    .filter((s) => s.exported && callable.has(s.kind) && !s.container)
    .map((s) => ({ s, deg: indeg[`${s.file}::${s.name}`] || 0 }))
    .sort((a, b) => b.deg - a.deg)
    .map(({ s }) => ({
      kind: "location",
      symbol: s.name,
      file: s.file,
      lines: `${s.lineStart}-${s.lineEnd}`,
      symKind: s.kind,
      calls: (calleesByCaller.get(`${s.file}::${s.name}`) || []).slice(0, 5).map((c) => c.symbol),
    }));

  const rel = Object.entries(dump.usedBy || {})
    .map(([key, deps]) => ({ key, deps }))
    .filter((x) => x.deps.length >= 2)
    .sort((a, b) => b.deps.length - a.deps.length)
    .map(({ key, deps }) => {
      const [file, symbol] = key.split("::");
      return { kind: "relationship", symbol, file, dependents: deps };
    });

  const flow = [...calleesByCaller.entries()]
    .filter(([k, cs]) => cs.length >= 2 && !k.endsWith("::<module>"))
    .map(([k, cs]) => {
      const [callerFile, caller] = k.split("::");
      const seen = new Set();
      const path = [{ symbol: caller, file: callerFile }];
      for (const c of cs) {
        if (seen.has(c.symbol)) continue;
        seen.add(c.symbol);
        path.push(c);
      }
      return { kind: "flow", caller, callerFile, path };
    })
    .sort((a, b) => b.path.length - a.path.length);

  // interleave so the sample isn't all-Location
  const out = [];
  const queues = [loc, rel, flow];
  let qi = 0;
  while (out.length < maxFacts && queues.some((q) => q.length)) {
    const q = queues[qi % queues.length];
    if (q.length) out.push({ ...q.shift(), fid: `F${out.length}` });
    qi++;
  }
  return out;
}

/** ground truth built from the fact — never from the model. */
function groundTruthFor(f) {
  if (f.kind === "location")
    return {
      category: "Location",
      ground_truth: {
        required: [{ symbol: f.symbol, file: f.file, lines: f.lines }],
        answer_text: `${f.symbol} (${f.symKind}) at ${f.file}:${f.lines}.`,
      },
    };
  if (f.kind === "relationship")
    return {
      category: "Relationship",
      ground_truth: {
        dependents: f.dependents.map((file) => ({ file, relation: "reference" })),
        answer_text: `${f.symbol} is referenced by: ${f.dependents.join(", ")}.`,
      },
    };
  return {
    category: "Flow",
    ground_truth: {
      path: f.path.map((p) => ({ symbol: p.symbol, file: p.file })),
      answer_text: `${f.caller} calls: ${f.path.slice(1).map((p) => p.symbol).join(", ")}.`,
    },
  };
}

/** short human-readable fact line for the prompt (no answer leakage beyond the fact itself). */
function factLine(f) {
  if (f.kind === "location") {
    const calls = f.calls.length ? ` It calls: ${f.calls.join(", ")}.` : "";
    return `[${f.fid}] LOCATION — the ${f.symKind} "${f.symbol}" in ${base(f.file)} is the place that does this job.${calls}`;
  }
  if (f.kind === "relationship")
    return `[${f.fid}] RELATIONSHIP — "${f.symbol}" (in ${base(f.file)}) is used by ${f.dependents.length} other files.`;
  return `[${f.fid}] FLOW — "${f.caller}" (in ${base(f.callerFile)}) drives a chain calling: ${f.path.slice(1).map((p) => p.symbol).join(" → ")}.`;
}

/** dialect examples: pull a few "none"-overlap phrasings from the human control set. */
function dialectExamples(exemplars, n = 5) {
  const ex = [];
  for (const q of exemplars || []) {
    const none = (q.query_paraphrases || []).find((p) => p.lexical_overlap === "none");
    if (none) ex.push(none.text);
    if (ex.length >= n) break;
  }
  return ex;
}

function buildPrompt(facts, exemplars) {
  const examples = dialectExamples(exemplars);
  const exBlock = examples.length
    ? `\nWrite in this DIALECT — the way a busy developer actually phrases things, plain and outcome-focused, NOT using the code identifier. Examples of the target style:\n${examples.map((e) => `  - "${e}"`).join("\n")}\n`
    : "";
  return `You are helping build a code-retrieval benchmark. For each FACT below, write natural-language questions a developer would ask whose answer is exactly that fact. You are ONLY writing the questions — do not state the answer, do not add facts.
${exBlock}
For each fact produce:
  - "canonical": one clear question (may name the concept).
  - two "paraphrases": one with lexical_overlap "partial" (reworded, avoids the exact identifier) and one with lexical_overlap "none" (a human, business-level phrasing that shares NO words with the code identifier).

FACTS:
${facts.map(factLine).join("\n")}

Output ONLY a single JSON object, no prose:
{"questions":[{"fid":"F0","canonical":"...","paraphrases":[{"text":"...","lexical_overlap":"partial"},{"text":"...","lexical_overlap":"none"}]}]}`;
}

/**
 * Author questions for a repo. `opts`: { agent?, maxFacts=15, exemplars, onProgress }.
 * Returns [] on any failure (not logged in, no CLI, unparseable) — never throws.
 */
export async function authorQuestions(dump, sandbox, opts = {}) {
  const { agent, maxFacts = 15, exemplars = [], onProgress = () => {} } = opts;
  const facts = sampleFacts(dump, maxFacts);
  if (!facts.length) return [];

  onProgress({ phase: "questions", msg: `Styleguided authoring: asking agent for ${facts.length} human-type questions…` });
  const { agent: usedAgent, raw } = await runAgent(buildPrompt(facts, exemplars), { cwd: sandbox, timeoutMs: 300000 });
  const parsed = extractJson(raw); // throws with a clear "not logged in" message when unauthenticated
  const authored = parsed.questions || [];
  const byFid = new Map(authored.map((a) => [a.fid, a]));

  const out = [];
  let i = 0;
  for (const f of facts) {
    const a = byFid.get(f.fid);
    if (!a || !a.canonical) continue;
    const { category, ground_truth } = groundTruthFor(f);
    const sym = f.symbol || f.caller;
    const words = spaceOut(sym);
    // honesty check: a "none" phrasing that still contains the identifier isn't "none"
    const paraphrases = (a.paraphrases || [])
      .filter((p) => p && p.text)
      .map((p) => {
        const t = p.text.toLowerCase();
        let overlap = p.lexical_overlap === "none" ? "none" : "partial";
        if (overlap === "none" && (t.includes(sym.toLowerCase()) || (words.includes(" ") && t.includes(words))))
          overlap = "partial";
        return { text: p.text, lexical_overlap: overlap };
      });

    const id = pad("LA", ++i);
    out.push({
      id,
      category,
      source: "llm-authored",
      split: splitFor(id),
      negative: false,
      query_canonical: a.canonical,
      query_paraphrases: paraphrases,
      ground_truth,
    });
  }
  onProgress({ phase: "questions", msg: `Styleguided authoring: ${out.length} questions authored by ${usedAgent}.` });
  return out.map((q) => ({ ...q, author: usedAgent }));
}
