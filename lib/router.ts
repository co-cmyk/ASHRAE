// Deterministic question router: intent, building, meter, period.
// A 2B model is not reliable at tool selection, so routing is rule-based, transparent and testable
// (see lib/eval.ts). The language model is only used to explain the evidence the tools return.
import { DATA } from "./data";
import type { Intent, MeterName, ParsedQuestion, Period } from "./types";

const INTENT_PATTERNS: Record<Exclude<Intent, "period" | "help">, [RegExp, number][]> = {
  report: [
    [/\breport\b/, 3],
    [/\badvis[eo]r\b/, 2],
    [/\bconsultation\b/, 2],
    [/\bbrief(ing)?\b/, 1],
    [/\bwrite[- ]?up\b/, 2],
    [/\bhand[- ]?over\b/, 1],
  ],
  anomalies: [
    [/\binvestigat/, 3],
    [/\bunusual\b/, 3],
    [/\banomal/, 3],
    [/\babnormal/, 3],
    [/\bspikes?\b/, 2],
    [/\boutliers?\b/, 2],
    [/\bodd\b|\bstrange\b|\bweird\b/, 2],
    [/\bflag(ged|s)?\b/, 2],
    [/\bwhich periods?\b|\bwhat periods?\b|\bwhen (was|did)\b/, 2],
    [/\bhigher than (expected|normal|usual)\b|\blower than (expected|normal|usual)\b/, 2],
    [/\bwaste|wasted\b/, 1],
  ],
  compare: [
    [/\bcompar/, 3],
    [/\bsimilar buildings?\b/, 3],
    [/\bpeers?\b/, 3],
    [/\bbenchmark/, 3],
    [/\brank(ing|s)?\b|\bpercentile\b/, 2],
    [/\bother buildings\b|\bvs\.?\b|\bversus\b/, 2],
    [/\befficient compared\b|\bhow efficient\b/, 2],
  ],
  improvements: [
    [/\bimprove(ment)?s?\b/, 3],
    [/\befficien(cy|t)\s+(measures?|options?|upgrades?)\b/, 3],
    [/\bmeasures?\b/, 2],
    [/\bretrofit/, 3],
    [/\bupgrade/, 2],
    [/\breplac(e|ing|ement)\b/, 2],
    [/\brecommend/, 2],
    [/\bsav(e|ing|ings)\b/, 2],
    [/\breduce\b|\bcut\b|\blower (my|the|our) (bill|use|consumption)\b/, 2],
    [/\bpayback\b|\broi\b/, 3],
    [/\bshould (i|we)\b.*\b(do|consider|install|change)\b/, 2],
    [/\bheat pump|\bboiler|\binsulat|\bled\b|\blighting\b|\bsolar\b|\bglazing\b|\bwindows?\b/, 1],
  ],
  data_quality: [
    [/\bdata quality\b/, 3],
    [/\bmissing (data|readings|values|hours)\b/, 3],
    [/\bgaps?\b/, 2],
    [/\bzero readings?\b|\bflat[- ]?lines?\b/, 3],
    [/\breliab(le|ility)\b|\btrust\b/, 1],
    [/\bcoverage\b/, 2],
  ],
  summary: [
    [/\bsummar/, 3],
    [/\boverview\b/, 3],
    [/\bprofile\b/, 2],
    [/\btell me about\b|\bdescribe\b/, 2],
    [/\benergy (use|usage|consumption)\b/, 1],
    [/\bhow much (energy|electricity)\b/, 1],
    [/\bconsum(e|es|ption)\b|\busage\b/, 1],
  ],
};

const PRIORITY: Intent[] = ["report", "anomalies", "compare", "improvements", "data_quality", "summary"];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = new RegExp(`\\b(${MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join("|")})\\b(?:\\s+(\\d{4}))?`, "i");

