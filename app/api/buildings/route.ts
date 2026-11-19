// GET /api/buildings           -> list of demo buildings + dataset metadata
// GET /api/buildings?id=12     -> full evidence record for one building (charts, tables)
import { DATA, buildingList, getBuilding } from "../../../lib/data";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const b = getBuilding(id);
    if (!b) return Response.json({ error: `Building ${id} is not in the evidence file` }, { status: 404 });
    return Response.json(b);
  }
  return Response.json({
    meta: {
      dataset: DATA.meta.dataset,
      synthetic: DATA.meta.synthetic,
      generated_at: DATA.meta.generated_at,
      pipeline_version: DATA.meta.pipeline_version,
      period: DATA.meta.period,
      n_buildings_in_dataset: DATA.meta.n_buildings_in_dataset,
      methods: DATA.meta.methods,
    },
    buildings: buildingList(),
  });
}
