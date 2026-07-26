/**
 * LessTokenify retriever adapter.
 *
 * Drives LT's exported runGraphify(repo, query) — pure retrieval, NO LLM, NO
 * interactive prompts, and NO agent-file injection (that only happens in the
 * CLI `init` path). LT auto-builds .lesstokenify/graph.json on first call and
 * reuses it after. runGraphify does not call applyFeedback, so retrieval is
 * deterministic across queries.
 *
 * Returns results normalized to repo-relative forward-slash paths, with token
 * accounting for the token-reduction metric.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./tokens.mjs";

/**
 * Locate LessTokenify's retrieval entry, or return null if it isn't installed.
 * LT is an OPTIONAL, swappable retriever — the harness runs on grep + whole-file
 * with zero sibling dependencies. Point at LT with RETRIEVAL_LT_RUNNER, or drop
 * it next to this repo in dev.
 */
export function findLTRunner(explicit) {
  if (process.env.RETRIEVAL_NO_LT) return null; // force the baseline-only (LT-absent) run
  const candidates = [
    explicit,
    process.env.RETRIEVAL_LT_RUNNER,
    // packaged Electron: extraResources -> resources/lesstokenify/dist/… (only if bundled)
    process.resourcesPath && join(process.resourcesPath, "lesstokenify", "dist", "graphify", "runner.js"),
    // dev: sibling repo next to RetriEval (no hardcoded drive)
    fileURLToPath(new URL("../../../LessTokenify/dist/graphify/runner.js", import.meta.url)),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* keep trying */ }
  }
  return null;
}

let _runGraphify = null;

export async function loadLT(runnerPath) {
  if (!_runGraphify) {
    const found = findLTRunner(runnerPath);
    if (!found) throw new Error("LessTokenify not found (set RETRIEVAL_LT_RUNNER to its dist/graphify/runner.js)");
    const mod = await import(pathToFileURL(found).href);
    _runGraphify = mod.runGraphify;
  }
  return _runGraphify;
}

const norm = (p) => p.replace(/\\/g, "/");

// LT logs verbosely to stdout; silence it around a call.
function quiet(fn) {
  const { log, error, warn, info } = console;
  console.log = console.error = console.warn = console.info = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, error, warn, info });
  }
}

/**
 * @returns {{files: {file,score,snippetTokens,fullFileTokens,snippet}[], contextTokens, wholeFileTokens}}
 */
export async function ltRetrieve(repoRoot, query, ctx = {}) {
  const runGraphify = await loadLT(ctx.ltRunnerPath);
  const raw = quiet(() => runGraphify(repoRoot, query)) || [];
  const files = raw.map((r) => {
    const file = norm(r.filePath);
    const snippet = r.snippet || "";
    let fullFileTokens = 0;
    try {
      fullFileTokens = estimateTokens(readFileSync(join(repoRoot, file), "utf8"));
    } catch {
      /* file may not resolve; leave 0 */
    }
    return {
      file,
      score: r.relevanceScore ?? 0,
      snippetTokens: estimateTokens(snippet),
      fullFileTokens,
      snippet,
    };
  });
  return {
    files,
    contextTokens: files.reduce((s, f) => s + f.snippetTokens, 0),
    wholeFileTokens: files.reduce((s, f) => s + f.fullFileTokens, 0),
  };
}
