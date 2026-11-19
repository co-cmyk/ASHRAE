import { DATA, GUIDANCE } from "../../lib/data";

export const metadata = { title: "Method & limitations · Building Energy Evidence Assistant" };

export default function MethodPage() {
  const m = DATA.meta;
  return (
    <div className="page prose">
      <h1>Method &amp; limitations</h1>
      <p className="lede">How answers are produced, what the evidence can and cannot support, and where the numbers come from.</p>

      <h2>Pipeline</h2>
      <ol>
        <li><strong>Approved calculations (Python, notebook 02).</strong> The ASHRAE data is cleaned, units are converted, a transparent baseline is fitted and unusual periods, peer groups and data-quality issues are computed. The output is <code>data/assistant_data.json</code> — the only source of figures.</li>
        <li><strong>Routing (deterministic).</strong> The question is mapped to an analysis (summary, unusual periods, peers, improvements, report, period totals, data quality), a building, a meter and a period by transparent rules — a 2B model is not reliable at choosing tools.</li>
        <li><strong>Evidence pack.</strong> Tools return numbered evidence items (E1, E2 … for records and calculations, G1 … for guidance) and list missing information.</li>
        <li><strong>Explanation (Qwen3.5-2B).</strong> The model rewrites the verified key points for the question, citing evidence IDs. It runs on a server (OpenAI-compatible endpoint) or entirely in your browser with WebGPU.</li>
        <li><strong>Verification.</strong> Every number in the answer must match the evidence; every citation must exist; missing information must be acknowledged. Failing answers are flagged and the approved template answer is one click away.</li>
      </ol>

      <h2>Calculation methods (from the evidence file)</h2>
      <ul>
        {Object.entries(m.methods).map(([k, v]) => <li key={k}><strong>{k.replace(/_/g, " ")}:</strong> {v}</li>)}
      </ul>
      <p className="muted small">Evidence file: {m.dataset} · pipeline v{m.pipeline_version} · generated {m.generated_at}.</p>

      <h2>What the data cannot support</h2>
      <ul>
        <li>Causes. Meter data shows <em>when</em> and <em>how much</em>, not <em>why</em>; flagged periods are prompts for investigation.</li>
        <li>Savings and payback. These need the current and proposed systems, installed costs, tariffs and financing terms — none are in ASHRAE.</li>
        <li>Building fabric and systems. Insulation, glazing, HVAC type, controls and occupancy are not recorded.</li>
        <li>Years other than 2016 (the assistant uses the training year, where actual readings are available).</li>
        <li>Like-for-like peer comparisons across climates; metering units also differ by site, and some are unverified.</li>
      </ul>

      <h2>Verified guidance collection</h2>
      <p>Improvement suggestions only come from this small collection. Each card paraphrases a public source and records when its link was checked; have a qualified adviser review the collection before production use.</p>
      <ul>
        {GUIDANCE.map((g) => (
          <li key={g.id}><strong>{g.title}</strong> — {g.source.publisher}, <a href={g.source.url} target="_blank" rel="noopener noreferrer">{g.source.title}</a> ({g.source.year}); {g.verification.status}, {g.verification.checked_on}.</li>
        ))}
      </ul>

      <h2>Models</h2>
      <ul>
        <li><strong>Language model:</strong> Qwen3.5-2B (Alibaba Qwen team, Apache-2.0), non-thinking mode, temperature 0.2 on servers and greedy decoding in the browser.</li>
        <li><strong>Baseline:</strong> LBNL time-of-week-and-temperature regression, cross-fitted by month, checked against ASHRAE Guideline 14.</li>
        <li><strong>Leaderboard model (notebook 01):</strong> GPU XGBoost and CatBoost per meter on cleaned, time-zone-aligned data; optional out-of-fold predictions shown as a second baseline.</li>
      </ul>

      <h2>Privacy</h2>
      <p>In browser mode the model and your questions stay on your device. In server mode questions and the evidence pack are sent to the configured endpoint.</p>
    </div>
  );
}
