"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import EvidencePanel from "./EvidencePanel";
import ModelPanel from "./ModelPanel";
import ReportModal from "./ReportModal";
import { AnswerBody, VerificationBadge, sourceLabel } from "./Answer";
import { readNdjson } from "../lib-client/ndjson";
import { BROWSER_MODELS, generateInBrowser, loadBrowserModel, onWorkerMessage, resetBrowserModel, webgpuAvailable } from "../lib-client/browserLlm";

function browserErrorText(e, modelId) {
  if (e.deviceLost) {
    const small = /0\.8B/.test(modelId);
    return `Your GPU stopped responding while running ${modelId.split("/").pop().replace(/-ONNX.*$/, "")} (the browser reset the GPU, usually because it ran out of graphics memory). ` +
      (small ? "Close other GPU-heavy tabs and reload the model, or use server mode." : "Try the Qwen3.5-0.8B option, close other GPU-heavy tabs, or use server mode.") +
      " Showing the approved answer.";
  }
  return `The in-browser model failed (${String(e.message).slice(0, 140)}). Showing the approved answer.`;
}
import { verifyAnswer } from "../lib/verify";
import { METER_LABEL, num } from "../lib/format";

const STARTERS = [
  "Summarise this building's energy use.",
  "Which periods need investigating?",
  "How does it compare with similar buildings?",
  "What improvements should I consider?",
  "Would replacing the heating system save money?",
  "Prepare a report for an energy adviser.",
];

let nextId = 1;

