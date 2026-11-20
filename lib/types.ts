// Shared types for the evidence file produced by notebooks/02 and for the chat pipeline.

export type MeterName = "electricity" | "chilledwater" | "steam" | "hotwater";

export interface UnitInfo {
  native_unit: string;
  factor_to_kwh: number | null;
  display_unit: string;
  status: "verified" | "converted" | "unverified" | "native";
  note: string;
}

export interface MeterStats {
  total_recorded: number | null;
  annualised_estimate: number | null;
  annualised_note: string;
  intensity_per_m2: number | null;
  intensity_implausible?: boolean;
  mean_hourly: number | null;
  median_hourly: number | null;
  p95_hourly: number | null;
  peak_hourly: number | null;
  peak_time: string | null;
  baseload_p05_hourly: number | null;
  night_to_midday_ratio: number | null;
  weekend_to_weekday_ratio: number | null;
  hours_expected: number;
  hours_recorded: number;
  hours_valid: number;
  hours_missing: number;
  hours_excluded: number;
  coverage_pct: number | null;
  valid_pct: number | null;
  zero_hours: number;
}

export interface MonthlyRow {
  month: string;
  actual: number | null;
  baseline: number | null;
  difference_pct: number | null;
  coverage_pct: number | null;
  mean_temp_c: number | null;
}

export interface BaselineFit {
  method: string;
  available: boolean;
  usable_for_anomalies?: boolean;
  cv_rmse_hourly_pct: number | null;
  nmbe_hourly_pct: number | null;
  cv_rmse_daily_pct: number | null;
  nmbe_daily_pct: number | null;
  cv_rmse_monthly_pct: number | null;
  nmbe_monthly_pct: number | null;
  g14_hourly_pass: boolean;
  g14_monthly_pass: boolean;
  daily_residual_sd_robust: number | null;
  hours_used: number;
  gbm_comparison?: { model: string; cv_rmse_daily_pct: number | null; nmbe_daily_pct: number | null; note: string };
}

export interface Anomaly {
  id: string;
  kind: "higher_than_expected" | "lower_than_expected";
  start: string;
  end: string;
  days: number;
  weekdays: number;
  weekend_days: number;
  actual_total: number | null;
  expected_total: number | null;
  difference: number | null;
  difference_pct: number | null;
  expected_range_low: number | null;
  expected_range_high: number | null;
  mean_abs_z: number | null;
  mean_temp_c: number | null;
  typical_month_temp_c: number | null;
  difference_share_by_time_pct: Record<string, number | null>;
  confidence: "high" | "medium" | "low";
  questions: string[];
}

export interface DataQualityIssue {
  kind: "missing_data" | "zero_readings" | "extended_zero_readings" | "flatline";
  start: string;
  end: string;
  hours: number;
  note: string;
}

export interface PeerResult {
  available: boolean;
  reason?: string;
  group_definition?: string;
  n_peers?: number;
  metric?: string;
  value?: number | null;
  peer_median?: number | null;
  peer_p25?: number | null;
  peer_p75?: number | null;
  percentile?: number | null;
  difference_vs_median_pct?: number | null;
  peer_values?: (number | null)[];
  nearest_peers?: { building_id: number; intensity: number | null; floor_area_m2: number | null }[];
  limitations?: string[];
}

export interface MeterData {
  unit: UnitInfo;
  stats: MeterStats;
  temperature_sensitivity: { cooling_slope_per_c: number | null; heating_slope_per_c: number | null; note: string };
  monthly: MonthlyRow[];
  profile_24h: { weekday: (number | null)[]; weekend: (number | null)[] };
  daily: {
    start: string;
    actual: (number | null)[];
    baseline: (number | null)[];
    baseline_gbm?: (number | null)[];
    temp_c: (number | null)[];
    quality_flag: number[];
  };
  baseline_fit: BaselineFit;
  anomalies: Anomaly[];
  data_quality: DataQualityIssue[];
  peers: PeerResult;
}

export interface BuildingProfile {
  building_id: number;
  site_id: number;
  primary_use: string;
  square_feet: number;
  floor_area_m2: number | null;
  year_built: number | null;
  floor_count: number | null;
  meters: MeterName[];
  missing_metadata: string[];
  site_weather: { mean_temp_c: number | null; min_temp_c: number | null; max_temp_c: number | null; raw_missing_hours: number | null };
  data_period: { start: string; end: string };
}

export interface BuildingData {
  profile: BuildingProfile;
  meters: Partial<Record<MeterName, MeterData>>;
}

export interface AssistantData {
  meta: {
    dataset: string;
    synthetic: boolean;
    generated_at: string;
    pipeline_version: string;
    period: { start: string; end: string };
    n_buildings_in_dataset: number;
    methods: Record<string, string>;
    thresholds: Record<string, unknown>;
  };
  buildings: Record<string, BuildingData>;
}

export interface GuidanceCard {
  id: string;
  title: string;
  summary: string;
  actions: string[];
  needs: string[];
  triggers: string[];
  keywords: string[];
  meters: string[];
  source: { publisher: string; title: string; url: string; year: string };
  verification: { status: string; checked_on: string; note: string };
}

// ----------------------------------------------------------------------------- pipeline

export type Intent =
  | "summary"
  | "anomalies"
  | "compare"
  | "improvements"
  | "report"
  | "data_quality"
  | "period"
  | "help";

export interface Period {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
  label: string;
  outOfRange?: boolean;
}

export interface ParsedQuestion {
  intent: Intent;
  confidence: number;
  scores: Record<string, number>;
  buildingId: string | null;
  buildingSource: "message" | "context" | "none";
  unknownBuilding: string | null;
  meter: MeterName | null;
  meterRequested: string | null;
  period: Period | null;
  savingsQuestion: boolean;
  system: string | null;
}

export type EvidenceKind =
  | "profile"
  | "stats"
  | "monthly"
  | "period"
  | "data_quality"
  | "baseline"
  | "anomaly"
  | "peers"
  | "guidance"
  | "method";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  title: string;
  summary: string;
  rows: [string, string][];
  source: string;
  method?: string;
  url?: string;
  meter?: MeterName;
  anomalyId?: string;
  confidence?: "high" | "medium" | "low";
}

export interface KeyPoint {
  text: string;
  cites: string[];
}

export interface MissingItem {
  id: string;
  text: string;
  why: string;
}

export interface Focus {
  meter: MeterName | null;
  period: Period | null;
  anomalyIds: string[];
  chart: "daily" | "monthly" | "profile" | "peers";
}

export interface AnswerPlan {
  question: string;
  parsed: ParsedQuestion;
  heading: string;
  evidence: EvidenceItem[];
  keyPoints: KeyPoint[];
  investigate: string[];
  missing: MissingItem[];
  requiresMissingAck: boolean;
  followUps: string[];
  focus: Focus;
  template: string;
  messages: { role: "system" | "user"; content: string }[];
  browserMessages: { role: "system" | "user"; content: string }[];
  approvedNumbers: number[];
  dataSynthetic: boolean;
}

export interface Verification {
  numbersChecked: number;
  numbersSupported: number;
  unsupported: string[];
  citations: string[];
  invalidCitations: string[];
  sentencesWithNumbers: number;
  sentencesWithNumbersCited: number;
  citationCoverage: number | null;
  missingRequired: boolean;
  mentionsMissing: boolean | null;
  pass: boolean;
  issues: string[];
}
