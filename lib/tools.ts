// Analysis tools. Each tool reads pre-computed figures from the evidence file (approved
// calculation logic lives in notebooks/ashrae_evidence.py) and returns evidence items with IDs,
// key points that cite them, questions to investigate and missing information.
// The only arithmetic done here is summing daily values over a user-chosen period.
import { DATA } from "./data";
import { METER_LABEL, METERS, addDays, day, dayIndex, monthName, num, ordinal, pct, range, signedPct } from "./format";
import { retrieveGuidance } from "./guidance";
import type {
  Anomaly,
  BuildingData,
  EvidenceItem,
  KeyPoint,
  MeterData,
  MeterName,
  MissingItem,
  ParsedQuestion,
  Period,
} from "./types";

const SRC_DATA = DATA.meta.synthetic
  ? "Synthetic demo data in ASHRAE format (replace with notebook 02 output)"
  : "ASHRAE GEPIII train.csv / building_metadata.csv / weather_train.csv";
const SRC = `${SRC_DATA} · pipeline v${DATA.meta.pipeline_version}`;

export class Ctx {
  evidence: EvidenceItem[] = [];
  keyPoints: KeyPoint[] = [];
  investigate: string[] = [];
  missing: MissingItem[] = [];
  private e = 0;
  private g = 0;
  private m = 0;
  constructor(public b: BuildingData | null, public parsed: ParsedQuestion, public question: string) {}

  add(item: Omit<EvidenceItem, "id">): string {
    const existing = this.evidence.find((x) => x.title === item.title && x.kind === item.kind);
    if (existing) return existing.id;
    const id = item.kind === "guidance" ? `G${++this.g}` : `E${++this.e}`;
    this.evidence.push({ ...item, id });
    return id;
  }
  point(text: string, ...cites: string[]) {
    this.keyPoints.push({ text, cites: cites.filter(Boolean) });
  }
  need(text: string, why: string) {
    if (this.missing.some((x) => x.text === text)) return;
    this.missing.push({ id: `M${++this.m}`, text, why });
  }
  ask(q: string, cite?: string) {
    const text = cite && /\d/.test(q) ? `${q} [${cite}]` : q;
    if (!this.investigate.some((x) => x.startsWith(q))) this.investigate.push(text);
  }
}

// ----------------------------------------------------------------------------- helpers
function unitOf(m: MeterData): string {
  return m.unit.display_unit;
}

export function metersFor(ctx: Ctx): MeterName[] {
  const b = ctx.b!;
  const have = METERS.filter((m) => b.meters[m]);
  const p = ctx.parsed;
  if (p.meter) {
    if (b.meters[p.meter]) return [p.meter];
    ctx.need(
      `${METER_LABEL[p.meter]} data for building ${b.profile.building_id}`,
      `This building has no ${METER_LABEL[p.meter].toLowerCase()} meter in the dataset (available: ${have.map((x) => METER_LABEL[x].toLowerCase()).join(", ")}).`,
    );
    return have;
  }
  if (p.meterRequested === "heating") {
    const heat = have.filter((m) => m === "steam" || m === "hotwater");
    if (heat.length) return heat;
    ctx.need(
      "A heating meter (steam, hot water or gas) for this building",
      `The dataset has no heating meter for building ${b.profile.building_id}; heating energy may be included in another supply that is not metered here.`,
    );
    return have;
  }
  return have;
}

function overlaps(a: Anomaly, p: Period | null): boolean {
  if (!p) return true;
  return !(a.end < p.start || a.start > p.end);
}

// ----------------------------------------------------------------------------- evidence makers
export function profileEvidence(ctx: Ctx): string {
  const p = ctx.b!.profile;
  const meters = p.meters.map((m) => METER_LABEL[m].toLowerCase()).join(", ");
  const yb = p.year_built ?? "unknown";
  const fl = p.floor_count ?? "unknown";
  return ctx.add({
    kind: "profile",
    title: `Building ${p.building_id} profile`,
    summary: `Building ${p.building_id}: ${p.primary_use}, site ${p.site_id}, floor area ${num(p.floor_area_m2)} m² (${num(p.square_feet)} sq ft), year built ${yb}, floors ${fl}. Meters: ${meters}. Readings cover ${day(p.data_period.start)} to ${day(p.data_period.end)}.`,
    rows: [
      ["Building ID", String(p.building_id)],
      ["Site", String(p.site_id)],
      ["Primary use", p.primary_use],
      ["Floor area", `${num(p.floor_area_m2)} m² (${num(p.square_feet)} sq ft)`],
      ["Year built", String(yb)],
      ["Floors", String(fl)],
      ["Meters", meters],
      ["Site temperature (2016)", `mean ${num(p.site_weather.mean_temp_c, 1)} °C, range ${num(p.site_weather.min_temp_c, 1)} to ${num(p.site_weather.max_temp_c, 1)} °C`],
    ],
    source: `${SRC} · building_metadata.csv`,
  });
}