export default function AssistantApp() {
  const [meta, setMeta] = useState(null);
  const [buildings, setBuildings] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [mode, setMode] = useState("template");
  const [serverLlm, setServerLlm] = useState({ enabled: false, model: null });
  const [browser, setBrowser] = useState({ supported: null, status: "idle", modelId: BROWSER_MODELS[0].id, statusText: "", progress: null, error: null });
  const [highlight, setHighlight] = useState(null);
  const [tab, setTab] = useState("evidence");
  const [chart, setChart] = useState({ kind: "daily", meter: null });
  const [reportOpen, setReportOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const files = useRef({});
  const scroller = useRef(null);

  // ---- initial load
  useEffect(() => {
    fetch("/api/buildings").then((r) => r.json()).then((d) => {
      setMeta(d.meta);
      setBuildings(d.buildings);
      const fromUrl = new URLSearchParams(window.location.search).get("building");
      const first = d.buildings.find((b) => b.id === fromUrl) ?? d.buildings[0];
      if (first) setSelected(first.id);
    });
    fetch("/api/health").then((r) => r.json()).then((h) => {
      setServerLlm(h.serverLlm);
      if (h.serverLlm.enabled) setMode("server");
    });
    webgpuAvailable().then((ok) => setBrowser((b) => ({ ...b, supported: ok })));
    return onWorkerMessage((m) => {
      if (m.type === "status") setBrowser((b) => ({ ...b, statusText: m.text }));
      if (m.type === "progress" && m.file) {
        files.current[m.file] = m.done ? { loaded: files.current[m.file]?.total ?? 1, total: files.current[m.file]?.total ?? 1 } : { loaded: m.loaded, total: m.total };
        const all = Object.values(files.current);
        setBrowser((b) => ({ ...b, progress: { loaded: all.reduce((a, f) => a + f.loaded, 0), total: all.reduce((a, f) => a + f.total, 0) } }));
      }
      if (m.type === "ready") setBrowser((b) => ({ ...b, status: "ready", error: null }));
      if (m.type === "error" && m.stage !== "generate") setBrowser((b) => ({ ...b, status: "error", error: m.message }));
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    fetch(`/api/buildings?id=${selected}`).then((r) => r.json()).then((d) => setDetail(d));
  }, [selected]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const update = useCallback((id, patch) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)));
  }, []);

  async function send(text) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const uid = nextId++;
    const aid = nextId++;
    const browserReady = mode === "browser" && browser.status === "ready";
    const reqMode = mode === "browser" ? (browserReady ? "browser" : "template") : mode;
    setMessages((ms) => [...ms, { id: uid, role: "user", text: q }, { id: aid, role: "assistant", text: "", status: "working" }]);
    setActiveId(aid);
    setHighlight(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, buildingId: selected, mode: reqMode }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      let plan = null;
      for await (const ev of readNdjson(res)) {
        if (ev.type === "plan") {
          plan = ev.plan;
          update(aid, { plan, status: reqMode === "template" ? "working" : "streaming" });
          if (plan.parsed.buildingId && plan.parsed.buildingId !== selected) setSelected(plan.parsed.buildingId);
          setChart({ kind: plan.focus.chart, meter: plan.focus.meter });
          if (plan.parsed.intent === "report" && plan.parsed.buildingId) setReportOpen(true);
        }
        if (ev.type === "token") update(aid, (m) => ({ text: (m.text || "") + ev.text }));
        if (ev.type === "final") {
          update(aid, { text: ev.answer, source: ev.source, verification: ev.verification, status: ev.pendingBrowser ? "streaming" : "done", error: ev.error, note: mode === "browser" && !browserReady ? "In-browser model not loaded yet — showing the approved template." : null });
          if (ev.pendingBrowser && plan) {
            update(aid, { text: "", source: `browser:${modelName(browser.modelId)}` });
            try {
              const out = await generateInBrowser(plan.browserMessages, (t) => update(aid, (m) => ({ text: (m.text || "") + t })));
              const v = verifyAnswer(out, plan.approvedNumbers, plan.evidence.map((e) => e.id), plan.requiresMissingAck);
              update(aid, { text: out, verification: v, status: "done" });
            } catch (e) {
              const v = verifyAnswer(plan.template, plan.approvedNumbers, plan.evidence.map((x) => x.id), plan.requiresMissingAck);
              update(aid, { text: plan.template, source: "template", verification: v, status: "done", error: browserErrorText(e, browser.modelId) });
              if (e.deviceLost) {
                resetBrowserModel();
                setBrowser((b) => ({ ...b, status: "error", error: "the GPU was reset — reload the model (the 0.8B option needs less memory)" }));
              }
            }
          }
        }
      }
    } catch (e) {
      update(aid, { text: "", status: "done", error: `Request failed: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }

  function onAnswerClick(e, msg) {
    const id = e.target?.dataset?.cite;
    if (!id) return;
    setActiveId(msg.id);
    setTab("evidence");
    setHighlight(id);
  }

  const active = messages.find((m) => m.id === activeId) ?? [...messages].reverse().find((m) => m.role === "assistant");
  const sel = buildings.find((b) => b.id === selected);

  return (
    <>
      {meta?.synthetic && (
        <div className="banner" role="note">
          <strong>Synthetic demo data.</strong> These buildings are generated in the ASHRAE format so the app works out of the box. Run <code>notebooks/02</code> in Colab and commit <code>data/assistant_data.json</code> to load real ASHRAE buildings.
        </div>
      )}
      <div className="layout">
        <div className="left">
          <section className="panel buildings" aria-label="Buildings">
            <h3>Buildings <span className="muted small">({buildings.length} of {meta?.n_buildings_in_dataset ?? "…"})</span></h3>
            <ul>
              {buildings.map((b) => (
                <li key={b.id}>
                  <button className={`bcard ${b.id === selected ? "on" : ""}`} onClick={() => setSelected(b.id)} aria-pressed={b.id === selected}>
                    <span className="bid">#{b.id}</span>
                    <span className="buse">{b.primary_use}</span>
                    <span className="bmeta">Site {b.site_id} · {num(b.floor_area_m2)} m² · {b.meters.map((m) => METER_LABEL[m].split(" ")[0]).join(", ")}</span>
                    {b.anomalies > 0 && <span className="bflag" title="Flagged periods">{b.anomalies} flagged</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <ModelPanel
            mode={mode}
            setMode={setMode}
            serverLlm={serverLlm}
            browser={browser}
            setBrowserModel={(id) => setBrowser((b) => ({ ...b, modelId: id, status: b.status === "ready" ? "idle" : b.status }))}
            loadBrowser={() => {
              files.current = {};
              setBrowser((b) => ({ ...b, status: "loading", progress: null, error: null }));
              loadBrowserModel(browser.modelId);
            }}
          />
        </div>

        <main className="panel chat" aria-label="Conversation">
          <div className="chat-head">
            <div>
              <h2>{sel ? `Building ${sel.id} · ${sel.primary_use}` : "Choose a building"}</h2>
              {sel && <p className="muted small">Site {sel.site_id} · {num(sel.floor_area_m2)} m² · built {sel.year_built ?? "unknown"} · data {meta?.period.start} to {meta?.period.end}</p>}
            </div>
            <button className="primary" disabled={!selected} onClick={() => setReportOpen(true)}>Report</button>
          </div>
          <div className="messages" ref={scroller}>
            {messages.length === 0 && (
              <div className="welcome">
                <h3>Ask about this building's energy evidence</h3>
                <p className="muted">Figures come from approved Python calculations on the ASHRAE data; the language model only explains them, cites the evidence and asks for what is missing.</p>
                <div className="chips">
                  {STARTERS.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="msg user"><div className="bubble">{m.text}</div></div>
              ) : (
                <div key={m.id} className={`msg assistant ${m.id === active?.id ? "active" : ""}`} onClick={(e) => onAnswerClick(e, m)}>
                  <div className="bubble">
                    {m.source && <div className="src">{sourceLabel(m.source)}</div>}
                    {m.status === "working" && !m.text ? <p className="muted">Analysing…</p> : <AnswerBody text={m.showTemplate ? m.plan?.template : m.text} streaming={m.status === "streaming"} />}
                    {m.error && <p className="note">{m.error}</p>}
                    {m.note && <p className="note">{m.note}</p>}
                    {m.status === "done" && (
                      <VerificationBadge
                        v={m.showTemplate ? verifyAnswer(m.plan.template, m.plan.approvedNumbers, m.plan.evidence.map((e) => e.id), m.plan.requiresMissingAck) : m.verification}
                        isTemplate={m.source === "template"}
                        showingTemplate={!!m.showTemplate}
                        onShowTemplate={() => update(m.id, (x) => ({ showTemplate: !x.showTemplate }))}
                      />
                    )}
                    {m.status === "done" && m.plan && (
                      <div className="msg-actions">
                        <button className="link" onClick={() => { setActiveId(m.id); setTab("evidence"); }}>Evidence ({m.plan.evidence.length})</button>
                        {m.plan.followUps.map((f) => <button key={f} className="chip small" onClick={() => send(f)}>{f}</button>)}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label htmlFor="q" className="sr-only">Question</label>
            <input id="q" value={input} onChange={(e) => setInput(e.target.value)} placeholder={selected ? `Ask about building ${selected}…` : "Ask about a building…"} autoComplete="off" />
            <button className="primary" type="submit" disabled={busy || !input.trim()}>{busy ? "…" : "Ask"}</button>
          </form>
        </main>

        <EvidencePanel tab={tab} setTab={setTab} message={active} detail={detail} chart={chart} setChart={setChart} highlight={highlight} buildingId={selected} />
      </div>
      {reportOpen && selected && (
        <ReportModal buildingId={selected} mode={mode === "browser" ? "browser" : mode} browserReady={browser.status === "ready"} browserModel={modelName(browser.modelId)} onClose={() => setReportOpen(false)} />
      )}
    </>
  );
}

function modelName(id) {
  return (id || "").split("/").pop().replace(/-ONNX.*$/, "");
}
