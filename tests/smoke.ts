// Quick smoke test: run the pipeline on sample questions and verify the template answers.
import { planAnswer } from "../lib/chat";
import { verifyAnswer } from "../lib/verify";

const qs: [string, string | null][] = [
  ["Summarise building 3's energy use.", null],
  ["Which periods need investigating?", "3"],
  ["How does it compare with similar buildings?", "26"],
  ["What improvements should I consider?", "22"],
  ["Would replacing the heating system save money?", "19"],
  ["What was the electricity use of building 11 in March?", null],
  ["Any unusual spikes in building 19 during spring?", null],
  ["Prepare a report for an energy adviser on building 6.", null],
  ["Summarise building 9999", null],
  ["How much did it use in 2018?", "3"],
  ["hello", null],
];
let failures = 0;
for (const [q, ctx] of qs) {
  const plan = planAnswer(q, ctx);
  const v = verifyAnswer(plan.template, plan.approvedNumbers, plan.evidence.map((e) => e.id), plan.requiresMissingAck);
  if (!v.pass) failures++;
  console.log("\n=== Q:", q, "| ctx:", ctx, "| intent:", plan.parsed.intent, "| bldg:", plan.parsed.buildingId, plan.parsed.buildingSource,
    "| period:", plan.parsed.period?.label ?? "-", "| meter:", plan.parsed.meter, "| evidence:", plan.evidence.map((e) => e.id).join(","),
    "| verify:", v.pass ? "PASS" : "FAIL " + v.issues.join("; "));
  if (process.argv.includes("-v")) console.log(plan.template);
}
console.log(`\n${qs.length - failures}/${qs.length} template answers pass verification`);
if (failures) process.exit(1);
