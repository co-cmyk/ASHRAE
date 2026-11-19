// Evaluation suite for the assistant (not just the prediction model).
// Cases are generated from the evidence file itself, so ground truth always matches the data.
// Checks: correct building, intent, period and meter; reproduces the calculated figure;
// cites valid evidence; numbers are all supported; acknowledges missing information.
import { DATA, buildingIds } from "./data";
import { METER_LABEL } from "./format";
import { planAnswer } from "./chat";
import { extractNumbers, numberSupported, verifyAnswer } from "./verify";
import type { AnswerPlan, Intent, MeterName, Verification } from "./types";

export interface EvalCase {
  id: string;
  question: string;
  context: string | null;
  expect: {
    intent: Intent;
    building: string | null;
    period?: { start: string; end: string };
    meter?: MeterName;
    figure?: { value: number; label: string };
    missingAck?: boolean;
    unknownBuilding?: string;
  };
  tags: string[];
}

export interface CaseResult {
  id: string;
  question: string;
  tags: string[];
  intent: { expected: string; got: string; ok: boolean };
  building: { expected: string | null; got: string | null; ok: boolean };
  period: { expected: string | null; got: string | null; ok: boolean } | null;
  meter: { expected: string | null; got: string | null; ok: boolean } | null;
  figure: { expected: string; ok: boolean } | null;
  verification: Verification;
  pass: boolean;
  answerSource: string;
  answer: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function buildCases(maxBuildings = 8): EvalCase[] {
  const ids = buildingIds().slice(0, maxBuildings);
  const cases: EvalCase[] = [];
  ids.forEach((id, i) => {
    const b = DATA.buildings[id];
    const e = b.meters.electricity;
    const firstMeter = (Object.keys(b.meters)[0] as MeterName) ?? "electricity";
    const main = e ? "electricity" : firstMeter;
    const m = b.meters[main]!;
    cases.push({
      id: `${id}-summary`, question: [`Summarise building ${id}'s energy use.`, `Give me an overview of bldg ${id}.`, `Tell me about building ${id}'s consumption.`][i % 3], context: null,
      expect: { intent: "summary", building: id, figure: m.stats.annualised_estimate !== null ? { value: m.stats.annualised_estimate, label: `annualised ${main}` } : undefined },
      tags: ["summary", i % 3 ? "paraphrase" : "canonical"],
    });
    const anoms = Object.entries(b.meters).flatMap(([mt, md]) => (md?.anomalies ?? []).map((a) => ({ mt, a })));
    cases.push({
      id: `${id}-anomalies`, question: [`Which periods need investigating for building ${id}?`, `Were there any unusual spikes in building ${id}?`, `When was building ${id} higher than expected?`][i % 3], context: null,
      expect: { intent: "anomalies", building: id, figure: anoms.length && anoms[0].a.difference_pct !== null ? { value: Math.abs(anoms[0].a.difference_pct!), label: "largest flagged difference %" } : undefined },
      tags: ["anomalies", i % 3 ? "paraphrase" : "canonical"],
    });
    const peerMeter = (Object.entries(b.meters).find(([, md]) => md?.peers.available)?.[0] as MeterName | undefined) ?? null;
    cases.push({
      id: `${id}-compare`, question: i % 2 ? `Is building ${id} efficient compared to its peers?` : `How does building ${id} compare with similar buildings?`, context: null,
      expect: { intent: "compare", building: id, figure: peerMeter ? { value: b.meters[peerMeter]!.peers.peer_median!, label: `${peerMeter} peer median` } : undefined },
      tags: ["compare"],
    });
    cases.push({
      id: `${id}-improve`, question: `What improvements should I consider for building ${id}?`, context: null,
      expect: { intent: "improvements", building: id, missingAck: true }, tags: ["improvements", "missing-info"],
    });
    cases.push({
      id: `${id}-savings`, question: i % 2 ? "Would replacing the heating system save money?" : "How much would we save by switching to LED lighting?", context: id,
      expect: { intent: "improvements", building: id, missingAck: true }, tags: ["savings", "missing-info", "context"],
    });
    const month = (i % 12) + 1;
    const mrow = m.monthly[month - 1];
    cases.push({
      id: `${id}-period`, question: `What was the ${METER_LABEL[main].toLowerCase()} use of building ${id} in ${MONTHS[month - 1]}?`, context: null,
      expect: {
        intent: "period", building: id, meter: main,
        period: { start: `2016-${String(month).padStart(2, "0")}-01`, end: new Date(Date.UTC(2016, month, 0)).toISOString().slice(0, 10) },
        figure: mrow?.actual !== null && (mrow?.coverage_pct ?? 0) >= 99 ? { value: mrow.actual!, label: `${MONTHS[month - 1]} total` } : undefined,
      },
      tags: ["period", "meter"],
    });
    cases.push({
      id: `${id}-context`, question: "And how does it compare with similar buildings?", context: id,
      expect: { intent: "compare", building: id }, tags: ["context"],
    });
    if (i === 0) {
      cases.push({ id: `${id}-report`, question: `Prepare a report for an energy adviser on building ${id}.`, context: null, expect: { intent: "report", building: id }, tags: ["report"] });
      cases.push({ id: "unknown-building", question: "Summarise building 9999.", context: null, expect: { intent: "help", building: null, unknownBuilding: "9999", missingAck: true }, tags: ["robustness", "missing-info"] });
      cases.push({ id: `${id}-oor`, question: `How much electricity did building ${id} use in 2018?`, context: null, expect: { intent: "summary", building: id, missingAck: true }, tags: ["robustness", "missing-info"] });
      cases.push({ id: `${id}-summer`, question: `Any unusual spikes in building ${id} during summer?`, context: null, expect: { intent: "anomalies", building: id, period: { start: "2016-06-01", end: "2016-08-31" } }, tags: ["anomalies", "period"] });
    }
  });
  return cases;
}

export function scoreCase(c: EvalCase, plan: AnswerPlan, answer: string, answerSource: string): CaseResult {
  const p = plan.parsed;
  const verification = verifyAnswer(answer, plan.approvedNumbers, plan.evidence.map((e) => e.id), plan.requiresMissingAck || !!c.expect.missingAck);
  const intentOk = p.intent === c.expect.intent;
  const buildingOk = (p.buildingId ?? null) === c.expect.building && (!c.expect.unknownBuilding || p.unknownBuilding === c.expect.unknownBuilding);
  const period = c.expect.period
    ? { expected: `${c.expect.period.start}..${c.expect.period.end}`, got: p.period ? `${p.period.start}..${p.period.end}` : null, ok: !!p.period && p.period.start === c.expect.period.start && p.period.end === c.expect.period.end }
    : null;
  const meter = c.expect.meter ? { expected: c.expect.meter, got: p.meter, ok: p.meter === c.expect.meter } : null;
  let figure: CaseResult["figure"] = null;
  if (c.expect.figure) {
    const found = extractNumbers(answer).some((n) => numberSupported(n, [c.expect.figure!.value]) && Math.abs(n.value) > 1);
    figure = { expected: `${c.expect.figure.label}: ${c.expect.figure.value}`, ok: found };
  }
  const pass = intentOk && buildingOk && (period?.ok ?? true) && (meter?.ok ?? true) && (figure?.ok ?? true) && verification.pass;
  return {
    id: c.id, question: c.question, tags: c.tags,
    intent: { expected: c.expect.intent, got: p.intent, ok: intentOk },
    building: { expected: c.expect.building, got: p.buildingId, ok: buildingOk },
    period, meter, figure, verification, pass, answerSource, answer,
  };
}

export function summarise(results: CaseResult[]) {
  const rate = (xs: boolean[]) => (xs.length ? Math.round((1000 * xs.filter(Boolean).length) / xs.length) / 10 : null);
  const nums = results.reduce((a, r) => a + r.verification.numbersChecked, 0);
  const sup = results.reduce((a, r) => a + r.verification.numbersSupported, 0);
  return {
    cases: results.length,
    pass_rate: rate(results.map((r) => r.pass)),
    intent_accuracy: rate(results.map((r) => r.intent.ok)),
    building_accuracy: rate(results.map((r) => r.building.ok)),
    period_accuracy: rate(results.filter((r) => r.period).map((r) => r.period!.ok)),
    meter_accuracy: rate(results.filter((r) => r.meter).map((r) => r.meter!.ok)),
    figure_reproduction: rate(results.filter((r) => r.figure).map((r) => r.figure!.ok)),
    numeric_faithfulness: nums ? Math.round((1000 * sup) / nums) / 10 : null,
    numbers_checked: nums,
    citation_validity: rate(results.map((r) => r.verification.invalidCitations.length === 0)),
    citation_coverage: rate(results.filter((r) => r.verification.citationCoverage !== null).map((r) => (r.verification.citationCoverage ?? 0) >= 0.8)),
    missing_info_acknowledged: rate(results.filter((r) => r.verification.missingRequired).map((r) => !!r.verification.mentionsMissing)),
  };
}

/** Deterministic run: routing + tools + template answers (no language model). */
export function runTemplateEval(maxBuildings = 8) {
  const cases = buildCases(maxBuildings);
  const results = cases.map((c) => {
    const plan = planAnswer(c.question, c.context);
    return scoreCase(c, plan, plan.template, "template");
  });
  return { generated_at: new Date().toISOString(), mode: "template", synthetic: DATA.meta.synthetic, summary: summarise(results), results };
}
