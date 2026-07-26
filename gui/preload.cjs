// Bridges the sandboxed renderer to the main process. CommonJS (required for
// contextIsolation preloads). Exposes a minimal, explicit API, no Node access
// leaks into the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("evalAPI", {
  pickRepo: () => ipcRenderer.invoke("pick-repo"),
  checkAgents: () => ipcRenderer.invoke("check-agents"),
  agentAuthStatus: (provider) => ipcRenderer.invoke("agent-auth-status", provider),
  agentLogin: (provider) => ipcRenderer.invoke("agent-login", provider),
  runEval: (repoPath, opts) => ipcRenderer.invoke("run-eval", repoPath, opts),
  runAgentRetriever: (payload) => ipcRenderer.invoke("run-agent-retriever", payload),
  saveReport: (markdown, name) => ipcRenderer.invoke("save-md", markdown, name),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, p) => cb(p)),
});
