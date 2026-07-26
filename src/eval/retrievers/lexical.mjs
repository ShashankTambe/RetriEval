/**
 * Baseline retrievers — what an agent does WITHOUT LessTokenify.
 *
 *  - grep (lexical) : naive lexical file search (files containing the query
 *              terms, ranked by match count), returning matching lines +
 *              context. This is "the agent greps the repo".
 *              NOTE: this is a pure-JS grep, NOT the real `rg`/`grep` binary —
 *              done so it runs inside the packaged .exe with no external
 *              dependency. grep, ripgrep, and this JS version all find the SAME
 *              files (all lexical); they differ only in speed, not results. The
 *              internal id stays "ripgrep" for back-compat; the display label is
 *              the honest "grep (lexical)".
 *  - wholefile: same lexical file-finding, but returns the ENTIRE file(s) — the
 *              token-expensive baseline ("the agent reads the whole file").
 *
 * Both use the SAME candidate ranking, so their RECALL is identical and only
 * their TOKEN cost differs — which is exactly the point of the comparison.
 * Uniform retriever interface: (repoRoot, query, ctx) -> { files, contextTokens, wholeFileTokens }.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../tokens.mjs";

const TOP_K = 5;
const SNIPPET_CHAR_CAP = 2000; // comparable to LT's per-file cap

const STOP = new Set([
  "where", "what", "which", "does", "is", "are", "the", "a", "an", "in", "on", "of",
  "to", "for", "and", "or", "how", "do", "defined", "define", "definition", "call",
  "calls", "depends", "depend", "import", "imports", "internal", "modules", "module",
  "file", "files", "function", "functions", "symbol", "code", "this", "that", "with",
  "by", "from", "used", "uses", "use", "answer", "repo",
]);

// term extraction: keep identifiers/paths length>=3, drop boilerplate stopwords
function terms(query) {
  return [...new Set(
    query
      .split(/[^A-Za-z0-9_.]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOP.has(t.toLowerCase())),
  )];
}

// per-run file-content cache
const cache = new Map();
function contentOf(repoRoot, file) {
  const key = repoRoot + "\0" + file;
  if (!cache.has(key)) {
    try { cache.set(key, readFileSync(join(repoRoot, file), "utf8")); }
    catch { cache.set(key, ""); }
  }
  return cache.get(key);
}

function rank(repoRoot, files, query) {
  const ts = terms(query).map((t) => t.toLowerCase());
  if (!ts.length) return [];
  const scored = [];
  for (const file of files) {
    const lc = contentOf(repoRoot, file).toLowerCase();
    if (!lc) continue;
    let score = 0;
    for (const t of ts) {
      let idx = lc.indexOf(t), c = 0;
      while (idx !== -1 && c < 500) { c++; idx = lc.indexOf(t, idx + t.length); }
      // filename match is a strong signal (queries often name the file)
      if (file.toLowerCase().includes(t)) score += 20;
      score += c;
    }
    if (score > 0) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_K);
}

// matching lines + a little context, capped — what a grep user actually reads
function grepSnippet(repoRoot, file, query) {
  const ts = terms(query).map((t) => t.toLowerCase());
  const lines = contentOf(repoRoot, file).split(/\r?\n/);
  const keep = new Set();
  lines.forEach((ln, i) => {
    const lc = ln.toLowerCase();
    if (ts.some((t) => lc.includes(t))) { for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < lines.length) keep.add(j); }
  });
  const picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  let out = picked.join("\n");
  if (out.length > SNIPPET_CHAR_CAP) out = out.slice(0, SNIPPET_CHAR_CAP);
  return out;
}

function pack(repoRoot, ranked, snippetFn) {
  const files = ranked.map((r) => {
    const full = contentOf(repoRoot, r.file);
    const snippet = snippetFn(repoRoot, r.file);
    return {
      file: r.file,
      score: r.score,
      snippet,
      snippetTokens: estimateTokens(snippet),
      fullFileTokens: estimateTokens(full),
    };
  });
  return {
    files,
    contextTokens: files.reduce((s, f) => s + f.snippetTokens, 0),
    wholeFileTokens: files.reduce((s, f) => s + f.fullFileTokens, 0),
  };
}

export async function ripgrepRetrieve(repoRoot, query, ctx = {}) {
  const ranked = rank(repoRoot, ctx.files || [], query);
  return pack(repoRoot, ranked, (root, file) => grepSnippet(root, file, query));
}

export async function wholeFileRetrieve(repoRoot, query, ctx = {}) {
  const ranked = rank(repoRoot, ctx.files || [], query);
  // snippet == entire file: the no-compression, token-expensive baseline
  return pack(repoRoot, ranked, (root, file) => contentOf(root, file));
}

export function clearLexicalCache() { cache.clear(); }
