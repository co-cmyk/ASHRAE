// GET /api/eval -> runs the deterministic evaluation suite (routing, tools, template answers).
import { runTemplateEval } from "../../../lib/eval";
import llmResults from "../../../data/llm_eval_results.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = Date.now();
  const template = runTemplateEval(12);
  return Response.json({ template, llm: llmResults, ms: Date.now() - t0 });
}
