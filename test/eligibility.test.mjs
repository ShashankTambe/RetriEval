/**
 * Eligibility and empty-answer-key guards.
 *
 * The failure these exist to prevent is not a crash, it is a SILENT one: a repo
 * layout that passes the source check, gets analyzed down to almost nothing, and
 * still produces a confident-looking report built on no data. A benchmark that
 * fails loudly is fine. One that publishes a number it did not earn is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasSource, SOURCE_DIRS, ROOT_ENTRIES } from "../src/eval/sandbox.mjs";
import { analyze } from "../src/eval/staticAnalysisLib.mjs";
import { runEvaluation } from "../src/eval/pipeline.mjs";

function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "retrieval-test-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

test("hasSource accepts every layout the analyzer actually globs", () => {
  // If these two disagree, a repo passes the gate and is then analyzed to
  // nothing. They must be driven by the same constants.
  for (const d of SOURCE_DIRS) {
    const repo = tempRepo({ [`${d}/a.ts`]: "export const a = 1;" });
    assert.ok(hasSource(repo), `source dir ${d}/ rejected`);
    rmSync(repo, { recursive: true, force: true });
  }
  for (const f of ROOT_ENTRIES) {
    const repo = tempRepo({ [f]: "export const a = 1;" });
    assert.ok(hasSource(repo), `root entry ${f} rejected`);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a repo with no source root is rejected", () => {
  const repo = tempRepo({ "README.md": "# nothing here" });
  assert.equal(hasSource(repo), false);
  rmSync(repo, { recursive: true, force: true });
});

test("declaration files are not mistaken for source", () => {
  const repo = tempRepo({
    "src/real.ts": "export function real() { return 1; }",
    "src/types.d.ts": "export declare function ghost(): number;",
  });
  const dump = analyze(repo);
  assert.ok(!dump.files.some((f) => f.endsWith(".d.ts")), "a .d.ts file entered the answer key");
  assert.ok(dump.files.includes("src/real.ts"));
  rmSync(repo, { recursive: true, force: true });
});

test("vendored directories are not analyzed as first-party source", () => {
  const repo = tempRepo({
    "src/mine.ts": "export const mine = 1;",
    "src/compiled/theirs.js": "export const theirs = 1;",
  });
  const dump = analyze(repo);
  assert.ok(dump.files.includes("src/mine.ts"));
  assert.ok(!dump.files.some((f) => f.includes("compiled/")), "vendored code entered the answer key");
  rmSync(repo, { recursive: true, force: true });
});

test("a barrel-only package is rejected instead of scored on nothing", async () => {
  // The real-world shape: a monorepo package whose code sits beside index.ts
  // rather than under src/. hasSource() passes, the analyzer finds one file.
  const repo = tempRepo({
    "index.ts": 'export * from "./thing";',
    "thing.ts": "export const thing = 1;",
  });
  assert.equal(hasSource(repo), true, "precondition: the gate does let this through");
  await assert.rejects(
    () => runEvaluation(repo, { onProgress: () => {} }),
    /too few to benchmark/,
    "an almost-empty answer key produced a report instead of an error",
  );
  rmSync(repo, { recursive: true, force: true });
});