export function statsEvidence(ctx: Ctx, meter: MeterName): string {
  const m = ctx.b!.meters[meter]!;
  const s = m.stats;
  const u = unitOf(m);
  return ctx.add({
    kind: "stats",
    meter,
    title: `${METER_LABEL[meter]} consumption statistics`,
    summary:
      `${METER_LABEL[meter]} (${u}, unit ${m.unit.status}): ${num(s.hours_recorded)} of ${num(s.hours_expected)} hours recorded (${pct(s.coverage_pct)} coverage); ` +
      `annualised estimate ${num(s.annualised_estimate)} ${u} = ${num(s.intensity_per_m2, 1)} ${u}/m²/yr; mean ${num(s.mean_hourly, 2)} ${u}/h; ` +
      `peak ${num(s.peak_hourly, 2)} ${u}/h (${s.peak_time ?? "n/a"}); base load (5th percentile) ${num(s.baseload_p05_hourly, 2)} ${u}/h; ` +
      `weekday night/midday ratio ${num(s.night_to_midday_ratio, 2)}; weekend/weekday ratio ${num(s.weekend_to_weekday_ratio, 2)}.`,
    rows: [
      ["Recorded total", `${num(s.total_recorded)} ${u}`],
      ["Annualised estimate", `${num(s.annualised_estimate)} ${u}`],
      ["Intensity", `${num(s.intensity_per_m2, 1)} ${u}/m²/yr`],
      ["Hours recorded", `${num(s.hours_recorded)} of ${num(s.hours_expected)} (${pct(s.coverage_pct)})`],
      ["Hours excluded (quality)", num(s.hours_excluded)],
      ["Mean / median hourly", `${num(s.mean_hourly, 2)} / ${num(s.median_hourly, 2)} ${u}`],
      ["Peak hourly", `${num(s.peak_hourly, 2)} ${u} at ${s.peak_time ?? "n/a"}`],
      ["Base load (5th percentile)", `${num(s.baseload_p05_hourly, 2)} ${u}/h`],
      ["Night (00–06) / midday (10–16), weekdays", num(s.night_to_midday_ratio, 2)],
      ["Weekend / weekday mean", num(s.weekend_to_weekday_ratio, 2)],
      ["Unit", m.unit.note],
    ],
    source: `${SRC} · train.csv`,
    method: s.annualised_note,
  });
}

export function monthlyEvidence(ctx: Ctx, meter: MeterName): string {
  const m = ctx.b!.meters[meter]!;
  const u = unitOf(m);
  const rows = m.monthly.filter((r) => r.actual !== null);
  const full = rows.filter((r) => (r.coverage_pct ?? 0) >= 90);
  const pool = full.length ? full : rows;
  const hi = pool.reduce((a, b) => ((b.actual ?? 0) > (a.actual ?? 0) ? b : a), pool[0]);
  const lo = pool.reduce((a, b) => ((b.actual ?? 0) < (a.actual ?? 0) ? b : a), pool[0]);
  const lowCov = rows.filter((r) => (r.coverage_pct ?? 0) < 90).map((r) => monthName(r.month));
  return ctx.add({
    kind: "monthly",
    meter,
    title: `${METER_LABEL[meter]} by month`,
    summary:
      `${METER_LABEL[meter]} by month: highest ${monthName(hi.month)} (${num(hi.actual)} ${u}, mean ${num(hi.mean_temp_c, 1)} °C), ` +
      `lowest ${monthName(lo.month)} (${num(lo.actual)} ${u}, mean ${num(lo.mean_temp_c, 1)} °C). ` +
      `Months under 90% coverage: ${lowCov.length ? lowCov.join(", ") : "none"}.`,
    rows: m.monthly.map((r) => [
      monthName(r.month),
      `${num(r.actual)} ${u} · baseline ${num(r.baseline)} · ${signedPct(r.difference_pct)} · ${pct(r.coverage_pct, 0)} coverage · ${num(r.mean_temp_c, 1)} °C`,
    ]),
    source: `${SRC} · train.csv, weather_train.csv`,
    method: "Sum of recorded hourly readings per month; baseline = TOWT prediction over the same hours.",
  });
}

