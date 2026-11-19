"use client";
import { BROWSER_MODELS } from "../lib-client/browserLlm";

export default function ModelPanel({ mode, setMode, serverLlm, browser, setBrowserModel, loadBrowser }) {
  const pct = browser.progress && browser.progress.total ? Math.round((100 * browser.progress.loaded) / browser.progress.total) : null;
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
      <label className={`opt ${mode === "server" ? "on" : ""} ${serverLlm.enabled ? "" : "disabled"}`}>
        <input type="radio" name="mode" disabled={!serverLlm.enabled} checked={mode === "server"} onChange={() => setMode("server")} />
        <span>
          <strong>Qwen3.5-2B on a server</strong>
          <span className="muted small">{serverLlm.enabled ? `Connected: ${serverLlm.model}` : "Not configured — set LLM_BASE_URL in Vercel (see README)."}</span>
        </span>
      </label>
      <label className={`opt ${mode === "browser" ? "on" : ""} ${browser.supported === false ? "disabled" : ""}`}>
        <input type="radio" name="mode" disabled={browser.supported === false} checked={mode === "browser"} onChange={() => setMode("browser")} />
        <span>
          <strong>Qwen3.5 in this browser</strong>
          <span className="muted small">
            {browser.supported === false
              ? "WebGPU is not available in this browser (try desktop Chrome or Edge)."
              : "Runs on your GPU with WebGPU; nothing leaves your device."}
          </span>
        </span>
      </label>
      {mode === "browser" && browser.supported !== false && (
        <div className="browser-model">
          <select value={browser.modelId} onChange={(e) => setBrowserModel(e.target.value)} disabled={browser.status === "loading"} aria-label="Browser model">
            {BROWSER_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {browser.status !== "ready" && (
            <button className="primary" onClick={loadBrowser} disabled={browser.status === "loading"}>
              {browser.status === "loading" ? "Loading…" : "Load model"}
            </button>
          )}
          {browser.status === "loading" && (
            <div className="progress" aria-live="polite">
              <div className="bar"><span style={{ width: `${pct ?? 5}%` }} /></div>
              <span className="small muted">{browser.statusText}{pct !== null ? ` ${pct}%` : ""}</span>
            </div>
          )}
          {browser.status === "ready" && <div className="small ok-text">✓ Model ready</div>}
          {browser.status === "error" && <div className="small error">Could not load: {browser.error}. Answers fall back to the approved template.</div>}
          {browser.status !== "ready" && <div className="small muted">Until the model is loaded, answers use the approved template.</div>}
        </div>
      )}
      <p className="small muted fine">
        Every answer is checked: numbers must match the evidence, citations must exist, and missing information must be stated. Failed answers are flagged.
      </p>
    </section>
  );
}
