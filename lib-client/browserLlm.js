// Thin wrapper around /public/qwen-worker.js (in-browser Qwen3.5 via WebGPU).
let worker = null;
const listeners = new Set();
let seq = 0;

export const BROWSER_MODELS = [
  { id: process.env.NEXT_PUBLIC_BROWSER_MODEL_ID || "onnx-community/Qwen3.5-2B-ONNX-OPT", label: "Qwen3.5-2B (≈1.5–2 GB download)" },
  { id: "onnx-community/Qwen3.5-0.8B-ONNX-OPT", label: "Qwen3.5-0.8B (smaller, for weaker GPUs)" },
];

function getWorker() {
  if (!worker) {
    worker = new Worker("/qwen-worker.js", { type: "module" });
    worker.onmessage = (e) => listeners.forEach((fn) => fn(e.data));
    worker.onerror = (e) => listeners.forEach((fn) => fn({ type: "error", stage: "worker", message: e.message || "Worker failed to start" }));
  }
  return worker;
}

export function onWorkerMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function webgpuAvailable() {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/** Terminate the worker (frees GPU memory); the next load starts a fresh one. */
export function resetBrowserModel() {
  if (worker) worker.terminate();
  worker = null;
}

export function loadBrowserModel(modelId) {
  getWorker().postMessage({ type: "load", modelId });
}

/** Generate with the loaded model. Resolves with the final text; onToken receives streamed text. */
export function generateInBrowser(messages, onToken, maxNewTokens = 300) {
  const id = `g${++seq}`;
  return new Promise((resolve, reject) => {
    const off = onWorkerMessage((m) => {
      if (m.id !== id) return;
      if (m.type === "token") onToken?.(m.text);
      if (m.type === "done") {
        off();
        resolve(m.text);
      }
      if (m.type === "error") {
        off();
        const err = new Error(m.message);
        err.deviceLost = !!m.deviceLost;
        reject(err);
      }
    });
    getWorker().postMessage({ type: "generate", id, messages, maxNewTokens });
  });
}
