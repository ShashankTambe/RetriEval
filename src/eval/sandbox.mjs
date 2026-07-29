/**
 * Sandbox, copy the target repo's SOURCE into a temp workspace so the
 * evaluator never mutates the user's real repo (LT writes .lesstokenify there,
 * ts-morph reads it). Excludes heavy/irrelevant dirs. Source-only is enough:
 * both ts-morph and LT operate on the .ts/.tsx/.js/.jsx tree + configs.
 */
import { cpSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, basename } from "node:path";

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".lesstokenify",
  ".expo",
  ".agents",
  ".claude",
  "android",
  "ios",
  "dist",
  "build",
  "web-build",
  // Vendored / pre-bundled third-party code. It is not the repo's own source,
  // and minified single-line bundles wreck both the answer key and the lexical
  // baseline's match-count ranking. (next.js ships hundreds of these under
  // src/compiled, which would otherwise be analyzed as if the repo wrote them.)
  "compiled",
  "vendor",
  "third_party",
  "bundles",
]);

/**
 * Vendored / generated directories that must never be treated as the repo's own
 * source. Exported so the analyzer can apply the same exclusions when it runs
 * against a raw checkout instead of a sandbox copy.
 */
export const EXCLUDED_FROM_ANALYSIS = ["compiled", "vendor", "third_party", "bundles", "node_modules"];

export function makeSandbox(repoRoot) {
  const root = mkdtempSync(join(tmpdir(), "retrieval-eval-"));
  const dest = join(root, basename(repoRoot) || "repo");
  cpSync(repoRoot, dest, {
    recursive: true,
    filter: (src) => {
      const parts = src.split(sep);
      return !parts.some((p) => EXCLUDE_DIRS.has(p));
    },
  });
  return dest;
}

/**
 * Directories treated as a source root, and root entry files, kept in sync with
 * the globs in staticAnalysisLib.analyze(). These MUST agree: if hasSource()
 * accepts a layout that analyze() doesn't glob, the run "succeeds" having
 * analyzed nothing (the nestjs/packages/core case, which passes on a root
 * index.ts barrel and then yields a one-file answer key).
 *
 * `lib/` is deliberately NOT a source root: in most published packages it holds
 * compiled output, and analyzing build artifacts as if they were source
 * produces an answer key the repo's authors never wrote.
 */
export const SOURCE_DIRS = ["src", "source"];
export const ROOT_ENTRIES = [
  "App.tsx", "App.ts", "App.jsx", "App.js",
  "index.ts", "index.tsx", "index.js", "index.jsx",
];

export function hasSource(dir) {
  return (
    SOURCE_DIRS.some((d) => existsSync(join(dir, d))) ||
    ROOT_ENTRIES.some((f) => existsSync(join(dir, f)))
  );
}
