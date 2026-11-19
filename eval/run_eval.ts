// Evaluate the assistant end-to-end.
//   npm run eval                       -> template answers (deterministic baseline)
//   npm run eval -- --llm              -> answers written by the LLM at LLM_BASE_URL (e.g. Qwen3.5-2B)
//   npm run eval -- --llm --buildings 4 --out data/llm_eval_results.json
// The LLM run writes data/llm_eval_results.json, which the /evaluation page displays.
import { writeFileSync } from "node:fs";
import { planAnswer } from "../lib/chat";
import { buildCases, scoreCase, summarise, type CaseResult } from "../lib/eval";
import { completeChat, llmConfig } from "../lib/llm";

const args = process.argv.slice(2);
const val = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const useLlm = args.includes("--llm");
const maxBuildings = Number(val("--buildings") ?? (useLlm ? 4 : 12));
const out = val("--out") ?? (useLlm ? "data/llm_eval_results.json" : "eval/template_eval_results.json");

async function main() {
  const cfg = llmConfig();
  if (useLlm && !cfg.enabled) {
    console.error("Set LLM_BASE_URL (and LLM_MODEL / LLM_API_KEY) to evaluate a language model.");
    process.exit(1);
  }
  const cases = buildCases(maxBuildings);
  const results: CaseResult[] = [];
  const templateResults: CaseResult[] = [];
  const t0 = Date.now();
  for (const [i, c] of cases.entries()) {
    const plan = planAnswer(c.question, c.context);
    templateResults.push(scoreCase(c, plan, plan.template, "template"));
    if (!useLlm) continue;
    let answer = "";
    let source = `llm:${cfg.model}`;
    const s = Date.now();
    try {
      answer = await completeChat(plan.messages);
    } catch (e) {
      answer = "";
      source = `error:${(e as Error).message.slice(0, 80)}`;
    }
    const r = scoreCase(c, plan, answer, source);
    results.push(r);
    console.log(`[${i + 1}/${cases.length}] ${r.pass ? "PASS" : "FAIL"} ${c.id} (${((Date.now() - s) / 1000).toFixed(1)}s) ${r.verification.issues.join("; ")}`);
  }
  const templateSummary = summarise(templateResults);
  console.log("\nTemplate (deterministic) answers:");
  console.table(templateSummary);
  if (useLlm) {
    const llmSummary = summarise(results);
    console.log(`\nLanguage model answers (${cfg.model}):`);
    console.table(llmSummary);
    writeFileSync(out, JSON.stringify({
      available: true, model: cfg.model, endpoint: cfg.base.replace(/\/\/([^/@]+)@/, "//***@"), generated_at: new Date().toISOString(),
      seconds: Math.round((Date.now() - t0) / 1000), summary: llmSummary, template_summary: templateSummary,
      results: results.map((r) => ({ ...r, answer: r.answer.slice(0, 2000) })),
    }, null, 1));
  } else {
    writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), summary: templateSummary, results: templateResults }, null, 1));
  }
  console.log(`\nWrote ${out}`);
}
main();
