// Orchestrator: question -> route -> tools -> evidence pack -> template answer + LLM prompt.
import { DATA, buildingIds, getBuilding } from "./data";
import { METER_LABEL } from "./format";
import { parseQuestion } from "./router";
import { Ctx, profileEvidence, anomalyTool, compareTool, dataQualityTool, improvementTool, periodTool, summaryTool } from "./tools";
import { approvedFromTexts } from "./verify";
import type { AnswerPlan, Focus, Intent } from "./types";

const HEADINGS: Record<Intent, string> = {
  summary: "Energy use summary",
  anomalies: "Periods that need investigating",
  compare: "Comparison with similar buildings",
  improvements: "Improvements to consider",
  report: "Report for an energy adviser",
  data_quality: "Data quality",
  period: "Consumption for the requested period",
  help: "What I can do",
};

const FOLLOW_UPS: Record<Intent, string[]> = {
  summary: ["Which periods need investigating?", "How does it compare with similar buildings?", "What improvements should I consider?"],
  anomalies: ["How does it compare with similar buildings?", "What improvements should I consider?", "Prepare a report for an energy adviser."],
  compare: ["Which periods need investigating?", "What improvements should I consider?", "Summarise this building's energy use."],
  improvements: ["Would replacing the heating system save money?", "Which periods need investigating?", "Prepare a report for an energy adviser."],
  report: ["Which periods need investigating?", "What improvements should I consider?"],
  data_quality: ["Summarise this building's energy use.", "Which periods need investigating?"],
  period: ["Which periods need investigating?", "Summarise this building's energy use."],
  help: ["Summarise this building's energy use.", "Which periods need investigating?", "How does it compare with similar buildings?"],
};

export const SYSTEM_PROMPT = `You are the Building Energy Evidence Assistant. You explain pre-computed analysis of metered building energy data to a building manager or energy adviser.
Rules:
1. Use ONLY the facts in EVIDENCE and KEY POINTS. Do not calculate, estimate or invent numbers. Copy figures exactly as written.
2. End every sentence that uses a fact with its evidence ID in square brackets, e.g. [E2] or [G1].
3. Never state the cause of a pattern as fact. Offer possible explanations only as questions to investigate.
4. If MISSING INFORMATION is listed, say clearly what cannot be determined yet and ask the user for those details.
5. Mention uncertainty (data coverage, baseline fit, peer-group limits) when the evidence gives it.
6. Answer the QUESTION directly in at most 170 words: a short opening sentence, then bullet points. Plain English, no headings.`;

function renderTemplate(plan: Omit<AnswerPlan, "template" | "messages" | "approvedNumbers">): string {
  const lines: string[] = [`**${plan.heading}**`, ""];
  for (const k of plan.keyPoints) lines.push(`- ${k.text}${k.cites.length ? ` [${k.cites.join(", ")}]` : ""}`);
  if (plan.investigate.length) {
    lines.push("", "**Questions to investigate**");
    for (const q of plan.investigate.slice(0, 5)) lines.push(`- ${q}`);
  }
  if (plan.missing.length) {
    lines.push("", plan.requiresMissingAck ? "**I need these details before I can go further**" : "**Not in the dataset (please provide if you can)**");
    for (const m of plan.missing.slice(0, 6)) lines.push(`- ${m.text} — ${m.why}`);
  }
  return lines.join("\n");
}

function buildMessages(plan: Omit<AnswerPlan, "template" | "messages" | "approvedNumbers">) {
  const ev = plan.evidence.map((e) => `[${e.id}] ${e.summary}`).join("\n");
  const kp = plan.keyPoints.map((k) => `- ${k.text}${k.cites.length ? ` [${k.cites.join(", ")}]` : ""}`).join("\n");
  const miss = plan.missing.map((m) => `- ${m.text} (${m.why})`).join("\n");
  const inv = plan.investigate.slice(0, 5).map((q) => `- ${q}`).join("\n");
  const user = [
    `QUESTION: ${plan.question}`,
    "",
    "EVIDENCE:",
    ev || "(none)",
    "",
    "KEY POINTS (already verified):",
    kp || "(none)",
    ...(inv ? ["", "QUESTIONS TO INVESTIGATE:", inv] : []),
    ...(miss ? ["", `MISSING INFORMATION${plan.requiresMissingAck ? " (you must ask for it)" : ""}:`, miss] : []),
    "",
    "Write the answer now, following the rules.",
  ].join("\n");
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: user },
  ];
}

