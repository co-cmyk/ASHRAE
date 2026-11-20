"use client";
import { BROWSER_MODELS, gpuLabel } from "../lib-client/browserLlm";

export default function ModelPanel({ mode, setMode, browser, setBrowserModel, setBrowserDevice, loadBrowser }) {
  const pct = browser.progress && browser.progress.total ? Math.round((100 * browser.progress.loaded) / browser.progress.total) : null;
  const gpuName = gpuLabel(browser.gpu);
  const busy = browser.status === "loading";
  return (
    <section className="panel model" aria-label="Language model">
      <h3>Who writes the answer?</h3>
      <label className={`opt ${mode === "template" ? "on" : ""}`}>
        <input type="radio" name="mode" checked={mode === "template"} onChange={() => setMode("template")} />
        <span>
          <strong>Approved template</strong>
          <span className="muted small">Deterministic wording from the analysis tools. No language model.</span>
        </span>
      </label>
      <label className={`opt ${mode === "browser" ? "on" : ""}`}>
        <input type="radio" name="mode" checked={mode === "browser"} onChange={() => setMode("browser")} />
        <span>
          <strong>Qwen3.5 in this browser</strong>
          <span className="muted small">Runs on your device; nothing leaves it. GPU (WebGPU) is fast; CPU works without a GPU but is slow.</span>
        </span>
      </label>
      {mode === "browser" && (
        <div className="browser-model">
          <div className="small muted">
            {browser.supported === null && "Checking for a GPU…"}
            {browser.supported === true && <>GPU available: {gpuName}</>}
            {browser.supported === false && (browser.gpu?.reason === "no-webgpu" ? "No WebGPU in this browser — CPU only." : "Chrome is not offering this site a GPU right now — CPU only until Chrome restarts.")}
          </div>
          <label className="small">
            Run on{" "}
            <select value={browser.device} onChange={(e) => setBrowserDevice(e.target.value)} disabled={busy} aria-label="Run on">
              <option value="webgpu" disabled={browser.supported === false}>GPU (WebGPU)</option>
              <option value="wasm">CPU (slow, no GPU needed)</option>
            </select>
          </label>
          <select value={browser.modelId} onChange={(e) => setBrowserModel(e.target.value)} disabled={busy} aria-label="Browser model">
            {BROWSER_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {browser.device === "wasm" && <div className="small muted">On CPU expect roughly a minute per answer with 0.8B; 2B is much slower.</div>}
          {browser.status !== "ready" && (
            <button className="primary" onClick={loadBrowser} disabled={busy}>
              {busy ? "Loading…" : browser.status === "error" ? "Try again" : "Load model"}
            </button>
          )}
          {busy && (
            <div className="progress" aria-live="polite">
              <div className="bar"><span style={{ width: `${pct ?? 5}%` }} /></div>
              <span className="small muted">{browser.statusText}{pct !== null ? ` ${pct}%` : ""}</span>
            </div>
          )}
          {browser.status === "ready" && <div className="small ok-text">✓ Model ready on {browser.device === "wasm" ? "CPU" : "GPU"}</div>}
          {browser.status === "error" && <div className="small error" role="alert">{browser.error}</div>}
          {browser.status !== "ready" && <div className="small muted">Until a model is loaded, answers use the approved template.</div>}
        </div>
      )}
    </section>
  );
}
