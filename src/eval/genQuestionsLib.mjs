/**
 * Repo-agnostic question generator (library form). Given a mechanical dump
 * (from tools/staticAnalysis.ts — independent of LessTokenify), emit grounded
 * questions across Location / Relationship / Flow. Same logic as
 * tools/genQuestions.mjs but as a pure function with no curated overlay, so it
 * works for ANY repo the GUI is pointed at.
 */
const base = (f) => f.split("/").pop();
const uniq = (arr) => [...new Set(arr)];
const pad = (p, n) => p + String(n).padStart(4, "0");
const lines = (s) => `${s.lineStart}-${s.lineEnd}`;
const splitFor = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 4 === 0 ? "blind" : "dev";
};

/**
 * camelCase/snake_case → spaced words ("addLead" → "add lead"). Used to derive
 * a PARTIAL-overlap paraphrase mechanically: the query no longer contains the
 * literal symbol, only its word fragments. A NONE-overlap paraphrase cannot be
 * derived mechanically (it requires semantics) — those come from curated sets.
 */
const spaceOut = (name) =>
  name
    .replace(/[_.]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function generate(dump) {
  const q = [];
  let i;

  // GL — Location: every symbol definition site
  i = 0;
  for (const s of dump.symbols) {
    const id = pad("GL", ++i);
    const qualified = s.container ? `${s.container}.${s.name}` : s.name;
    const spaced = spaceOut(s.name);
    const paraphrases = [];
    // partial-overlap variant only when splitting actually removed the literal symbol
    if (spaced.includes(" ") && spaced !== s.name.toLowerCase()) {
      paraphrases.push({
        text: `where is the ${spaced} logic implemented`,
        lexical_overlap: "partial",
      });
    }
    q.push({
      id,
      category: "Location",
      source: "generated",
      split: splitFor(id),
      negative: false,
      query_canonical: `Where is ${qualified} defined (in ${base(s.file)})?`,
      query_paraphrases: paraphrases,
      ground_truth: {
        required: [{ symbol: s.name, file: s.file, lines: lines(s) }],
        answer_text: `${qualified} (${s.kind}) at ${s.file}:${lines(s)}.`,
      },
    });
  }

  // RD — Relationship: dependents of each symbol (usedBy)
  i = 0;
  for (const key of Object.keys(dump.usedBy || {})) {
    const [file, sym] = key.split("::");
    const deps = dump.usedBy[key];
    if (!deps.length) continue;
    const id = pad("RD", ++i);
    q.push({
      id,
      category: "Relationship",
      source: "generated",
      split: splitFor(id),
      negative: false,
      query_canonical: `What depends on ${sym} (defined in ${base(file)})?`,
      ground_truth: {
        dependents: deps.map((f) => ({ file: f, relation: "reference" })),
        answer_text: `${sym} is referenced by: ${deps.join(", ")}.`,
      },
    });
  }

  // Build import maps
  const importersOf = new Map();
  const importsBy = new Map();
  for (const e of dump.imports) {
    (importersOf.get(e.toFile) || importersOf.set(e.toFile, []).get(e.toFile)).push(e.fromFile);
    (importsBy.get(e.fromFile) || importsBy.set(e.fromFile, []).get(e.fromFile)).push(e.toFile);
  }

  // RI — Relationship: importers of each file (fan-in)
  i = 0;
  for (const [file, imps] of importersOf) {
    const u = uniq(imps);
    if (u.length < 2) continue;
    const id = pad("RI", ++i);
    q.push({
      id,
      category: "Relationship",
      source: "generated",
      split: splitFor(id),
      negative: false,
      query_canonical: `Which files import ${base(file)}?`,
      ground_truth: {
        dependents: u.map((f) => ({ file: f, relation: "import" })),
        answer_text: `${file} is imported by: ${u.join(", ")}.`,
      },
    });
  }

  // RO — Relationship: internal dependencies of each file (fan-out)
  i = 0;
  for (const [file, imps] of importsBy) {
    const u = uniq(imps);
    if (u.length < 2) continue;
    const id = pad("RO", ++i);
    q.push({
      id,
      category: "Relationship",
      source: "generated",
      split: splitFor(id),
      negative: false,
      query_canonical: `What internal modules does ${base(file)} depend on?`,
      ground_truth: {
        dependents: u.map((f) => ({ file: f, relation: "imports" })),
        answer_text: `${file} imports: ${u.join(", ")}.`,
      },
    });
  }

  // FC — Flow: callee set of each multi-callee caller
  const groups = new Map();
  for (const e of dump.callEdges) {
    const k = `${e.callerFile}::${e.caller}`;
    (groups.get(k) || groups.set(k, []).get(k)).push({ callee: e.callee, file: e.calleeFile });
  }
  i = 0;
  for (const [k, callees] of groups) {
    if (callees.length < 2) continue;
    const [callerFile, caller] = k.split("::");
    if (caller === "<module>") continue;
    const id = pad("FC", ++i);
    const sorted = callees.slice().sort((a, b) => a.callee.localeCompare(b.callee));
    q.push({
      id,
      category: "Flow",
      source: "generated",
      split: splitFor(id),
      negative: false,
      query_canonical: `What does ${caller} (in ${base(callerFile)}) call?`,
      ground_truth: {
        path: sorted.map((c) => ({ symbol: c.callee, file: c.file })),
        answer_text: `${caller} calls: ${sorted.map((c) => c.callee).join(", ")}.`,
      },
    });
  }

  return q;
}