export function planAnswer(question: string, contextBuildingId: string | null, opts: { forReport?: boolean } = {}): AnswerPlan {
  const parsed = parseQuestion(question, contextBuildingId);
  const b = getBuilding(parsed.buildingId);
  const ctx = new Ctx(b, parsed, question);
  let intent = parsed.intent;

  if (parsed.unknownBuilding) {
    ctx.point(`Building ${parsed.unknownBuilding} is not in this demo set. Available buildings: ${buildingIds().join(", ")}.`);
    ctx.need("A building from the demo set", `The evidence file contains ${buildingIds().length} of the ${DATA.meta.n_buildings_in_dataset} ASHRAE buildings; re-run notebook 02 with BUILDING_IDS to add others.`);
    intent = "help";
  } else if (!b) {
    ctx.point("Choose a building on the left (or name one, e.g. 'building 12'), then ask about its energy use, unusual periods, peers, improvements, or request a report.");
    ctx.need("Which building you mean", "Every answer is tied to one building's records.");
    intent = "help";
  } else {
    profileEvidence(ctx); // E1 is always the building profile
  }
  if (!b || parsed.unknownBuilding) {
    // nothing more to do
  } else if (parsed.period?.outOfRange) {
    ctx.point(`The dataset covers ${DATA.meta.period.start} to ${DATA.meta.period.end} only, so I have no readings for ${parsed.period.label}.`);
    ctx.need(`Meter readings for ${parsed.period.label}`, "Not part of the ASHRAE training data used by this assistant.");
    summaryTool(ctx);
    intent = "summary";
  } else {
    switch (intent) {
      case "summary":
        summaryTool(ctx);
        break;
      case "anomalies":
        anomalyTool(ctx);
        break;
      case "compare":
        compareTool(ctx);
        break;
      case "improvements":
        improvementTool(ctx);
        break;
      case "data_quality":
        dataQualityTool(ctx);
        break;
      case "period":
        periodTool(ctx);
        break;
      case "report": {
        summaryTool(ctx);
        anomalyTool(ctx);
        compareTool(ctx);
        improvementTool(ctx);
        ctx.keyPoints = ctx.keyPoints.slice(0, 10);
        if (!opts.forReport) ctx.point("The full structured report (profile, analysis, evidence, uncertainty and outstanding questions) is ready to download from the report panel.");
        break;
      }
      case "help":
      default:
        summaryTool(ctx);
        intent = "summary";
    }
  }

  const requiresMissingAck = intent === "improvements" || (!!parsed.unknownBuilding) || !b || !!parsed.period?.outOfRange;
  const meterFocus = parsed.meter && b?.meters[parsed.meter] ? parsed.meter : b ? (b.meters.electricity ? "electricity" : (Object.keys(b.meters)[0] as Focus["meter"])) : null;
  const anomalyIds = ctx.evidence.filter((e) => e.kind === "anomaly" && e.anomalyId).map((e) => e.anomalyId!);
  const anomalyMeter = ctx.evidence.find((e) => e.kind === "anomaly")?.meter ?? null;
  const focus: Focus = {
    meter: intent === "anomalies" && anomalyMeter ? anomalyMeter : meterFocus,
    period: parsed.period && !parsed.period.outOfRange ? parsed.period : null,
    anomalyIds,
    chart: intent === "compare" ? "peers" : intent === "period" ? "daily" : intent === "summary" ? "monthly" : "daily",
  };

  const base = {
    question,
    parsed: { ...parsed, intent },
    heading: b ? `${HEADINGS[intent]} — building ${b.profile.building_id}${focus.meter && parsed.meter ? ` (${METER_LABEL[focus.meter].toLowerCase()})` : ""}` : HEADINGS[intent],
    evidence: ctx.evidence,
    keyPoints: ctx.keyPoints,
    investigate: ctx.investigate,
    missing: ctx.missing,
    requiresMissingAck,
    followUps: FOLLOW_UPS[intent],
    focus,
    dataSynthetic: DATA.meta.synthetic,
  };
  const template = renderTemplate(base);
  const approvedNumbers = approvedFromTexts([
    ...ctx.evidence.flatMap((e) => [e.summary, e.title, ...e.rows.map((r) => `${r[0]} ${r[1]}`)]),
    ...ctx.keyPoints.map((k) => k.text),
    ...ctx.missing.map((m) => `${m.text} ${m.why}`),
    ...ctx.investigate,
    base.heading,
    question,
  ]);
  return { ...base, template, messages: buildMessages(base), approvedNumbers };
}
