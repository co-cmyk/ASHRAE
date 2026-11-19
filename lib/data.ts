// Loads the evidence file and the verified guidance collection.
// Both are imported statically so they are bundled into the serverless function on Vercel.
import rawData from "../data/assistant_data.json";
import rawGuidance from "../data/guidance.json";
import type { AssistantData, BuildingData, GuidanceCard, MeterName } from "./types";

export const DATA = rawData as unknown as AssistantData;
export const GUIDANCE = (rawGuidance as unknown as { cards: GuidanceCard[] }).cards;

export function getBuilding(id: string | null | undefined): BuildingData | null {
  if (!id) return null;
  return DATA.buildings[String(Number(id))] ?? null;
}

export function buildingIds(): string[] {
  return Object.keys(DATA.buildings).sort((a, b) => Number(a) - Number(b));
}

export function buildingList() {
  return buildingIds().map((id) => {
    const b = DATA.buildings[id];
    const e = b.meters.electricity;
    return {
      id,
      primary_use: b.profile.primary_use,
      site_id: b.profile.site_id,
      floor_area_m2: b.profile.floor_area_m2,
      year_built: b.profile.year_built,
      meters: Object.keys(b.meters) as MeterName[],
      anomalies: Object.values(b.meters).reduce((n, m) => n + (m?.anomalies.length ?? 0), 0),
      coverage_pct: e?.stats.coverage_pct ?? null,
    };
  });
}
