"use client";
import { useEffect, useState } from "react";

const METRICS = [
  ["pass_rate", "All checks passed", "Share of questions where every check below passed."],
  ["building_accuracy", "Correct building", "The building named in the question, or the one selected, was used."],
  ["intent_accuracy", "Correct analysis", "The question was routed to the right tool (summary, anomalies, peers, improvements, report…)."],
  ["period_accuracy", "Correct period", "Months, seasons and date ranges in the question were resolved correctly."],
  ["figure_reproduction", "Calculated figure reproduced", "The key figure for the question (e.g. annual total, March total) appears correctly in the answer."],
  ["numeric_faithfulness", "Numbers traced to evidence", "Share of all numbers in answers that match a figure in the evidence pack."],
  ["citation_validity", "Citations valid", "Every [E#]/[G#] citation points to a real evidence item."],
  ["citation_coverage", "Figures cited", "Answers where at least 80% of sentences or bullets with figures carry a citation."],
  ["missing_info_acknowledged", "Missing information acknowledged", "When information is missing (costs, system details, data outside 2016), the answer says so and asks."],
];

function Tile({ label, help, value, compare }) {
  return (
    <div className="tile" title={help}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value === null || value === undefined ? "–" : `${value}%`}</div>
      {compare !== undefined && <div className="tile-compare muted small">Qwen: {compare === null ? "–" : `${compare}%`}</div>}
    </div>
  );
}

export default function EvalView() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    fetch("/api/eval").then((r) => r.json()).then(setData);
  }, []);
  if (!data) return <div className="page"><p className="muted">Running the evaluation suite…</p></div>;
  const t = data.template;
  const llm = data.llm?.available ? data.llm : null;
  const rows = (llm ? llm.results : t.results).filter((r) => filter === "all" || (filter === "fail" ? !r.pass : r.tags.includes(filter)));
  const tags = [...new Set(t.results.flatMap((r) => r.tags))];
  return (
    <div className="page">
      <h1>Evaluation</h1>
      <p className="lede">
        The assistant is evaluated, not just the prediction model. {t.summary.cases} test questions are generated from the evidence file itself (so the expected answers always match the data) and scored on the checks below.
        This page re-runs the deterministic suite live ({data.ms} ms){t.synthetic ? " on the synthetic demo data" : ""}.
      </p>
      <h2>Assistant checks — approved template answers{llm ? ` vs ${llm.model}` : ""}</h2>
      <div className="tiles">
        {METRICS.map(([k, label, help]) => (
          <Tile key={k} label={label} help={help} value={t.summary[k]} compare={llm ? llm.summary[k] : undefined} />
        ))}
      </div>
      {!llm && (
        <div className="note">
          <strong>Language-model run not recorded yet.</strong> Point <code>LLM_BASE_URL</code> at your Qwen3.5-2B endpoint and run <code>npm run eval -- --llm</code>; commit the resulting <code>data/llm_eval_results.json</code> to show Qwen&apos;s scores here next to the template baseline.
        </div>
      )}
      {llm && <p className="muted small">Language-model run: {llm.model}, {llm.generated_at?.slice(0, 16).replace("T", " ")}, {llm.results.length} questions, {llm.seconds}s.</p>}

      <h2>Prediction model</h2>
      <p>
        The leaderboard model is evaluated in <code>notebooks/01</code>: month-block cross-validated RMSLE per meter, RMSLE on leaked real 2017–2018 readings (sites 0, 1, 2, 4, 15) and the Kaggle public/private scores of two submissions (model only, and with leak insertion).
        The assistant&apos;s transparent baseline is evaluated per building with ASHRAE Guideline 14 metrics (CV(RMSE), NMBE), shown in every baseline evidence item.
      </p>

      <h2>Per-question results{llm ? ` (${llm.model})` : ""}</h2>
      <div className="seg wrap" role="group" aria-label="Filter">
        {["all", "fail", ...tags].map((f) => (
          <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data eval">
          <thead>
            <tr><th>Question</th><th>Analysis</th><th>Building</th><th>Period</th><th>Figure</th><th>Numbers</th><th>Citations</th><th>Missing info</th><th>Pass</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.pass ? "" : "fail"}>
                <td>
                  <details>
                    <summary>{r.question}</summary>
                    <pre className="answer-pre">{r.answer}</pre>
                  </details>
                </td>
                <td>{mark(r.intent.ok)} {r.intent.got}</td>
                <td>{mark(r.building.ok)} {r.building.got ?? "–"}</td>
                <td>{r.period ? mark(r.period.ok) : "–"}</td>
                <td>{r.figure ? mark(r.figure.ok) : "–"}</td>
                <td>{r.verification.numbersSupported}/{r.verification.numbersChecked}</td>
                <td>{mark(r.verification.invalidCitations.length === 0)} {r.verification.citations.length}</td>
                <td>{r.verification.missingRequired ? mark(!!r.verification.mentionsMissing) : "–"}</td>
                <td>{mark(r.pass)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function mark(ok) {
  return <span className={ok ? "ok-text" : "error"} aria-label={ok ? "pass" : "fail"}>{ok ? "✓" : "✗"}</span>;
}
