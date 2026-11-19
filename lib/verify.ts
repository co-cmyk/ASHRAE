// Answer verification: every number in an answer must come from the evidence pack,
// every citation must point at an evidence item, and when information is missing the
// answer must say so. Used live (badge in the UI) and by the evaluation suite.
import type { Verification } from "./types";

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

/** Remove tokens whose digits are not quantities: citations, dates, times, units with digits, list markers. */
export function stripNonQuantities(text: string): string {
  return text
    .replace(/\[(?:[EGM]\d+(?:\s*,\s*)?)+\]/g, " ")              // citations [E1], [E1, G2]
    .replace(/\b[EGM]\d+\b/g, " ")                                 // bare evidence ids
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b/g, " ") // ISO dates/datetimes
    .replace(/\b\d{4}-\d{2}\b/g, " ")                              // ISO months
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?(?:\\s+\\d{4})?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{4}\\b`, "gi"), " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")                            // times
    .replace(/\b(?:m2|m²|ft2|ft²|co2|co₂|g14|q[1-4]|h1|h2|24h|24-hour|pm2\.5)\b/gi, " ")
    .replace(/\bguideline\s+14\b/gi, " ")
    .replace(/\bqwen[\d.]*-?\d*b?\b/gi, " ")
    .replace(/^\s*\d+[.)]\s+/gm, " ")                               // numbered list markers
    .replace(/\b\d+(?:st|nd|rd|th)\b/g, (m) => m.replace(/(st|nd|rd|th)$/, ""));  // ordinals -> number
}

export interface FoundNumber {
  raw: string;
  value: number;
  decimals: number;
  scale: number;
}

export function extractNumbers(text: string): FoundNumber[] {
  const clean = stripNonQuantities(text);
  const re = /(?<![\w.])([-−+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-−+]?\d+(?:\.\d+)?)(\s*(?:million|m\b|thousand|k\b|bn|billion))?/gi;
  const out: FoundNumber[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const raw = m[1];
    const v = Number(raw.replace(/,/g, "").replace("−", "-"));
    if (!Number.isFinite(v)) continue;
    const suffix = (m[2] || "").trim().toLowerCase();
    const scale = suffix.startsWith("m") ? 1e6 : suffix.startsWith("b") ? 1e9 : suffix.startsWith("k") || suffix.startsWith("t") ? 1e3 : 1;
    const dec = raw.includes(".") ? raw.split(".")[1].length : 0;
    out.push({ raw: raw + (suffix ? ` ${suffix}` : ""), value: v * scale, decimals: dec, scale });
  }
  return out;
}

/** Numbers that are always allowed (data year, Guideline 14 thresholds are in evidence anyway). */
const ALWAYS_OK = new Set([0, 1, 2016]);

export function numberSupported(n: FoundNumber, approved: number[]): boolean {
  const v = n.value;
  if (ALWAYS_OK.has(Math.abs(v))) return true;
  const tolRound = 0.5 * Math.pow(10, -n.decimals) * n.scale + 1e-9;
  for (const a of approved) {
    for (const cand of [a, Math.abs(a)]) {
      const diff = Math.abs(Math.abs(v) - Math.abs(cand));
      if (diff <= tolRound) return true;
      if (cand !== 0 && diff / Math.abs(cand) <= 0.005) return true;
    }
  }
  return false;
}

export function approvedFromTexts(texts: string[]): number[] {
  const set = new Set<number>();
  for (const t of texts) for (const n of extractNumbers(t)) set.add(n.value);
  return [...set];
}

const MISSING_ACK = /\b(need|needs|needed|provide|share|send|missing|not (?:in|available|included|recorded|known)|isn't (?:in|available)|doesn't (?:include|contain|have)|does not (?:include|contain|have)|don't have|do not have|cannot|can't|can ?not|unable|unknown|without)\b/i;

export function verifyAnswer(answer: string, approved: number[], evidenceIds: string[], requiresMissingAck: boolean): Verification {
  const nums = extractNumbers(answer);
  const unsupported = nums.filter((n) => !numberSupported(n, approved)).map((n) => n.raw);
  const cites = [...answer.matchAll(/\[((?:[EGM]\d+(?:\s*,\s*)?)+)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/));
  const idSet = new Set(evidenceIds);
  const invalid = [...new Set(cites.filter((c) => !idSet.has(c)))];
  // Units for citation coverage: each bullet line is one unit; paragraphs are split into sentences.
  // A citation written after the full stop ("... 12%. [E2]") belongs to the previous sentence.
  const units: string[] = [];
  for (const line of answer.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    if (/^\*\*[^*]+\*\*:?$/.test(line)) continue; // bold heading line
    if (/^([-*•]|\d+[.)])\s+/.test(line)) {
      units.push(line);
      continue;
    }
    for (const part of line.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean)) {
      if (/^\[(?:[EGM]\d+(?:\s*,\s*)?)+\]\.?$/.test(part) && units.length) units[units.length - 1] += ` ${part}`;
      else units.push(part);
    }
  }
  let withNums = 0;
  let withNumsCited = 0;
  for (const s of units) {
    const labelFree = s.replace(/\b(?:building|bldg\.?|site)\s*#?\d+\b/gi, " ").replace(/#\d+/g, " ");
    const has = extractNumbers(labelFree).some((n) => !ALWAYS_OK.has(Math.abs(n.value)));
    if (has) {
      withNums++;
      if (/\[(?:[EGM]\d+(?:\s*,\s*)?)+\]/.test(s)) withNumsCited++;
    }
  }
  const mentions = requiresMissingAck ? MISSING_ACK.test(answer) : null;
  const issues: string[] = [];
  if (unsupported.length) issues.push(`Numbers not found in the evidence: ${unsupported.slice(0, 6).join(", ")}`);
  if (invalid.length) issues.push(`Citations that match no evidence item: ${invalid.join(", ")}`);
  if (requiresMissingAck && !mentions) issues.push("Does not say which information is missing.");
  const uncited = evidenceIds.length > 0 && withNums > 0 && withNumsCited === 0;
  if (uncited) issues.push("Figures are given without any citation.");
  const pass = unsupported.length === 0 && invalid.length === 0 && (!requiresMissingAck || !!mentions) && !uncited;
  return {
    numbersChecked: nums.length,
    numbersSupported: nums.length - unsupported.length,
    unsupported,
    citations: [...new Set(cites)],
    invalidCitations: invalid,
    sentencesWithNumbers: withNums,
    sentencesWithNumbersCited: withNumsCited,
    citationCoverage: withNums && evidenceIds.length ? Math.round((withNumsCited / withNums) * 100) / 100 : null,
    missingRequired: requiresMissingAck,
    mentionsMissing: mentions,
    pass,
    issues,
  };
}
