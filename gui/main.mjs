/**
 * Electron main process for the RetriEval evaluator.
 *
 * The heavy evaluation runs in a utilityProcess worker (gui/evalWorker.cjs) so
 * the main thread stays responsive, no "Not Responding" window on Windows.
 * Main handles: folder dialog, save dialog, agent detection, deep mode (spawns
 * the user's claude/codex CLI, IO-bound, doesn't block), and relaying progress.
 */
import { app, BrowserWindow, ipcMain, dialog, utilityProcess } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
// Heavy-ish eval modules (semantic/agentRun) are dynamically imported inside the
// handlers that need them, so they never load during window startup.

const __dirname = dirname(fileURLToPath(import.meta.url));
let win;

/** Locate LT's retrieval entry so we can hand the worker an explicit path
 *  (a utilityProcess may not inherit process.resourcesPath). */
function resolveLtRunner() {
  const cands = [
    process.env.RETRIEVAL_LT_RUNNER,
    process.resourcesPath && join(process.resourcesPath, "lesstokenify", "dist", "graphify", "runner.js"),
    fileURLToPath(new URL("../../LessTokenify/dist/graphify/runner.js", import.meta.url)),
  ].filter(Boolean);
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* keep trying */ } }
  return null;
}

/** Run the pipeline in a worker process; stream progress; resolve the report. */
function runViaWorker(repoPath, opts, onProgress) {
  return new Promise((resolve, reject) => {
    const ltRunner = resolveLtRunner();
    const child = utilityProcess.fork(join(__dirname, "evalWorker.cjs"), [], {
      stdio: "ignore",
      env: { ...process.env, ...(ltRunner ? { RETRIEVAL_LT_RUNNER: ltRunner } : {}) },
    });
    let settled = false;
    child.on("message", (m) => {
      if (m.type === "progress") onProgress?.(m.p);
      else if (m.type === "done") { settled = true; resolve(m.report); child.kill(); }
      else if (m.type === "error") { settled = true; reject(new Error(m.message)); child.kill(); }
    });
    child.on("exit", (code) => { if (!settled) reject(new Error(`evaluation worker exited unexpectedly (code ${code})`)); });
    child.postMessage({ repoRoot: repoPath, opts });
  });
}

/**
 * Env-gated headless self-test, proves the PACKAGED binary runs a full
 * evaluation THROUGH THE WORKER (exercises the utilityProcess path too).
 */
async function maybeSelfTest() {
  const repo = process.env.RETRIEVAL_SELFTEST;
  if (!repo) return false;
  const outPath = join(tmpdir(), "retrieval-selftest.json");
  try {
    const rep = await runViaWorker(repo, { limit: 20 }, () => {});
    writeFileSync(outPath, JSON.stringify({ ok: true, summaryByRetriever: rep.summaryByRetriever }, null, 2));
  } catch (e) {
    writeFileSync(outPath, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    app.exit(1);
    return true;
  }
  app.quit();
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1160,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    show: false, // avoid a blank window flashing while HDD reads the page
    backgroundColor: "#23211D",
    title: "RetriEval, LessTokenify Evaluator",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show()); // paint first, then reveal
  win.loadFile(join(__dirname, "ui", "dashboard.html"));
}

/** Env-gated boot timer: quit at whenReady, record seconds since process start.
 *  Lets us measure pure startup (no window, no pipeline) after a build. */
function maybeBootTest() {
  if (!process.env.RETRIEVAL_BOOTTEST) return false;
  writeFileSync(join(tmpdir(), "retrieval-boottest.txt"), String(process.uptime()));
  app.quit();
  return true;
}

app.whenReady().then(async () => {
  if (maybeBootTest()) return;
  if (await maybeSelfTest()) return;
  createWindow();
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("pick-repo", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: "Select a TypeScript / JavaScript repository",
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("check-agents", async () => {
  const { detectAgents } = await import("../src/eval/semantic.mjs");
  return detectAgents();
});

ipcMain.handle("agent-auth-status", async (_evt, provider) => {
  const { authStatus } = await import("../src/eval/semantic.mjs");
  return authStatus(provider);
});

// Opens a terminal running the provider's sign-in; the CLI opens the browser.
// We never see credentials, the OAuth flow happens entirely in the user's browser.
ipcMain.handle("agent-login", async (_evt, provider) => {
  const { openLogin } = await import("../src/eval/semantic.mjs");
  return openLogin(provider);
});

// Bring-your-own agent retriever, a sampled, non-deterministic contestant that
// spends the user's own tokens. Spawns their CLI (IO-bound, doesn't block the UI
// thread the way the ts-morph core would). Auth failure rejects with a clear
// message the renderer surfaces as "connect your claude/codex".
ipcMain.handle("run-agent-retriever", async (_evt, payload = {}) => {
  const { sandbox, questions, provider, model, effort } = payload;
  if (!sandbox || !existsSync(sandbox)) throw new Error("The evaluated sandbox is no longer on disk, re-run the benchmark first.");
  const { runAgentRetriever } = await import("../src/eval/agentRun.mjs");
  return runAgentRetriever(sandbox, questions, {
    provider, model, effort,
    onProgress: (p) => win?.webContents.send("progress", p),
  });
});

ipcMain.handle("save-md", async (_evt, markdown, suggestedName) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Save report as Markdown",
    defaultPath: suggestedName || "retrieval-report.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (r.canceled || !r.filePath) return { saved: false };
  writeFileSync(r.filePath, markdown, "utf8");
  return { saved: true, path: r.filePath };
});

ipcMain.handle("run-eval", async (_evt, repoPath, opts = {}) => {
  const report = await runViaWorker(repoPath, opts, (p) => win?.webContents.send("progress", p));

  if (opts.deep) {
    win?.webContents.send("progress", { phase: "semantic", msg: "Deep mode, running your agent CLI for the semantic answer key…" });
    try {
      const { runSemantic } = await import("../src/eval/semantic.mjs");
      const semantic = await runSemantic(report.repo.sandbox);
      report.semantic = semantic;
      const outPath = join(app.getPath("userData"), `semantic-${report.repo.name}-${Date.now()}.json`);
      writeFileSync(outPath, JSON.stringify(semantic, null, 2));
      report.semantic.savedTo = outPath;
    } catch (e) {
      report.semantic = { error: String(e.message || e) };
    }
  }
  return report;
});