export function dataQualityEvidence(ctx: Ctx, meter: MeterName): string {
  const m = ctx.b!.meters[meter]!;
  const s = m.stats;
  const byKind: Record<string, number> = {};
  for (const q of m.data_quality) byKind[q.kind] = (byKind[q.kind] ?? 0) + q.hours;
  const label: Record<string, string> = {
    missing_data: "missing",
    zero_readings: "zero electricity readings",
    extended_zero_readings: "extended zero readings",
    flatline: "flat-lined (repeated) readings",
  };
  const parts = Object.entries(byKind).map(([k, h]) => `${num(h)} h ${label[k]}`);
  return ctx.add({
    kind: "data_quality",
    meter,
    title: `${METER_LABEL[meter]} data quality`,
    summary:
      `${METER_LABEL[meter]} data quality: ${pct(s.coverage_pct)} of hours recorded, ${num(s.hours_missing)} h missing, ${num(s.hours_excluded)} h excluded from modelling; ` +
      `${m.data_quality.length} issue period(s)${parts.length ? ` (${parts.join(", ")})` : ""}. Unit: ${m.unit.note}`,
    rows: m.data_quality.length
      ? m.data_quality.slice(0, 12).map((q) => [`${q.start} → ${q.end}`, `${label[q.kind]} · ${num(q.hours)} h · ${q.note}`])
      : [["Issues", "No gaps or quality issues above the thresholds"]],
    source: `${SRC} · train.csv`,
    method: DATA.meta.methods.data_quality,
  });
}

export function baselineEvidence(ctx: Ctx, meter: MeterName): string {
  const m = ctx.b!.meters[meter]!;
  const f = m.baseline_fit;
  const u = unitOf(m);
  const verdict = (ok: boolean) => (ok ? "meets" : "does not meet");
  const gbm = f.gbm_comparison
    ? ` Leaderboard model (out-of-fold) daily CV(RMSE) ${pct(f.gbm_comparison.cv_rmse_daily_pct)} vs TOWT ${pct(f.cv_rmse_daily_pct)}.`
    : "";
  return ctx.add({
    kind: "baseline",
    meter,
    title: `${METER_LABEL[meter]} baseline model fit`,
    summary:
      `${METER_LABEL[meter]} baseline (weather and time-of-week model, cross-fitted by month): hourly CV(RMSE) ${pct(f.cv_rmse_hourly_pct)}, NMBE ${pct(f.nmbe_hourly_pct, 2)} ` +
      `(${verdict(f.g14_hourly_pass)} ASHRAE Guideline 14 hourly criteria of 30% and ±10%); monthly CV(RMSE) ${pct(f.cv_rmse_monthly_pct)}, NMBE ${pct(f.nmbe_monthly_pct, 2)} ` +
      `(${verdict(f.g14_monthly_pass)} monthly criteria of 15% and ±5%). Typical day-to-day scatter ±${num(f.daily_residual_sd_robust, 1)} ${u}/day.${gbm}`,
    rows: [
      ["Method", f.method],
      ["Hourly CV(RMSE) / NMBE", `${pct(f.cv_rmse_hourly_pct)} / ${pct(f.nmbe_hourly_pct, 2)} → ${verdict(f.g14_hourly_pass)} criteria`],
      ["Daily CV(RMSE) / NMBE", `${pct(f.cv_rmse_daily_pct)} / ${pct(f.nmbe_daily_pct, 2)}`],
      ["Monthly CV(RMSE) / NMBE", `${pct(f.cv_rmse_monthly_pct)} / ${pct(f.nmbe_monthly_pct, 2)} → ${verdict(f.g14_monthly_pass)} criteria`],
      ["Robust daily residual SD", `${num(f.daily_residual_sd_robust, 1)} ${u}`],
      ["Hours used", num(f.hours_used)],
      ...(f.gbm_comparison ? ([["Leaderboard model daily CV(RMSE)", `${pct(f.gbm_comparison.cv_rmse_daily_pct)} (${f.gbm_comparison.note})`]] as [string, string][]) : []),
    ],
    source: `${SRC} · TOWT model (Mathieu et al. 2011), ASHRAE Guideline 14 metrics`,
    method: DATA.meta.methods.fit_quality,
    confidence: f.g14_hourly_pass ? "high" : f.g14_monthly_pass ? "medium" : "low",
  });
}

