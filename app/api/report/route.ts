// POST /api/report {buildingId, mode} -> structured report (markdown) with an executive summary.
// In server mode the summary is written by the LLM and kept only if it passes verification.
import { buildReport, reportMarkdown } from "../../../lib/report";
import { completeChat, llmConfig } from "../../../lib/llm";
import { verifyAnswer } from "../../../lib/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { buildingId?: string; mode?: string; summary?: string; summarySource?: string };
  const r = buildReport(String(body.buildingId ?? ""));
  if (!r) return Response.json({ error: "Unknown building" }, { status: 404 });
  const plan = r.summaryPlan;
  const ids = plan.evidence.map((e) => e.id);
  let summary = plan.template.replace(/^\*\*[^\n]*\*\*\n\n/, "");
  let source = "approved template (no language model)";
  let verification = verifyAnswer(summary, plan.approvedNumbers, ids, plan.requiresMissingAck);
  let note: string | null = null;
  const cfg = llmConfig();
  if (body.summary) {
    // summary written in the browser (WebGPU) — verify it here before using it
    const v = verifyAnswer(body.summary, plan.approvedNumbers, ids, plan.requiresMissingAck);
    if (v.pass) {
      summary = body.summary;
      source = body.summarySource ?? "in-browser language model";
      verification = v;
    } else note = `The in-browser summary failed verification (${v.issues.join("; ")}); the approved template was used.`;
  } else if (body.mode === "server" && cfg.enabled) {
    try {
      const text = await completeChat(plan.messages);
      const v = verifyAnswer(text, plan.approvedNumbers, ids, plan.requiresMissingAck);
      if (v.pass) {
        summary = text;
        source = `${cfg.model} (verified)`;
        verification = v;
      } else note = `The language-model summary failed verification (${v.issues.join("; ")}); the approved template was used.`;
    } catch (err) {
      note = `Language model unavailable (${(err as Error).message.slice(0, 120)}); the approved template was used.`;
    }
  }
  return Response.json({
    title: r.title,
    buildingId: r.buildingId,
    markdown: reportMarkdown(r, summary, source),
    summarySource: source,
    verification,
    note,
    browserMessages: plan.browserMessages,
  });
}
