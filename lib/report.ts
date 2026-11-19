// Structured consultation report for an energy adviser. All figures come from the tools;
// an optional LLM-written executive summary is verified before it is used.
import { DATA, getBuilding } from "./data";
import { METER_LABEL, METERS, num, pct, range } from "./format";
import { planAnswer } from "./chat";
import type { AnswerPlan, EvidenceItem, MissingItem } from "./types";

export interface Report {
  buildingId: string;
  title: string;
  generatedAt: string;
  synthetic: boolean;
  plans: { summary: AnswerPlan; anomalies: AnswerPlan; compare: AnswerPlan; improvements: AnswerPlan };
  evidence: EvidenceItem[];
  missing: MissingItem[];
  summaryPlan: AnswerPlan;
}

export function buildReport(buildingId: string): Report | null {
  const b = getBuilding(buildingId);
  if (!b) return null;
  const id = String(b.profile.building_id);
  const summary = planAnswer(`Summarise building ${id}'s energy use.`, id);
  const anomalies = planAnswer(`Which periods need investigating for building ${id}?`, id);
  const compare = planAnswer(`How does building ${id} compare with similar buildings?`, id);
  const improvements = planAnswer(`What improvements should I consider for building ${id}?`, id);
  const summaryPlan = planAnswer(`Prepare a report for an energy adviser on building ${id}.`, id, { forReport: true });
  // de-duplicate evidence across sections by title, re-numbered in the report appendix
  const seen = new Map<string, EvidenceItem>();
  for (const p of [summary, anomalies, compare, improvements]) for (const e of p.evidence) if (!seen.has(`${e.kind}|${e.title}`)) seen.set(`${e.kind}|${e.title}`, e);
  const missing: MissingItem[] = [];
  for (const p of [summary, anomalies, compare, improvements]) for (const m of p.missing) if (!missing.some((x) => x.text === m.text)) missing.push(m);
  return {
    buildingId: id,
    title: `Energy evidence report — building ${id} (${b.profile.primary_use})`,
    generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    synthetic: DATA.meta.synthetic,
    plans: { summary, anomalies, compare, improvements },
    evidence: [...seen.values()],
    missing,
    summaryPlan,
  };
}

function section(title: string, plan: AnswerPlan): string {
  // citations are section-local: prefix with the section letter so they stay traceable in the appendix
  const lines = [`## ${title}`, ""];
  for (const k of plan.keyPoints) lines.push(`- ${k.text}${k.cites.length ? ` [${k.cites.join(", ")}]` : ""}`);
  if (plan.investigate.length) {
    lines.push("", "**Questions to investigate**", ...plan.investigate.slice(0, 6).map((q) => `- ${q}`));
  }
  lines.push("", "<details><summary>Evidence for this section</summary>", "");
  for (const e of plan.evidence) lines.push(`- **[${e.id}] ${e.title}** — ${e.summary} _Source: ${e.source}${e.url ? ` (${e.url})` : ""}._`);
  lines.push("", "</details>", "");
  return lines.join("\n");
}

export function reportMarkdown(r: Report, executiveSummary: string, summarySource: string): string {
  const b = getBuilding(r.buildingId)!;
  const p = b.profile;
  const meters = METERS.filter((m) => b.meters[m]);
  const lines: string[] = [
    `# ${r.title}`,
    "",
    `Generated ${r.generatedAt} by the Building Energy Evidence Assistant. Data: ${DATA.meta.dataset}, ${DATA.meta.period.start} to ${DATA.meta.period.end}.`,
    ...(r.synthetic ? ["", "> ⚠️ **Synthetic demo data** — these are not real buildings. Run notebook 02 to load ASHRAE buildings."] : []),
    "",
    "## Executive summary",
    "",
    executiveSummary,
    "",
    `_Summary written by: ${summarySource}. Citations refer to the evidence list directly below; each later section has its own evidence list._`,
    "",
    "<details><summary>Evidence for the executive summary</summary>",
    "",
    ...r.summaryPlan.evidence.map((e) => `- **[${e.id}] ${e.title}** — ${e.summary}`),
    "",
    "</details>",
    "",
    "## Building profile",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Building | ${p.building_id} (site ${p.site_id}) |`,
    `| Primary use | ${p.primary_use} |`,
    `| Floor area | ${num(p.floor_area_m2)} m² (${num(p.square_feet)} sq ft) |`,
    `| Year built / floors | ${p.year_built ?? "unknown"} / ${p.floor_count ?? "unknown"} |`,
    `| Meters | ${meters.map((m) => METER_LABEL[m]).join(", ")} |`,
    "",
    "## Consumption and uncertainty by meter",
    "",
    "| Meter | Annualised | Intensity | Coverage | Baseline hourly CV(RMSE) | Guideline 14 (hourly / monthly) | Unusual periods | Unit status |",
    "|---|---|---|---|---|---|---|---|",
    ...meters.map((mt) => {
      const m = b.meters[mt]!;
      const u = m.unit.display_unit;
      const f = m.baseline_fit;
      return `| ${METER_LABEL[mt]} | ${num(m.stats.annualised_estimate)} ${u} | ${num(m.stats.intensity_per_m2, 1)} ${u}/m²/yr | ${pct(m.stats.coverage_pct)} | ${pct(f.cv_rmse_hourly_pct)} | ${f.g14_hourly_pass ? "meets" : "does not meet"} / ${f.g14_monthly_pass ? "meets" : "does not meet"} | ${m.anomalies.length} | ${m.unit.status} |`;
    }),
    "",
    "## Unusual periods",
    "",
    "| Meter | Period | Actual | Expected (range) | Difference | Confidence |",
    "|---|---|---|---|---|---|",
    ...meters.flatMap((mt) =>
      b.meters[mt]!.anomalies.slice(0, 6).map((a) => {
        const u = b.meters[mt]!.unit.display_unit;
        return `| ${METER_LABEL[mt]} | ${range(a.start, a.end)} | ${num(a.actual_total)} ${u} | ${num(a.expected_total)} (${num(a.expected_range_low)}–${num(a.expected_range_high)}) | ${a.difference_pct !== null && a.difference_pct > 0 ? "+" : ""}${num(a.difference_pct, 1)}% | ${a.confidence} |`;
      }),
    ),
    "",
    section("Overview", r.plans.summary),
    section("Periods that need investigating", r.plans.anomalies),
    section("Comparison with similar buildings", r.plans.compare),
    section("Improvements to consider (guidance, not a design)", r.plans.improvements),
    "## Outstanding questions and missing information",
    "",
    ...r.missing.map((m) => `- **${m.text}** — ${m.why}`),
    "",
    "## Method and limitations",
    "",
    ...Object.entries(DATA.meta.methods).map(([k, v]) => `- **${k.replace(/_/g, " ")}:** ${v}`),
    "- The assistant does not determine causes; flagged periods are prompts for investigation.",
    "- Savings estimates require system details, costs and tariffs that are not in the dataset.",
    "- Guidance cards are paraphrased from public sources and must be reviewed by a qualified energy adviser.",
    "",
  ];
  return lines.join("\n");
}
