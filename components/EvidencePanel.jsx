"use client";
import { useEffect } from "react";
import { DailyChart, MonthlyChart, PeerStrip, ProfileChart } from "./Charts";
import { METER_LABEL } from "../lib/format";

const KIND_LABEL = {
  profile: "Building record",
  stats: "Statistics",
  monthly: "Monthly table",
  period: "Period total",
  data_quality: "Data quality",
  baseline: "Baseline & uncertainty",
  anomaly: "Flagged period",
  peers: "Peer comparison",
  guidance: "Verified guidance",
  method: "Method",
};

function EvidenceCard({ item, msgId, highlighted }) {
  return (
    <article id={`ev-${msgId}-${item.id}`} className={`ev-card${highlighted ? " highlight" : ""}`}>
      <header>
        <span className={`ev-id ${item.kind === "guidance" ? "g" : ""}`}>{item.id}</span>
        <span className="ev-kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
        {item.confidence && <span className={`conf conf-${item.confidence}`}>{item.confidence} confidence</span>}
      </header>
      <h4>{item.title}</h4>
      <p className="ev-summary">{item.summary}</p>
      <details>
        <summary>Records ({item.rows.length})</summary>
        <table className="kv">
          <tbody>
            {item.rows.map(([k, v], i) => (
              <tr key={i}>
                <th scope="row">{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <footer>
        <div><span className="muted">Source:</span> {item.source}{item.url && <> · <a href={item.url} target="_blank" rel="noopener noreferrer">open source</a></>}</div>
        {item.method && <div><span className="muted">Method:</span> {item.method}</div>}
      </footer>
    </article>
  );
}

export default function EvidencePanel({ tab, setTab, message, detail, chart, setChart, highlight, buildingId }) {
  const plan = message?.plan;
  useEffect(() => {
    if (!highlight || !message) return;
    const el = document.getElementById(`ev-${message.id}-${highlight}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlight, message]);

  const meters = detail ? Object.keys(detail.meters) : [];
  const meterName = chart.meter && detail?.meters[chart.meter] ? chart.meter : meters[0];
  const meter = meterName ? detail.meters[meterName] : null;
  const unit = meter?.unit.display_unit;
  const focus = plan?.focus && plan.parsed.buildingId === buildingId ? plan.focus : null;

  return (
    <aside className="panel evidence" aria-label="Evidence">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "evidence"} className={tab === "evidence" ? "on" : ""} onClick={() => setTab("evidence")}>
          Evidence{plan ? ` (${plan.evidence.length})` : ""}
        </button>
        <button role="tab" aria-selected={tab === "charts"} className={tab === "charts" ? "on" : ""} onClick={() => setTab("charts")}>Charts</button>
      </div>

      {tab === "evidence" && (
        <div className="ev-list">
          {!plan && <p className="muted pad">Ask a question: the records, calculations and guidance behind each answer appear here, numbered so every sentence can be traced.</p>}
          {plan && (
            <>
              <div className="route">
                <div><span className="muted">Understood as:</span> <strong>{plan.parsed.intent}</strong>{plan.parsed.buildingId ? <> · building {plan.parsed.buildingId} ({plan.parsed.buildingSource === "context" ? "from selection" : "named in question"})</> : null}{plan.parsed.period ? <> · {plan.parsed.period.label}</> : null}{plan.parsed.meter ? <> · {METER_LABEL[plan.parsed.meter]}</> : null}</div>
              </div>
              {plan.evidence.map((e) => (
                <EvidenceCard key={e.id} item={e} msgId={message.id} highlighted={highlight === e.id} />
              ))}
              {plan.missing.length > 0 && (
                <article className="ev-card missing">
                  <header><span className="ev-id m">?</span><span className="ev-kind">Missing information</span></header>
                  <ul>
                    {plan.missing.map((m) => (
                      <li key={m.id}><strong>{m.text}</strong> — {m.why}</li>
                    ))}
                  </ul>
                </article>
              )}
            </>
          )}
        </div>
      )}

      {tab === "charts" && (
        <div className="charts">
          {!detail && <p className="muted pad">Select a building.</p>}
          {detail && (
            <>
              <div className="chart-controls">
                <div className="seg" role="group" aria-label="Chart">
                  {[["daily", "Daily vs expected"], ["monthly", "Monthly"], ["profile", "24-hour profile"], ["peers", "Peers"]].map(([k, l]) => (
                    <button key={k} className={chart.kind === k ? "on" : ""} aria-pressed={chart.kind === k} onClick={() => setChart({ ...chart, kind: k })}>{l}</button>
                  ))}
                </div>
                <label className="select">
                  <span className="sr-only">Meter</span>
                  <select value={meterName} onChange={(e) => setChart({ ...chart, meter: e.target.value })}>
                    {meters.map((m) => <option key={m} value={m}>{METER_LABEL[m]}</option>)}
                  </select>
                </label>
              </div>
              {meter && chart.kind === "daily" && <DailyChart meter={meter} unit={unit} focus={focus} />}
              {meter && chart.kind === "monthly" && <MonthlyChart meter={meter} unit={unit} focus={focus} />}
              {meter && chart.kind === "profile" && <ProfileChart meter={meter} unit={unit} />}
              {meter && chart.kind === "peers" && <PeerStrip meter={meter} unit={unit} buildingId={buildingId} />}
              {meter && (
                <div className="fit-note">
                  <strong>Uncertainty:</strong> baseline hourly CV(RMSE) {meter.baseline_fit.cv_rmse_hourly_pct ?? "n/a"}% ({meter.baseline_fit.g14_hourly_pass ? "meets" : "does not meet"} ASHRAE Guideline 14), coverage {meter.stats.coverage_pct}%, unit {meter.unit.status}.
                </div>
              )}
              {meter && (
                <details className="table-view">
                  <summary>Data table (monthly)</summary>
                  <table className="data">
                    <thead><tr><th>Month</th><th>Actual</th><th>Expected</th><th>Diff.</th><th>Coverage</th><th>Temp.</th></tr></thead>
                    <tbody>
                      {meter.monthly.map((r) => (
                        <tr key={r.month}><td>{r.month}</td><td>{r.actual?.toLocaleString("en-GB")}</td><td>{r.baseline?.toLocaleString("en-GB") ?? "n/a"}</td><td>{r.difference_pct ?? "n/a"}%</td><td>{r.coverage_pct}%</td><td>{r.mean_temp_c} °C</td></tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
