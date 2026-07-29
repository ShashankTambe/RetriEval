/**
 * Regression tests for question-bank sampling.
 *
 * The bug these guard against: generate() emits every Location question before
 * any Relationship or Flow question, so the old `slice(0, limit)` produced a
 * Location-only bank. Location is the easiest category and the one lexical
 * retrieval does best on, so limited runs quietly flattered the grep baseline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleStratified } from "../src/eval/questionBank.mjs";

// Mirrors generate()'s emission order: all Location, then Relationship, then Flow.
function fakeBank({ GL = 400, RD = 120, RI = 30, RO = 40, FC = 100 } = {}) {
  const out = [];
  const push = (prefix, n) => {
    for (let i = 1; i <= n; i++) out.push({ id: prefix + String(i).padStart(4, "0") });
  };
  push("GL", GL);
  push("RD", RD);
  push("RI", RI);
  push("RO", RO);
  push("FC", FC);
  return out;
}

const mix = (qs) => {
  const m = {};
  for (const q of qs) {
    const k = q.id.replace(/[0-9]/g, "");
    m[k] = (m[k] || 0) + 1;
  }
  return m;
};

test("limit keeps every category, not just the first one emitted", () => {
  const sampled = sampleStratified(fakeBank(), 100);
  const m = mix(sampled);
  for (const k of ["GL", "RD", "RI", "RO", "FC"]) {
    assert.ok(m[k] > 0, `category ${k} vanished from the sampled bank`);
  }
});

test("limit roughly preserves the category proportions", () => {
  const bank = fakeBank();
  const limit = 200;
  const sampled = sampleStratified(bank, limit);
  const full = mix(bank);
  const got = mix(sampled);
  for (const k of Object.keys(full)) {
    const wantPct = (full[k] / bank.length) * 100;
    const gotPct = (got[k] / sampled.length) * 100;
    assert.ok(
      Math.abs(wantPct - gotPct) < 3,
      `${k}: expected ~${wantPct.toFixed(1)}% of the bank, got ${gotPct.toFixed(1)}%`,
    );
  }
});

test("returns exactly the limit, never short", () => {
  // Independently-rounded per-bucket quotas do not sum to the limit, so a naive
  // version silently under-delivers (measured: 99 for a limit of 100) and the
  // shortfall varies per repo, which makes run sizes incomparable.
  for (const n of [7, 10, 50, 100, 137, 200, 689]) {
    assert.equal(sampleStratified(fakeBank(), n).length, n, `limit ${n} did not return ${n}`);
  }
  const even = fakeBank({ GL: 1000, RD: 1000, RI: 1000, RO: 1000, FC: 1000 });
  assert.equal(sampleStratified(even, 7).length, 7);
});

test("a limit smaller than the category count still spans categories", () => {
  // Otherwise tiny limits quietly reproduce the original Location-only bug.
  const m = mix(sampleStratified(fakeBank(), 3));
  assert.equal(Object.keys(m).length, 3, "limit=3 collapsed onto fewer than 3 categories");
  assert.ok(!Object.values(m).some((v) => v > 1), "one category took more than its share");
});

test("a limit at or above the bank size returns the whole bank untouched", () => {
  const bank = fakeBank({ GL: 10, RD: 5, RI: 2, RO: 3, FC: 4 });
  assert.equal(sampleStratified(bank, 999).length, bank.length);
  assert.equal(sampleStratified(bank, 0).length, bank.length); // 0/undefined = no limit
});

test("sampling is deterministic across calls", () => {
  const bank = fakeBank();
  const a = sampleStratified(bank, 137).map((q) => q.id);
  const b = sampleStratified(bank, 137).map((q) => q.id);
  assert.deepEqual(a, b);
});

test("picks reach the very end of every category", () => {
  // A fixed stride can never reach a bucket's final entries, so questions about
  // files that sort last would be invisible in every limited run forever. The
  // last question of each category must be reachable, not merely a late one.
  const caps = { GL: 400, RD: 120, RI: 30, RO: 40, FC: 100 };
  const sampled = sampleStratified(fakeBank(), 100);
  const maxSeen = {};
  for (const q of sampled) {
    const k = q.id.replace(/[0-9]/g, "");
    maxSeen[k] = Math.max(maxSeen[k] || 0, +q.id.slice(2));
  }
  for (const [k, cap] of Object.entries(caps)) {
    assert.equal(maxSeen[k], cap, `${k} never reached its last question (${maxSeen[k]} of ${cap})`);
  }
});
