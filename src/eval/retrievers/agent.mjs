/**
 * Agent retriever, the first "bring your own retriever" (DECISIONS.md §E).
 *
 * An LLM-in-a-loop contestant: instead of a mechanical index, we hand the user's
 * own `claude`/`codex` CLI the query and let it grep/read/follow inside a
 * sandboxed copy, then return the files it judged relevant. This is how we
 * measure LessTokenify against real agentic retrieval.
 *
 * For claude we use `--output-format stream-json` so we can surface what the
 * agent is doing live (its grep/read/glob tool calls) instead of a multi-minute
 * wall of silence, each tool call is reported through ctx.onStep. Codex falls
 * back to a buffered run.
 *
 * Two cost axes are captured, not just quality: the agent spends TOKENS and
 * SECONDS to search (cost-of-searching), where LT is free/instant.
 *
 * Non-deterministic and login-gated by nature, kept out of the deterministic
 * core. Any auth failure surfaces a clear message and never corrupts a run.
 */
import { spawn } from "node:child_process";
import { runAgent, extractJson } from "../semantic.mjs";

const isWin = process.platform === "win32";

const RETRIEVE_PROMPT = (query) => `You are a code RETRIEVER for a benchmark. The repository is your current working directory.
Find the files most relevant to answering this developer question:

"${query}"

Return ONLY the up-to-5 most relevant repository file paths, most relevant first, as a single JSON object, no prose:
{"files":["relative/path.ts", ...]}
Use repo-relative forward-slash paths. Include only files that exist.`;

const sumUsage = (u = {}) =>
  (u.input_tokens || 0) + (u.output_tokens || 0) +
  (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) || null;

const filesFrom = (parsed) =>
  (parsed.files || [])
    .filter((f) => typeof f === "string")
    .slice(0, 5)
    .map((f) => ({ file: f.replace(/\\/g, "/").replace(/^\.\//, "") }));

/** Turn a claude tool_use event into a short human-readable "what it's doing" line. */
function describeTool(name, input = {}) {
  const first = (s, n = 52) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
  const base = (p) => String(p || "").split(/[\\/]/).pop();
  switch (name) {
    case "Grep": return `searching for "${first(input.pattern, 40)}"`;
    case "Read": return `reading ${base(input.file_path) || "a file"}`;
    case "Glob": return `listing ${first(input.pattern, 40)}`;
    case "LS": return `listing ${first(input.path, 40) || "a directory"}`;
    case "Bash": return `running: ${first(input.command, 44)}`;
    case "Task": return "delegating a sub-search";
    default: return `using ${name || "a tool"}`;
  }
}

/** Streaming claude run, reports each tool call via ctx.onStep as it happens. */
function claudeStreamRetrieve(repoRoot, query, ctx) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.effort) args.push("--effort", ctx.effort);

  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn("claude", args, { cwd: repoRoot, shell: isWin });
    let buf = "", stderr = "", finalText = "", usage = null, cost = null, sawResult = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude timed out after ${(ctx.timeoutMs || 240000) / 1000}s`)); }, ctx.timeoutMs || 240000);

    const handle = (evt) => {
      if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
        for (const c of evt.message.content) {
          if (c.type === "tool_use") ctx.onStep?.(describeTool(c.name, c.input));
          else if (c.type === "text" && c.text && c.text.trim()) ctx.onStep?.("reasoning…");
        }
      } else if (evt.type === "result") {
        sawResult = true;
        if (typeof evt.result === "string") finalText = evt.result;
        if (evt.usage) usage = evt.usage;
        if (typeof evt.total_cost_usd === "number") cost = evt.total_cost_usd;
      }
    };

    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* ignore non-JSON noise */ }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      const tail = buf.trim();
      if (tail) { try { handle(JSON.parse(tail)); } catch { /* ignore */ } }
      const latencyMs = +(performance.now() - t0).toFixed(1);
      if (!sawResult && !finalText) return reject(new Error(stderr.trim() || "claude produced no result"));
      let parsed;
      try { parsed = extractJson(finalText); } catch (e) { return reject(e); }
      resolve({ files: filesFrom(parsed), agent: "claude", latencyMs, agentTokens: sumUsage(usage || {}), costUsd: cost });
    });

    child.stdin.write(RETRIEVE_PROMPT(query));
    child.stdin.end();
  });
}

/** Buffered run (codex / non-streaming fallback). */
async function bufferedRetrieve(repoRoot, query, ctx) {
  const t0 = performance.now();
  const { agent, raw } = await runAgent(RETRIEVE_PROMPT(query), {
    cwd: repoRoot, agent: ctx.agent, model: ctx.model, effort: ctx.effort,
    timeoutMs: ctx.timeoutMs || 180000, jsonEnvelope: true,
  });
  const latencyMs = +(performance.now() - t0).toFixed(1);
  let text = raw, agentTokens = null, costUsd = null;
  if (agent === "claude") {
    try {
      const env = JSON.parse(raw);
      if (typeof env.result === "string") text = env.result;
      agentTokens = sumUsage(env.usage);
      costUsd = typeof env.total_cost_usd === "number" ? env.total_cost_usd : null;
    } catch { /* fall back to raw text */ }
  }
  return { files: filesFrom(extractJson(text)), agent, latencyMs, agentTokens, costUsd };
}

/**
 * Retrieve for one query via the agent CLI.
 * ctx: { agent?, model?, effort?, timeoutMs?, onStep? }
 * Returns { files:[{file}], agent, latencyMs, agentTokens, costUsd }.
 */
export async function agentRetrieve(repoRoot, query, ctx = {}) {
  const provider = ctx.agent || "claude";
  // Stream only when claude AND a live-step consumer is listening; else buffer.
  if (provider === "claude" && typeof ctx.onStep === "function") return claudeStreamRetrieve(repoRoot, query, ctx);
  return bufferedRetrieve(repoRoot, query, ctx);
}
