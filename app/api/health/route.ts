import { DATA } from "../../../lib/data";
import { llmConfig } from "../../../lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const c = llmConfig();
  return Response.json({
    ok: true,
    serverLlm: { enabled: c.enabled, model: c.enabled ? c.model : null },
    data: { synthetic: DATA.meta.synthetic, buildings: Object.keys(DATA.buildings).length, generated_at: DATA.meta.generated_at },
  });
}
