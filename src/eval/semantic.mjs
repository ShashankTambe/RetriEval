/**
 * Deep (semantic) mode — the automatable version of Phase 0 Step 3.
 *
 * Instead of baking in an API key, we shell out to the user's OWN installed
 * agent CLI (`claude` or `codex`), which carries its own auth. Only ever called
 * after an explicit confirm in the UI. The agent reads whole files in the
 * sandboxed repo and returns the SEMANTIC answer key (Architecture components)
 * that the mechanical ts-morph pass cannot produce.
 *
 * Best-effort + defensive: any failure returns an error object and never breaks
 * the mechanical result. Untested against a live CLI in this repo — verify on a
 * machine with claude/codex installed.
 */
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";

function onPath(cmd) {
  return new Promise((resolve) => {
    const finder = isWin ? "where" : "which";
    const p = spawn(finder, [cmd], { shell: isWin });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

export async function detectAgents() {
  const [claude, codex] = await Promise.all([onPath("claude"), onPath("codex")]);
  return { claude, codex };
}

/**
 * Cheap, token-free login check. `claude auth status --json` returns
 * {"loggedIn": bool}. Codex has no equivalent status subcommand, so we can only
 * report presence and let a run reveal auth (loggedIn: null = unknown).
 * Returns { present, loggedIn }.
 */
export async function authStatus(provider = "claude") {
  const agents = await detectAgents();
  if (!agents[provider]) return { present: false, loggedIn: false };
  if (provider !== "claude") return { present: true, loggedIn: null };
  return new Promise((resolve) => {
    const p = spawn("claude", ["auth", "status", "--json"], { shell: isWin });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve({ present: true, loggedIn: null }));
    p.on("close", () => {
      try { resolve({ present: true, loggedIn: !!JSON.parse(out).loggedIn }); }
      catch { resolve({ present: true, loggedIn: null }); }
    });
  });
}

/**
 * Open a VISIBLE terminal running the provider's sign-in command; the CLI then
 * opens the browser for the OAuth flow. Fire-and-forget — the renderer polls
 * authStatus to know when sign-in completed. Never handles credentials itself.
 */
export function openLogin(provider = "claude") {
  const cmd = provider === "codex" ? "codex login" : "claude auth login --claudeai";
  if (isWin) {
    spawn(`start "" cmd /k "${cmd}"`, { shell: true, detached: true, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    spawn(`osascript -e 'tell app "Terminal" to do script "${cmd}"'`, { shell: true, detached: true, stdio: "ignore" });
  } else {
    spawn(cmd, { shell: true, detached: true, stdio: "ignore" });
  }
  return { launched: true, cmd };
}

const PROMPT = `You are producing a SEMANTIC answer key for a code-retrieval benchmark.
Read the source files in the current directory. Identify the major architectural
subsystems (e.g. authentication, state management, data/backend, domain logic,
navigation, monetization, notifications, onboarding, theming, error handling —
whatever actually applies).

Output ONLY a single JSON object, no prose, in exactly this shape:
{"architecture":[{"component":"<name>","files":["relative/path.ts", ...],"description":"<one sentence>"}]}
Use repo-relative forward-slash paths. Include only files that exist.`;

function runCli(cmd, args, { cwd, input, timeoutMs = 240000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: isWin });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
      else resolve(stdout);
    });
    if (input) { child.stdin.write(input); child.stdin.end(); }
  });
}

/**
 * Run an arbitrary prompt through the user's own agent CLI and return raw stdout.
 * Shared by deep-mode (semantic key), the styleguided question author, and the
 * agent retriever — all reuse the same spawn + login handling. Never bakes in an
 * API key. `model`/`effort` map to the CLIs' real flags; `jsonEnvelope` asks
 * claude for its JSON output (carrying token usage) so callers can report cost.
 */
export async function runAgent(prompt, { cwd, agent, timeoutMs, model, effort, jsonEnvelope } = {}) {
  const agents = await detectAgents();
  const which = agent || (agents.claude ? "claude" : agents.codex ? "codex" : null);
  if (!which) throw new Error("No `claude` or `codex` CLI found on PATH");

  let raw;
  if (which === "claude") {
    const args = ["-p"];
    if (jsonEnvelope) args.push("--output-format", "json");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    raw = await runCli("claude", args, { cwd, input: prompt, timeoutMs });
  } else {
    const args = ["exec"];
    if (model) args.push("--model", model); // codex effort flags vary by version — model only, kept honest
    args.push(prompt);
    raw = await runCli("codex", args, { cwd, timeoutMs });
  }
  return { agent: which, raw };
}

/** Pull the largest JSON object out of possibly-chatty CLI output. */
export function extractJson(text) {
  if (/not logged in/i.test(text))
    throw new Error("Your agent CLI is not logged in. Run `claude` once in a terminal and use /login, then retry deep mode.");
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error(`Agent did not return parseable JSON. Output began: "${text.slice(0, 120)}…"`);
}

export async function runSemantic(repoDir, opts = {}) {
  const agents = await detectAgents();
  const which = opts.agent || (agents.claude ? "claude" : agents.codex ? "codex" : null);
  if (!which) throw new Error("No `claude` or `codex` CLI found on PATH");

  let raw;
  if (which === "claude") {
    // headless print mode; prompt via stdin to avoid shell-escaping issues
    raw = await runCli("claude", ["-p"], { cwd: repoDir, input: PROMPT });
  } else {
    raw = await runCli("codex", ["exec", PROMPT], { cwd: repoDir });
  }
  const parsed = extractJson(raw);
  return {
    agent: which,
    generatedAt: new Date().toISOString(),
    components: (parsed.architecture || []).map((c) => ({
      name: c.component,
      anyOf_files: c.files || [],
      description: c.description || "",
    })),
  };
}
