// POST /api/chat — routes the question, runs the analysis tools and streams NDJSON:
//   {"type":"plan", ...}            evidence pack, template answer, focus for the charts
//   {"type":"token","text":"..."}  only in server-LLM mode
//   {"type":"final", ...}          answer, its source and the verification result
import { planAnswer } from "../../../lib/chat";
import { llmConfig, streamChat, stripThinking } from "../../../lib/llm";
import { verifyAnswer } from "../../../lib/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Mode = "template" | "server" | "browser";

export async function POST(req: Request) {
  let body: { message?: string; buildingId?: string | null; mode?: Mode };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const message = String(body.message ?? "").slice(0, 1000).trim();
  if (!message) return Response.json({ error: "Empty message" }, { status: 400 });
  const plan = planAnswer(message, body.buildingId ?? null);
  const cfg = llmConfig();
  const mode: Mode = body.mode === "server" && cfg.enabled ? "server" : body.mode === "browser" ? "browser" : "template";
  const ids = plan.evidence.map((e) => e.id);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      send({
        type: "plan",
        plan: { ...plan, messages: undefined, browserMessages: mode === "browser" ? plan.browserMessages : undefined },
        mode,
        serverLlm: { enabled: cfg.enabled, model: cfg.enabled ? cfg.model : null },
        requestedMode: body.mode ?? "template",
      });
      if (mode === "server") {
        let text = "";
        try {
          for await (const t of streamChat(plan.messages)) {
            text += t;
            send({ type: "token", text: t });
          }
          const answer = stripThinking(text);
          const verification = verifyAnswer(answer, plan.approvedNumbers, ids, plan.requiresMissingAck);
          send({ type: "final", answer, source: `llm:${cfg.model}`, verification, fallback: plan.template });
        } catch (err) {
          const verification = verifyAnswer(plan.template, plan.approvedNumbers, ids, plan.requiresMissingAck);
          send({ type: "final", answer: plan.template, source: "template", verification, error: `Language model unavailable (${(err as Error).message.slice(0, 160)}); showing the approved template answer.` });
        }
      } else {
        const verification = verifyAnswer(plan.template, plan.approvedNumbers, ids, plan.requiresMissingAck);
        send({ type: "final", answer: plan.template, source: "template", verification, pendingBrowser: mode === "browser" });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
