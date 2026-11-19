// Retrieval over the small verified guidance collection.
// Transparent scoring: signals from the building's own analysis (triggers) count most,
// then words from the question, then whether the card applies to the meter.
import { GUIDANCE } from "./data";
import type { GuidanceCard, MeterName } from "./types";

export interface ScoredCard {
  card: GuidanceCard;
  score: number;
  matchedTriggers: string[];
  matchedKeywords: string[];
}

export function retrieveGuidance(question: string, signals: string[], meter: MeterName | null, k = 4): ScoredCard[] {
  const q = question.toLowerCase();
  const scored = GUIDANCE.map((card) => {
    const matchedTriggers = card.triggers.filter((t) => signals.includes(t));
    const matchedKeywords = card.keywords.filter((w) => q.includes(w.toLowerCase()));
    let score = 3 * matchedTriggers.length + 1.5 * matchedKeywords.length;
    if (meter && card.meters.includes(meter)) score += 0.5;
    return { card, score, matchedTriggers, matchedKeywords };
  });
  return scored
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id))
    .slice(0, k);
}
