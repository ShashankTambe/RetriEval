/**
 * Sandbox — copy the target repo's SOURCE into a temp workspace so the
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
]);

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

export function hasSource(dir) {
  return existsSync(join(dir, "src")) || existsSync(join(dir, "App.tsx")) || existsSync(join(dir, "index.ts"));
}
