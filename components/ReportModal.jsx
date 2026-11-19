"use client";
import { useEffect, useState } from "react";
import { mdToHtml, reportHtmlDocument } from "../lib/markdown";
import { download } from "../lib-client/ndjson";
import { generateInBrowser } from "../lib-client/browserLlm";

export default function ReportModal({ buildingId, mode, browserReady, browserModel, onClose }) {
  const [state, setState] = useState({ status: "loading", step: "Collecting evidence…" });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch("/api/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ buildingId, mode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Report failed");
        if (cancelled) return;
        setState({ status: "ready", ...data });
        if (mode === "browser" && browserReady) {
          setState((s) => ({ ...s, step: `Writing the executive summary with ${browserModel} in your browser…`, writing: true }));
          const text = await generateInBrowser(data.messages, null, 420);
          const res2 = await fetch("/api/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ buildingId, mode, summary: text, summarySource: `${browserModel} in the browser (verified)` }),
          });
          const data2 = await res2.json();
          if (!cancelled) setState({ status: "ready", ...data2, writing: false });
        }
      } catch (e) {
        if (!cancelled) setState({ status: "error", error: e.message });
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [buildingId, mode, browserReady, browserModel]);

  const fname = `building-${buildingId}-energy-evidence-report`;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Report" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header className="modal-head">
          <h2>Report for an energy adviser</h2>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        {state.status === "loading" && <p className="pad">{state.step}</p>}
        {state.status === "error" && <p className="pad error">Could not build the report: {state.error}</p>}
        {state.status === "ready" && (
          <>
            <div className="modal-actions">
              <button className="primary" onClick={() => download(`${fname}.md`, state.markdown, "text/markdown")}>Download .md</button>
              <button onClick={() => download(`${fname}.html`, reportHtmlDocument(state.title, state.markdown), "text/html")}>Download .html</button>
              <button
                onClick={() => {
                  const w = window.open("", "_blank");
                  if (!w) return;
                  w.document.write(reportHtmlDocument(state.title, state.markdown));
                  w.document.close();
                  w.focus();
                  setTimeout(() => w.print(), 300);
                }}
              >
                Print / save as PDF
              </button>
              <span className="muted small">
                Summary: {state.summarySource}
                {state.writing ? ` — ${state.step}` : ""}
              </span>
            </div>
            {state.note && <p className="note">{state.note}</p>}
            <div className="report md" dangerouslySetInnerHTML={{ __html: mdToHtml(state.markdown, { citeButtons: false }) }} />
          </>
        )}
      </div>
    </div>
  );
}