export function anomalyEvidence(ctx: Ctx, meter: MeterName, a: Anomaly): string {
  const m = ctx.b!.meters[meter]!;
  const u = unitOf(m);
  const sh = a.difference_share_by_time_pct;
  const dir = a.kind === "higher_than_expected" ? "higher" : "lower";
  return ctx.add({
    kind: "anomaly",
    meter,
    anomalyId: a.id,
    confidence: a.confidence,
    title: `${METER_LABEL[meter]} ${dir} than expected, ${range(a.start, a.end)}`,
    summary:
      `${METER_LABEL[meter]}, ${range(a.start, a.end)} (${a.days} days: ${a.weekdays} weekdays, ${a.weekend_days} weekend days): actual ${num(a.actual_total)} ${u} vs expected ${num(a.expected_total)} ${u} ` +
      `(approximate expected range ${num(a.expected_range_low)} to ${num(a.expected_range_high)}); difference ${a.difference !== null && a.difference > 0 ? "+" : ""}${num(a.difference)} ${u} (${signedPct(a.difference_pct)}). ` +
      `Share of the difference by time of day: 00:00–06:00 ${pct(sh.night_00_06, 0)}, 06:00–18:00 ${pct(sh.day_06_18, 0)}, 18:00–24:00 ${pct(sh.evening_18_24, 0)}. ` +
      `Mean outdoor temperature ${num(a.mean_temp_c, 1)} °C vs ${num(a.typical_month_temp_c, 1)} °C for the rest of the month. Confidence: ${a.confidence}.`,
    rows: [
      ["Period", `${range(a.start, a.end)} (${a.days} days)`],
      ["Actual", `${num(a.actual_total)} ${u}`],
      ["Expected (baseline)", `${num(a.expected_total)} ${u} (range ${num(a.expected_range_low)}–${num(a.expected_range_high)})`],
      ["Difference", `${num(a.difference)} ${u} (${signedPct(a.difference_pct)})`],
      ["Strength (mean |z|)", num(a.mean_abs_z, 1)],
      ["By time of day", `night ${pct(sh.night_00_06, 0)} · day ${pct(sh.day_06_18, 0)} · evening ${pct(sh.evening_18_24, 0)}`],
      ["Temperature", `${num(a.mean_temp_c, 1)} °C vs ${num(a.typical_month_temp_c, 1)} °C typical`],
      ["Confidence", a.confidence],
    ],
    source: `${SRC} · daily residuals of the TOWT baseline`,
    method: `${DATA.meta.methods.anomalies} ${DATA.meta.methods.expected_range}`,
  });
}

export function peersEvidence(ctx: Ctx, meter: MeterName): string | null {
  const m = ctx.b!.meters[meter]!;
  const p = m.peers;
  const u = unitOf(m);
  if (!p.available) {
    return ctx.add({
      kind: "peers",
      meter,
      title: `${METER_LABEL[meter]} peer comparison`,
      summary: `${METER_LABEL[meter]} peer comparison not available: ${p.reason}`,
      rows: [["Reason", p.reason ?? "n/a"]],
      source: SRC,
      method: DATA.meta.methods.peers,
    });
  }
  return ctx.add({
    kind: "peers",
    meter,
    title: `${METER_LABEL[meter]} peer comparison`,
    summary:
      `${METER_LABEL[meter]} intensity ${num(p.value, 1)} ${u}/m²/yr vs peer median ${num(p.peer_median, 1)} (middle half of peers ${num(p.peer_p25, 1)} to ${num(p.peer_p75, 1)}); ` +
      `${ordinal(Math.round(p.percentile ?? 0))} percentile, ${signedPct(p.difference_vs_median_pct)} vs median. Peer group: ${p.group_definition} (${p.n_peers} buildings). ` +
      `Limitations: ${(p.limitations ?? []).join(" ")}`,
    rows: [
      ["Metric", p.metric ?? ""],
      ["This building", `${num(p.value, 1)} ${u}/m²/yr`],
      ["Peer median (25th–75th)", `${num(p.peer_median, 1)} (${num(p.peer_p25, 1)}–${num(p.peer_p75, 1)})`],
      ["Percentile", `${ordinal(Math.round(p.percentile ?? 0))} (higher than ${num(p.percentile, 0)}% of peers)`],
      ["Peer group", `${p.group_definition} · ${p.n_peers} buildings`],
      ["Nearest-size peers", (p.nearest_peers ?? []).slice(0, 5).map((x) => `#${x.building_id} ${num(x.intensity, 1)}`).join(", ")],
      ...(p.limitations ?? []).map((l, i) => [`Limitation ${i + 1}`, l] as [string, string]),
    ],
    source: `${SRC} · all buildings with ≥80% coverage`,
    method: DATA.meta.methods.peers,
  });
}

