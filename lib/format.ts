import type { MeterName } from "./types";

export const METER_LABEL: Record<MeterName, string> = {
  electricity: "Electricity",
  chilledwater: "Chilled water",
  steam: "Steam",
  hotwater: "Hot water",
};

export const METERS: MeterName[] = ["electricity", "chilledwater", "steam", "hotwater"];

/** Thousands separators, fixed decimals. null/undefined -> "n/a". */
export function num(x: number | null | undefined, dp = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return x.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(x: number | null | undefined, dp = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return `${num(x, dp)}%`;
}

export function signedPct(x: number | null | undefined, dp = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return `${x > 0 ? "+" : ""}${num(x, dp)}%`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthName(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return `${MONTHS[m - 1] ?? ym} ${ym.slice(0, 4)}`;
}

/** "2016-08-01" -> "1 Aug 2016" */
export function day(d: string): string {
  const [y, m, dd] = d.split("-").map(Number);
  return `${dd} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

export function range(a: string, b: string): string {
  return a === b ? day(a) : `${day(a)} to ${day(b)}`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export function dayIndex(start: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
}

export function addDays(date: string, n: number): string {
  const t = new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000);
  return t.toISOString().slice(0, 10);
}
