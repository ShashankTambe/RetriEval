/**
 * Evaluation worker — runs in an Electron utilityProcess (a separate Node
 * process) so the heavy pipeline (ts-morph analysis, 1000s of retrievals) never
 * blocks the main thread. If it ran on main, Windows would stop pumping the
 * window's message loop and mark the app "Not Responding".
 *
 * CommonJS entry (utilityProcess loads it reliably), dynamic-importing the ESM
 * pipeline. Talks to main over process.parentPort.
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

process.parentPort.on("message", async (e) => {
  const { repoRoot, opts = {} } = e.data || {};
  try {
    const pipelineUrl = pathToFileURL(join(__dirname, "..", "src", "eval", "pipeline.mjs")).href;
    const { runEvaluation } = await import(pipelineUrl);
    const report = await runEvaluation(repoRoot, {
      ...opts,
      onProgress: (p) => process.parentPort.postMessage({ type: "progress", p }),
    });
    process.parentPort.postMessage({ type: "done", report });
  } catch (err) {
    process.parentPort.postMessage({ type: "error", message: String((err && err.stack) || err) });
  }
});