export function periodEvidence(ctx: Ctx, meter: MeterName, p: Period): { id: string; total: number | null } {
  const m = ctx.b!.meters[meter]!;
  const u = unitOf(m);
  const d = m.daily;
  const i0 = Math.max(0, dayIndex(d.start, p.start));
  const i1 = Math.min(d.actual.length - 1, dayIndex(d.start, p.end));
  let act = 0;
  let base = 0;
  let nDays = 0;
  let nBase = 0;
  let tSum = 0;
  let tN = 0;
  for (let i = i0; i <= i1; i++) {
    const a = d.actual[i];
    const bl = d.baseline[i];
    const t = d.temp_c[i];
    if (t !== null) {
      tSum += t;
      tN++;
    }
    if (a === null) continue;
    act += a;
    nDays++;
    if (bl !== null) {
      base += bl;
      nBase++;
    }
  }
  const span = i1 - i0 + 1;
  const diffPct = nBase === nDays && base > 0 ? (100 * (act - base)) / base : null;
  const id = ctx.add({
    kind: "period",
    meter,
    title: `${METER_LABEL[meter]}, ${p.label}`,
    summary:
      `${METER_LABEL[meter]}, ${p.label} (${day(addDays(d.start, i0))} to ${day(addDays(d.start, i1))}): ${num(act)} ${u} recorded on ${nDays} of ${span} days` +
      (diffPct !== null ? `; baseline ${num(base)} ${u}, difference ${signedPct(diffPct)}` : "") +
      `; mean outdoor temperature ${num(tN ? tSum / tN : null, 1)} °C.`,
    rows: [
      ["Period", `${day(addDays(d.start, i0))} to ${day(addDays(d.start, i1))}`],
      ["Recorded total", `${num(act)} ${u}`],
      ["Days with data", `${nDays} of ${span}`],
      ["Baseline over the same days", diffPct !== null ? `${num(base)} ${u}` : "n/a"],
      ["Difference", diffPct !== null ? signedPct(diffPct) : "n/a"],
      ["Mean temperature", `${num(tN ? tSum / tN : null, 1)} °C`],
    ],
    source: `${SRC} · daily totals`,
    method: "Sum of daily totals (days with at least 20 recorded hours) over the requested dates.",
  });
  return { id, total: nDays ? act : null };
}

// ----------------------------------------------------------------------------- signals
export function buildingSignals(b: BuildingData): { signals: string[]; notes: { text: string; meter: MeterName }[] } {
  const signals: string[] = [];
  const notes: { text: string; meter: MeterName }[] = [];
  const e = b.meters.electricity;
  const residential = /lodging|residential|healthcare/i.test(b.profile.primary_use);
  if (e) {
    const s = e.stats;
    if ((s.night_to_midday_ratio ?? 0) >= 0.6 && !residential) {
      signals.push("night_load");
      notes.push({ meter: "electricity", text: `Weekday night-time electricity is ${num(s.night_to_midday_ratio, 2)} times midday use, which can indicate equipment running out of hours.` });
    }
    if ((s.weekend_to_weekday_ratio ?? 0) >= 0.8 && !residential) {
      signals.push("weekend_load");
      notes.push({ meter: "electricity", text: `Weekend electricity is ${num(s.weekend_to_weekday_ratio, 2)} times weekday use, close to weekday levels for a ${b.profile.primary_use.toLowerCase()} building.` });
    }
    if (s.mean_hourly && s.baseload_p05_hourly && s.baseload_p05_hourly / s.mean_hourly >= 0.6) {
      signals.push("high_baseload");
      notes.push({ meter: "electricity", text: `Base load (5th percentile, ${num(s.baseload_p05_hourly, 2)} ${e.unit.display_unit}/h) is a large share of mean use (${num(s.mean_hourly, 2)} ${e.unit.display_unit}/h).` });
    }
  }
  for (const mt of METERS) {
    const m = b.meters[mt];
    if (!m) continue;
    const ts = m.temperature_sensitivity;
    const mean = m.stats.mean_hourly ?? 0;
    if (mean > 0 && ts.cooling_slope_per_c !== null && ts.cooling_slope_per_c / mean >= 0.04) {
      signals.push("temperature_sensitive");
      notes.push({ meter: mt, text: `${METER_LABEL[mt]} rises by about ${num(ts.cooling_slope_per_c, 2)} ${m.unit.display_unit}/h per °C in warm occupied hours (20–25 °C).` });
    }
    if (mean > 0 && ts.heating_slope_per_c !== null && ts.heating_slope_per_c / mean >= 0.04) {
      signals.push("temperature_sensitive");
      notes.push({ meter: mt, text: `${METER_LABEL[mt]} rises by about ${num(ts.heating_slope_per_c, 2)} ${m.unit.display_unit}/h per °C colder below 10 °C in occupied hours.` });
    }
    if (m.peers.available && (m.peers.percentile ?? 0) >= 75) {
      signals.push("high_intensity");
      notes.push({ meter: mt, text: `${METER_LABEL[mt]} intensity is at the ${ordinal(Math.round(m.peers.percentile ?? 0))} percentile of its peer group.` });
    }
    if (m.anomalies.some((a) => a.kind === "higher_than_expected" && a.confidence !== "low")) signals.push("anomaly_higher");
    if (m.anomalies.length) signals.push("anomaly_any");
  }
  return { signals: [...new Set(signals)], notes };
}