function lastDay(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function monthPeriod(year: number, m: number, label?: string): Period {
  return { start: `${year}-${String(m).padStart(2, "0")}-01`, end: lastDay(year, m), label: label ?? `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${year}` };
}

export function parsePeriod(text: string): Period | null {
  const t = text.toLowerCase();
  const dataYear = Number(DATA.meta.period.start.slice(0, 4));
  const yearMatch = t.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : dataYear;
  const out = (p: Period): Period => (year !== dataYear ? { ...p, outOfRange: true } : p);

  const isoRange = t.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|until|till|-|–|and|through)\s*(\d{4}-\d{2}-\d{2})/);
  if (isoRange) {
    const [a, b] = [isoRange[1], isoRange[2]].sort();
    const oor = a.slice(0, 4) !== String(dataYear) || b.slice(0, 4) !== String(dataYear);
    return { start: a, end: b, label: `${a} to ${b}`, ...(oor ? { outOfRange: true } : {}) };
  }
  const isoDay = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDay) {
    const d = isoDay[0];
    return { start: d, end: d, label: d, ...(Number(isoDay[1]) !== dataYear ? { outOfRange: true } : {}) };
  }
  const isoMonth = t.match(/\b(\d{4})-(\d{2})\b/);
  if (isoMonth) {
    const p = monthPeriod(Number(isoMonth[1]), Number(isoMonth[2]));
    return Number(isoMonth[1]) !== dataYear ? { ...p, outOfRange: true } : p;
  }
  const q = t.match(/\bq([1-4])\b|\b(first|second|third|fourth) quarter\b/);
  if (q) {
    const n = q[1] ? Number(q[1]) : ["first", "second", "third", "fourth"].indexOf(q[2]) + 1;
    return out({ start: `${year}-${String(3 * n - 2).padStart(2, "0")}-01`, end: lastDay(year, 3 * n), label: `Q${n} ${year}` });
  }
  if (/\bfirst half\b|\bh1\b/.test(t)) return out({ start: `${year}-01-01`, end: `${year}-06-30`, label: `First half of ${year}` });
  if (/\bsecond half\b|\bh2\b/.test(t)) return out({ start: `${year}-07-01`, end: `${year}-12-31`, label: `Second half of ${year}` });
  if (/\bsummer\b/.test(t)) return out({ start: `${year}-06-01`, end: `${year}-08-31`, label: `Summer (Jun–Aug) ${year}` });
  if (/\bwinter\b/.test(t)) return out({ start: `${year}-01-01`, end: lastDay(year, 2), label: `Winter (Jan–Feb) ${year}` });
  if (/\bspring\b/.test(t)) return out({ start: `${year}-03-01`, end: `${year}-05-31`, label: `Spring (Mar–May) ${year}` });
  if (/\bautumn\b|\bfall\b/.test(t)) return out({ start: `${year}-09-01`, end: `${year}-11-30`, label: `Autumn (Sep–Nov) ${year}` });
  const m = text.match(MONTH_RE);
  if (m) {
    const word = m[1].toLowerCase();
    // "may" is also a verb: only treat it as a month when followed by a year or preceded by in/during/of
    if (word === "may" && !m[2] && !/\b(in|during|of|for|throughout)\s+may\b/i.test(text)) return null;
    const idx = MONTHS.findIndex((x) => x === word || x.slice(0, 3) === word);
    const y = m[2] ? Number(m[2]) : year;
    const p = monthPeriod(y, idx + 1);
    return y !== dataYear ? { ...p, outOfRange: true } : p;
  }
  if (yearMatch && year !== dataYear) return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year), outOfRange: true };
  return null;
}

export function parseMeter(text: string): { meter: MeterName | null; requested: string | null } {
  const t = text.toLowerCase();
  if (/\bchilled[- ]?water\b|\bcooling\b|\bchiller/.test(t)) return { meter: "chilledwater", requested: "chilled water" };
  if (/\bsteam\b/.test(t)) return { meter: "steam", requested: "steam" };
  if (/\bhot[- ]?water\b/.test(t)) return { meter: "hotwater", requested: "hot water" };
  if (/\bheating\b|\bboiler\b|\bheat pump\b/.test(t)) return { meter: null, requested: "heating" };
  if (/\belectric(ity|al)?\b|\bpower\b|\bkwh\b|\blighting\b|\bplug\b/.test(t)) return { meter: "electricity", requested: "electricity" };
  return { meter: null, requested: null };
}

