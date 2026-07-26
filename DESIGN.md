# RetriEval, design

The reasoning behind the harness. If the [README](README.md) is *what it does*,
this is *why it's built the way it is*.

## The one load-bearing principle

**Trust comes from where the answer comes from, not from where the question
comes from.**

A retrieval benchmark is only as honest as its answer key. If the thing being
graded had any hand in writing the key, the score is theatre. So RetriEval's
answer key is **mechanical**: a [ts-morph](https://ts-morph.com) static-analysis
pass derives ground truth directly from the source, symbol definitions, import
edges, the call graph, and cross-file references (who-uses-what), with no LLM in
the loop and no awareness of any retriever. Every run rebuilds this from scratch;
the tool never trusts that a human "knows their own repo."

Questions, by contrast, can come from anywhere (a human, a template, an LLM), 
because the question is just a prompt; the *answer* it's checked against is always
the mechanical key.

## The retriever interface

A retriever is one function:

```
(repoRoot, query, ctx) -> { files, contextTokens, wholeFileTokens }
```

That uniformity is the point, grep, whole-file, LessTokenify, and an LLM agent
all implement the same shape, so they're graded identically. Two baselines are
built in and dependency-free:

- **`grep (lexical)`**, a pure-JS lexical search (same files a `grep`/`rg` would
  find; it's the "the agent just searches the repo" baseline).
- **`whole-file`**, returns the entire matched files: the no-compression,
  token-expensive baseline that everything else is measured against for savings.

Any other retriever (LessTokenify, your own, an agent) plugs in beside them. LT
is loaded only if configured (`RETRIEVAL_LT_RUNNER`); absent, the harness runs the
baselines alone.

## Metrics, raw first, composite second

Reported per retriever, first-class and unweighted:

- **Recall**, of the files that actually matter, how many were returned.
- **Precision**, of the files returned, how many mattered.
- **Latency**, median/p95 time to retrieve (no LLM time included).
- **Tokens**, real token counts (o200k / gpt-tokenizer), plus reduction vs
  whole-file.

A weighted per-category composite exists as a *secondary* summary, never the
headline. Raw recall is the number that matters.

## Paraphrase-overlap buckets, the anti-overfit panel

Every question is asked with varying lexical overlap to the code it's about:

| bucket | the query… | who should win |
|---|---|---|
| **exact** | names the symbol/file | any lexical tool |
| **partial** | uses word fragments | lexical tools degrade |
| **none** | describes behaviour, names nothing | only semantics survive |

The **none** bucket is the truth serum. If every retriever collapses there, the
task is purely lexical and "semantic" retrieval isn't earning its cost. It's the
single most revealing panel in the report.

## Question strata & fairness

Questions carry provenance and are **reported separately**, never blended into one
average:

- **control**, a small human-written gold set; doubles as the neutral ruler and
  as style exemplars.
- **generated**, mechanically templated from the answer key (deterministic).
- **llm**, optionally LLM-authored, *offline and frozen* to disk so live runs
  stay deterministic. The model only phrases questions; the answer is always
  attached from the mechanical key.

A **fairness pass** reports each stratum's recall per retriever plus an
"easiness gap" (how much easier the auto-generated questions are than the human
control set), and, when an LLM author is also a contestant family, a home-field
delta. The point is to make bias *visible* rather than pretend it's zero.

## Agent retrievers (bring your own)

An LLM agent (`claude`/`codex`) can enter as a contestant: it greps/reads/follows
inside the sandbox and returns the files it judged relevant, scored against the
same key. It's deliberately kept out of the deterministic core, **sampled,
non-deterministic, login-gated, and it spends the user's own tokens**, and it's
measured on two axes at once: retrieval quality *and* cost-of-searching (tokens +
seconds), since an agent that "wins" by burning 15k tokens per query is a
different animal from a free, instant index.

## Boundaries

- **TS/JS only**, ts-morph derives the key; other languages need their own
  analyzer.
- **Early**, the methodology is the deliverable; there's no published leaderboard.
- The **desktop `.exe` is Windows-only**; the eval engine (CLI) is plain,
  cross-platform Node.

## Roughly how a run flows

```
sandbox copy → ts-morph answer key → build question bank (control + generated
[+ frozen llm]) → expand into query variants (tagged by overlap) → run each
retriever over each variant, timing every call → score file-level P/R + tokens
→ aggregate per retriever / category / overlap bucket → fairness pass → report
```