// ----------------------------------------------------------------------------- tools
export function summaryTool(ctx: Ctx) {
  const b = ctx.b!;
  const p = b.profile;
  const e1 = profileEvidence(ctx);
  ctx.point(`Building ${p.building_id} is a ${p.primary_use.toLowerCase()} building of ${num(p.floor_area_m2)} m² on site ${p.site_id}, with ${p.meters.length} meter type(s): ${p.meters.map((m) => METER_LABEL[m].toLowerCase()).join(", ")}.`, e1);
  const meters = metersFor(ctx);
  for (const mt of meters) {
    const m = b.meters[mt]!;
    const s = m.stats;
    const u = unitOf(m);
    const es = statsEvidence(ctx, mt);
    ctx.point(`${METER_LABEL[mt]}: annualised estimate ${num(s.annualised_estimate)} ${u} (${num(s.intensity_per_m2, 1)} ${u}/m²/yr), based on ${pct(s.coverage_pct)} of hours recorded.`, es);
  }
  const main = meters.includes("electricity") ? "electricity" : meters[0];
  const m = b.meters[main]!;
  const s = m.stats;
  const es = statsEvidence(ctx, main);
  ctx.point(`${METER_LABEL[main]} pattern: peak ${num(s.peak_hourly, 2)} ${unitOf(m)}/h (${s.peak_time}); weekday nights run at ${num(s.night_to_midday_ratio, 2)} times midday use and weekends at ${num(s.weekend_to_weekday_ratio, 2)} times weekdays.`, es);
  const em = monthlyEvidence(ctx, main);
  const mon = ctx.evidence.find((x) => x.id === em)!;
  ctx.point(mon.summary.replace(`${METER_LABEL[main]} by month: h`, `${METER_LABEL[main]} by month: H`), em);
  const issues = meters.reduce((n, mt) => n + b.meters[mt]!.data_quality.length, 0);
  const dq = dataQualityEvidence(ctx, main);
  ctx.point(issues ? `Data quality: ${issues} gap or quality issue period(s) across the meters; affected hours are excluded from the baseline.` : "Data quality: no gaps or quality issues above the thresholds.", dq);
  const eb = baselineEvidence(ctx, main);
  const nA = meters.reduce((n, mt) => n + b.meters[mt]!.anomalies.length, 0);
  ctx.point(`The weather-adjusted baseline ${m.baseline_fit.g14_hourly_pass ? "meets" : "does not meet"} ASHRAE Guideline 14 hourly criteria (CV(RMSE) ${pct(m.baseline_fit.cv_rmse_hourly_pct)}), and ${nA} unusual period(s) are flagged across the meters.`, eb);
  for (const k of p.missing_metadata) {
    ctx.need(k === "year_built" ? "Year of construction" : "Number of floors", "Not recorded in the ASHRAE metadata; it helps interpret envelope and system age.");
  }
  for (const mt of meters) {
    const mm = b.meters[mt]!;
    if (mm.unit.status === "unverified") ctx.need(`Confirmed unit for the ${METER_LABEL[mt].toLowerCase()} meter`, mm.unit.note);
  }
}

export function anomalyTool(ctx: Ctx) {
  const b = ctx.b!;
  const meters = metersFor(ctx);
  const period = ctx.parsed.period;
  let total = 0;
  for (const mt of meters) {
    const m = b.meters[mt]!;
    const eb = baselineEvidence(ctx, mt);
    if (!m.baseline_fit.usable_for_anomalies && m.baseline_fit.usable_for_anomalies !== undefined) {
      ctx.point(`${METER_LABEL[mt]}: the baseline does not meet Guideline 14 criteria (hourly CV(RMSE) ${pct(m.baseline_fit.cv_rmse_hourly_pct)}), so no periods are flagged for this meter.`, eb);
      continue;
    }
    const list = m.anomalies.filter((a) => overlaps(a, period)).slice(0, 4);
    total += list.length;
    if (!list.length) {
      ctx.point(`${METER_LABEL[mt]}: no period ${period ? `in ${period.label} ` : ""}departs from the baseline by the flagging rule (robust z-score of 3 or more and at least 15% difference).`, eb);
      continue;
    }
    for (const a of list) {
      const ea = anomalyEvidence(ctx, mt, a);
      const dir = a.kind === "higher_than_expected" ? "higher" : "lower";
      ctx.point(`${range(a.start, a.end)}: ${METER_LABEL[mt].toLowerCase()} was ${num(Math.abs(a.difference_pct ?? 0), 1)}% ${dir} than the weather-adjusted baseline (${num(a.actual_total)} vs ${num(a.expected_total)} ${unitOf(m)}; confidence ${a.confidence}).`, ea, eb);
      for (const q of a.questions.slice(0, 2)) ctx.ask(q, ea);
    }
    for (const q of m.data_quality.slice(0, 2)) {
      if (period && (q.end.slice(0, 10) < period.start || q.start.slice(0, 10) > period.end)) continue;
      const dq = dataQualityEvidence(ctx, mt);
      ctx.point(`${METER_LABEL[mt]} data issue ${q.start} to ${q.end}: ${q.note} These hours are excluded rather than treated as consumption.`, dq);
      ctx.ask("Can the meter log confirm the data gaps or zero readings (meter replacement, communication fault)?");
      break;
    }
  }
  if (total) ctx.point("These flags show where consumption departs from the modelled pattern for the weather and time of week; they do not establish a cause.");
  ctx.need("Operational records for the flagged dates (events, schedule changes, maintenance, closures)", "The dataset has no occupancy or operations log, so causes cannot be confirmed from meter data.");
}

