// Thin wrapper around /public/qwen-worker.js (in-browser Qwen3.5 on WebGPU or CPU).
let worker = null;
const listeners = new Set();
let seq = 0;

export const BROWSER_MODELS = [
  { id: process.env.NEXT_PUBLIC_BROWSER_MODEL_ID || "onnx-community/Qwen3.5-2B-ONNX-OPT", label: "Qwen3.5-2B (≈1.5–2 GB, needs a strong GPU)" },
  { id: "onnx-community/Qwen3.5-0.8B-ONNX-OPT", label: "Qwen3.5-0.8B (smaller; best for laptops and CPU)" },
];
export const SMALL_MODEL_ID = BROWSER_MODELS[1].id;

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

/** Asks for a GPU adapter inside the worker (the context ONNX Runtime uses). Resolves with
 *  { ok, reason?, vendor, architecture, description, isFallback, shaderF16, maxBufferMB }. */
export function probeGpu(timeoutMs = 6000) {
  if (typeof Worker === "undefined") return Promise.resolve({ ok: false, reason: "no-worker" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
    const off = onWorkerMessage((m) => {
      if (m.type !== "gpu") return;
      clearTimeout(timer);
      off();
      resolve(m.info);
    });
    getWorker().postMessage({ type: "probe" });
  });
}

/** Human-readable description of the GPU the browser exposes. */
export function gpuLabel(info) {
  if (!info || !info.ok) return null;
  const name = [info.vendor, info.architecture].filter(Boolean).join(" ") || info.description || "GPU";
  return `${name}${info.isFallback ? " (software fallback)" : ""}`;
}

export function likelyLowMemoryGpu(info) {
  if (!info || !info.ok) return false;
  const s = `${info.vendor} ${info.architecture} ${info.description}`.toLowerCase();
  return info.isFallback || /intel|qualcomm|adreno|arm|mali|apple|gen-|xe/.test(s);
}

/** Turns worker errors into advice the user can act on. */
export function explainBrowserError(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "");
  if (code === "no-webgpu") {
    return "This browser has no WebGPU. Use desktop Chrome or Edge, or switch “Run on” to CPU.";
  }
  if (code === "no-adapter" || /Failed to get GPU adapter|no available backend/i.test(msg)) {
    return "Chrome is not giving this site a GPU at the moment. After the GPU has been reset twice on a site (as happened when the model crashed), Chrome blocks WebGPU for that site until it restarts. Fully quit and reopen Chrome (or open chrome://restart), then check chrome://gpu shows “WebGPU: Hardware accelerated”. Meanwhile, switch “Run on” to CPU or use server mode.";
  }
  if (err?.deviceLost || /device (was )?lost/i.test(msg)) {
    return "The GPU was reset while running the model (usually it ran out of graphics memory). Use Qwen3.5-0.8B, close other GPU-heavy tabs, or switch to CPU. Note: one more reset on this site may make Chrome block WebGPU until you restart it.";
  }
  return msg.slice(0, 200) || "Unknown error";
}

/** Terminate the worker (frees GPU memory); the next load starts a fresh one. */
export function resetBrowserModel() {
  if (worker) worker.terminate();
  worker = null;
}

export function loadBrowserModel(modelId, device = "webgpu") {
  getWorker().postMessage({ type: "load", modelId, device });
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