export function parseBuilding(text: string): string | null {
  const m =
    text.match(/\b(?:building|bldg\.?|buildings?\s+id|id)\s*(?:no\.?|number|#)?\s*#?\s*(\d{1,5})\b/i) ||
    text.match(/(?:^|\s)#(\d{1,5})\b/);
  return m ? String(Number(m[1])) : null;
}

export function detectSystem(text: string): string | null {
  const t = text.toLowerCase();
  const systems: [RegExp, string][] = [
    [/\bheat(ing)? system\b|\bboiler\b|\bheating\b|\bfurnace\b/, "heating system"],
    [/\bheat pump\b/, "heat pump"],
    [/\bchiller\b|\bcooling system\b|\bair[- ]?con/, "cooling system"],
    [/\bled\b|\blighting\b|\blights\b/, "lighting"],
    [/\binsulat/, "insulation"],
    [/\bwindows?\b|\bglazing\b/, "windows/glazing"],
    [/\bsolar\b|\bpv\b|\bphotovoltaic/, "solar PV"],
    [/\bhvac\b|\bventilation\b|\bfans?\b|\bair handling/, "HVAC/ventilation"],
    [/\bcontrols?\b|\bbms\b|\bbas\b|\bthermostat/, "controls"],
  ];
  for (const [re, name] of systems) if (re.test(t)) return name;
  return null;
}

export function parseQuestion(message: string, contextBuildingId: string | null): ParsedQuestion {
  const t = message.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [intent, pats] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = pats.reduce((s, [re, w]) => s + (re.test(t) ? w : 0), 0);
  }
  const period = parsePeriod(message);
  const { meter, requested } = parseMeter(message);
  const savingsQuestion =
    /\b(would|will|could|does|do|how much|what)\b[^?.!]{0,60}\b(save|saving|savings|pay back|payback|cut (the|my|our)? ?bills?|reduce (the|my|our)? ?(bill|cost))/.test(t) ||
    /\b(payback|return on investment|roi|cost[- ]effective|worth (it|replacing|upgrading))\b/.test(t);
  if (savingsQuestion) scores.improvements = (scores.improvements ?? 0) + 3;

  let intent: Intent = "help";
  let best = 0;
  for (const i of PRIORITY) {
    if ((scores[i] ?? 0) > best) {
      best = scores[i];
      intent = i;
    }
  }
  if (best === 0 && period) intent = "period";
  else if (period && intent === "summary" && (scores.summary ?? 0) <= 1) intent = "period";
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = best === 0 ? (period ? 0.6 : 0) : Math.min(1, best / Math.max(total, 1) + 0.15);

  const mentioned = parseBuilding(message);
  let buildingId: string | null = null;
  let buildingSource: ParsedQuestion["buildingSource"] = "none";
  let unknownBuilding: string | null = null;
  if (mentioned) {
    if (DATA.buildings[mentioned]) {
      buildingId = mentioned;
      buildingSource = "message";
    } else {
      unknownBuilding = mentioned;
    }
  }
  if (!buildingId && !unknownBuilding && contextBuildingId && DATA.buildings[String(Number(contextBuildingId))]) {
    buildingId = String(Number(contextBuildingId));
    buildingSource = "context";
  }
  if (intent === "help" && buildingId && /\b(it|this building|the building)\b/.test(t) === false && t.trim().split(/\s+/).length <= 3) {
    intent = "summary";
  }
  return {
    intent,
    confidence: Math.round(confidence * 100) / 100,
    scores,
    buildingId,
    buildingSource,
    unknownBuilding,
    meter,
    meterRequested: requested,
    period,
    savingsQuestion,
    system: detectSystem(message),
  };
}