export function compareTool(ctx: Ctx) {
  const b = ctx.b!;
  const meters = metersFor(ctx);
  let any = false;
  for (const mt of meters) {
    const m = b.meters[mt]!;
    const ep = peersEvidence(ctx, mt);
    if (!ep) continue;
    const p = m.peers;
    if (!p.available) {
      ctx.point(`${METER_LABEL[mt]}: no reliable comparison group (${p.reason?.replace(/\.$/, "")}).`, ep);
      continue;
    }
    any = true;
    const where = (p.percentile ?? 0) >= 75 ? "in the top quarter (higher use)" : (p.percentile ?? 0) <= 25 ? "in the bottom quarter (lower use)" : "within the middle half";
    ctx.point(`${METER_LABEL[mt]}: ${num(p.value, 1)} ${unitOf(m)}/m²/yr against a peer median of ${num(p.peer_median, 1)} — the ${ordinal(Math.round(p.percentile ?? 0))} percentile, ${where} of ${p.n_peers} peers (${p.group_definition}).`, ep);
  }
  if (any) {
    const first = meters.find((mt) => b.meters[mt]!.peers.available)!;
    const lim = b.meters[first]!.peers.limitations ?? [];
    const ep = peersEvidence(ctx, first)!;
    ctx.point(`Limits of this comparison: ${lim.slice(0, 2).join(" ")}`, ep);
  }
  ctx.need("Operating hours and occupancy (people or student numbers)", "Needed to normalise the comparison beyond floor area.");
  ctx.need("Confirmation that the floor area matches the metered area", "Sub-metered or shared supplies distort intensity comparisons.");
}

export function improvementTool(ctx: Ctx) {
  const b = ctx.b!;
  const p = ctx.parsed;
  const { signals, notes } = buildingSignals(b);
  if (p.savingsQuestion) signals.push("savings_question");
  if (p.system === "heating system" || p.system === "heat pump") signals.push("heating_replacement");
  if (p.system === "cooling system") signals.push("cooling_replacement");
  if (p.system === "lighting") signals.push("lighting_question");
  if (p.system === "insulation" || p.system === "windows/glazing") signals.push("envelope_question");
  signals.push("improvements_any");

  const meters = metersFor(ctx);
  for (const n of notes.slice(0, 4)) {
    if (!meters.includes(n.meter) && !p.savingsQuestion) continue;
    const src = notes.length ? (n.text.includes("percentile") ? peersEvidence(ctx, n.meter) : statsEvidence(ctx, n.meter)) : null;
    ctx.point(`Indicator: ${n.text}`, src ?? "");
  }
  const higher = meters.flatMap((mt) => b.meters[mt]!.anomalies.filter((a) => a.kind === "higher_than_expected" && a.confidence !== "low").slice(0, 1).map((a) => ({ mt, a })));
  for (const { mt, a } of higher.slice(0, 2)) {
    const ea = anomalyEvidence(ctx, mt, a);
    ctx.point(`Indicator: ${METER_LABEL[mt].toLowerCase()} ran ${num(a.difference_pct, 1)}% above its baseline from ${range(a.start, a.end)}; recurring excess like this is usually an operational issue worth checking first.`, ea);
  }
  if (!notes.length && !higher.length) {
    const main = meters.includes("electricity") ? "electricity" : meters[0];
    const es = statsEvidence(ctx, main);
    ctx.point(`No strong indicator stands out in the ${METER_LABEL[main].toLowerCase()} data (night/midday ${num(b.meters[main]!.stats.night_to_midday_ratio, 2)}, weekend/weekday ${num(b.meters[main]!.stats.weekend_to_weekday_ratio, 2)}).`, es);
  }

  const cards = retrieveGuidance(ctx.question, signals, ctx.parsed.meter, p.savingsQuestion ? 4 : 4);
  for (const c of cards) {
    const g = ctx.add({
      kind: "guidance",
      title: c.card.title,
      summary: `${c.card.title}. ${c.card.summary}`,
      rows: [
        ["Summary", c.card.summary],
        ...c.card.actions.map((a, i) => [`Action ${i + 1}`, a] as [string, string]),
        ["Details needed", c.card.needs.join("; ")],
        ["Matched because", [...c.matchedTriggers.map((t) => `signal: ${t}`), ...c.matchedKeywords.map((k) => `question: "${k}"`)].join(", ") || "general relevance"],
        ["Source", `${c.card.source.publisher}, ${c.card.source.title} (${c.card.source.year})`],
        ["Review status", `${c.card.verification.status}, ${c.card.verification.checked_on}: ${c.card.verification.note}`],
      ],
      source: `${c.card.source.publisher} — ${c.card.source.title}`,
      url: c.card.source.url,
    });
    ctx.point(`Consider: ${c.card.title.charAt(0).toLowerCase()}${c.card.title.slice(1)} — ${c.card.actions[0].charAt(0).toLowerCase()}${c.card.actions[0].slice(1)}`, g);
  }

  if (p.savingsQuestion) {
    const what = p.system ?? "this measure";
    ctx.point(`I cannot estimate savings for ${what === "this measure" ? what : `replacing the ${what}`} from meter data alone: that needs the current system, the proposed replacement and their costs. Once those are provided, the baseline model can be used to verify savings after the change.`);
    if (p.system === "heating system" || p.system === "heat pump" || p.meterRequested === "heating") {
      ctx.need("Current heating system: type, fuel, age, capacity and rated efficiency", "Savings depend on the efficiency difference between the old and new system.");
      ctx.need("Proposed replacement: type and rated efficiency (or seasonal performance)", "Defines the expected change in energy use.");
    } else {
      ctx.need(`Current ${what}: type, age and rated performance`, "Savings depend on what is being replaced.");
      ctx.need(`Proposed ${what}: type and rated performance`, "Defines the expected change in energy use.");
    }
    ctx.need("Installed cost, grants and any financing terms", "Needed to judge whether the measure saves money, not just energy.");
    ctx.need("Energy prices or tariffs for each fuel", "Converts energy savings into money.");
  } else {
    ctx.need("HVAC and heating system types, ages and control arrangements", "Needed to judge which measures apply; not in the ASHRAE dataset.");
    ctx.need("Operating hours and occupancy schedule", "Separates genuine out-of-hours waste from legitimate use.");
    ctx.need("Envelope condition (insulation, glazing, roof)", "Not in the dataset; affects heating and cooling measures.");
    ctx.need("Energy prices, budget and any financing rules", "Needed to rank measures by cost-effectiveness.");
  }
  if (!b.meters.steam && !b.meters.hotwater && (p.system === "heating system" || p.meterRequested === "heating")) {
    ctx.need("A heating meter (steam, hot water or gas) for this building", "No heating meter is in the dataset, so current heating use is unknown.");
  }
}

export function dataQualityTool(ctx: Ctx) {
  const b = ctx.b!;
  for (const mt of metersFor(ctx)) {
    const m = b.meters[mt]!;
    const dq = dataQualityEvidence(ctx, mt);
    ctx.point(`${METER_LABEL[mt]}: ${pct(m.stats.coverage_pct)} of hours recorded, ${num(m.stats.hours_excluded)} h excluded, ${m.data_quality.length} issue period(s); unit ${m.unit.status}.`, dq);
    if (m.unit.status === "unverified") ctx.need(`Confirmed unit for the ${METER_LABEL[mt].toLowerCase()} meter`, m.unit.note);
  }
  for (const k of b.profile.missing_metadata) ctx.need(k === "year_built" ? "Year of construction" : "Number of floors", "Not recorded in the ASHRAE metadata.");
}

export function periodTool(ctx: Ctx) {
  const b = ctx.b!;
  const p = ctx.parsed.period!;
  for (const mt of metersFor(ctx)) {
    const m = b.meters[mt]!;
    const { id } = periodEvidence(ctx, mt, p);
    const ev = ctx.evidence.find((x) => x.id === id)!;
    ctx.point(ev.summary, id);
    const inP = m.anomalies.filter((a) => overlaps(a, p));
    if (inP.length) {
      const a = inP[0];
      const ea = anomalyEvidence(ctx, mt, a);
      ctx.point(`Within this period, ${range(a.start, a.end)} was flagged as ${a.kind === "higher_than_expected" ? "higher" : "lower"} than expected (${signedPct(a.difference_pct)}).`, ea);
    }
  }
}
