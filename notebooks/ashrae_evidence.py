# =============================================================================
# ashrae_evidence.py — "approved calculation logic" for the Building Energy
# Evidence Assistant. Every number the assistant shows is produced here.
#
# Methods (all documented in the exported JSON under meta.methods):
#   * Units: Kaggle GEPIII units per site/meter from the Building Data Genome 2
#     wiki ("Meters data features"); converted to kWh where a factor exists.
#   * Weather: UTC -> local time using the widely used per-site offsets.
#   * Data quality: missing runs, electricity zero runs, flat-lines.
#   * Baseline: LBNL Time-Of-Week-and-Temperature (TOWT) regression
#     (Mathieu et al., 2011; Price et al., 2011), cross-fitted leave-one-month-out
#     so a month's own anomalies cannot be absorbed into its baseline.
#   * Fit quality: ASHRAE Guideline 14 CV(RMSE) / NMBE (hourly + monthly).
#   * Unusual periods: robust z-score of daily residuals (MAD), |z|>=3 and
#     |difference|>=15 %, merged into periods; never a cause, only questions.
#   * Peers: same use + same meter, same site first; EUI per m2, percentile.
# =============================================================================
import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

PIPELINE_VERSION = "1.1.0"
YEAR_START, YEAR_END = "2016-01-01 00:00", "2016-12-31 23:00"
HOURS = pd.date_range(YEAR_START, YEAR_END, freq="h")
N_HOURS = len(HOURS)  # 8784 (2016 is a leap year)
SQFT_TO_M2 = 0.092903

METER_NAMES = {0: "electricity", 1: "chilledwater", 2: "steam", 3: "hotwater"}
METER_LABELS = {"electricity": "Electricity", "chilledwater": "Chilled water",
                "steam": "Steam", "hotwater": "Hot water"}

# Hours to subtract from weather (UTC) to obtain site-local time (public GEPIII kernels).
SITE_UTC_OFFSET = {0: 4, 1: 0, 2: 7, 3: 4, 4: 7, 5: 0, 6: 4, 7: 4, 8: 4,
                   9: 5, 10: 7, 11: 4, 12: 0, 13: 5, 14: 4, 15: 4}

# Kaggle units + conversion to kWh (Building Data Genome 2 wiki, "Meters data features").
UNIT_TABLE = {
    (0, "electricity"): ("kBTU", 0.293071), (0, "chilledwater"): ("kBTU", 0.293071),
    (2, "chilledwater"): ("ton-hours", 3.51685), (2, "hotwater"): ("mmBTU", 293.071),
    (6, "chilledwater"): ("ton-hours", 3.51685), (6, "steam"): ("lbs", None),
    (7, "chilledwater"): ("MJ", 0.277778), (7, "electricity"): ("MJ", 0.277778),
    (9, "chilledwater"): ("ton-hours", 3.51685), (9, "steam"): ("lbs", None),
    (10, "chilledwater"): ("kBTU", 0.293071), (10, "hotwater"): ("kBTU", 0.293071),
    (11, "chilledwater"): ("kWh", 1.0),
    (13, "chilledwater"): ("ton-hours", 3.51685), (13, "steam"): ("lbs", None),
    (14, "chilledwater"): ("mmBTU", 293.071), (14, "hotwater"): ("mmBTU", 293.071),
    (14, "steam"): ("lbs", None),
    (15, "chilledwater"): ("ton-hours", 3.51685), (15, "hotwater"): ("ton-hours", 3.51685),
    (15, "steam"): ("lbs", None),
}

TEMP_KNOTS_C = [10.0, 15.0, 20.0, 25.0, 30.0]      # TOWT piecewise-linear knots
G14 = {"hourly_cv": 30.0, "hourly_nmbe": 10.0, "monthly_cv": 15.0, "monthly_nmbe": 5.0}
ANOMALY = {"z": 3.0, "min_rel": 0.15, "merge_gap_days": 1, "min_day_hours": 20}
DQ = {"missing_run_h": 24, "elec_zero_run_h": 24, "flatline_run_h": 48, "thermal_zero_run_h": 168}


# ----------------------------------------------------------------------------- units
UNIT_OVERRIDES = {}   # filled by resolve_units() when a table factor fails the plausibility check
PLAUSIBILITY_RATIO = 3.0  # converted site median may be at most 3x away from kWh-as-supplied sites


def unit_info(site_id: int, meter: str) -> dict:
    key = (int(site_id), meter)
    if key in UNIT_OVERRIDES:
        return UNIT_OVERRIDES[key]
    if key in UNIT_TABLE:
        native, factor = UNIT_TABLE[key]
        if factor is None:
            return {"native_unit": native, "factor_to_kwh": None, "display_unit": "lbs steam",
                    "status": "native",
                    "note": "Steam is recorded as mass (lbs); it is not converted to energy, so it "
                            "cannot be compared with kWh meters."}
        if native == "kWh":
            return {"native_unit": "kWh", "factor_to_kwh": 1.0, "display_unit": "kWh",
                    "status": "verified", "note": "Recorded in kWh (BDG2 unit table)."}
        return {"native_unit": native, "factor_to_kwh": factor, "display_unit": "kWh",
                "status": "converted",
                "note": f"Recorded in {native}; converted to kWh using x{factor} (BDG2 unit table)."}
    if meter == "electricity":
        return {"native_unit": "kWh", "factor_to_kwh": 1.0, "display_unit": "kWh",
                "status": "verified", "note": "Recorded in kWh (BDG2 unit table)."}
    return {"native_unit": "kWh (assumed)", "factor_to_kwh": 1.0, "display_unit": "kWh",
            "status": "unverified",
            "note": "Unit assumed to be kWh as stated in the competition description; the BDG2 unit "
                    "table does not confirm it for this site and meter."}


def resolve_units(train: pd.DataFrame, meta: pd.DataFrame) -> list:
    """Plausibility check for every table conversion (site, meter).

    For each meter type, the reference is the median intensity of buildings at sites whose readings
    are used as supplied (kWh). If converting a site's readings moves its median intensity more than
    PLAUSIBILITY_RATIO away from that reference, and the unconverted readings are closer, the factor
    is not applied and the unit is marked unverified. Returns a log of the decisions."""
    UNIT_OVERRIDES.clear()
    g = train.groupby(["building_id", "meter"]).meter_reading.mean().reset_index()
    g = g.merge(meta[["building_id", "site_id", "square_feet"]], on="building_id")
    g["meter_name"] = g.meter.map(METER_NAMES)
    g["native_int"] = g.meter_reading * N_HOURS / (g.square_feet * SQFT_TO_M2)
    g = g[g.native_int > 0]
    log = []
    for (site, mname), grp in g.groupby(["site_id", "meter_name"]):
        u = unit_info(site, mname)
        if u["status"] != "converted":
            continue
        ref_pool = g[(g.meter_name == mname) & (g.site_id != site)]
        ref_pool = ref_pool[[unit_info(s_, mname)["status"] in ("verified", "unverified") for s_ in ref_pool.site_id]]
        if len(ref_pool) < 5:
            log.append({"site": int(site), "meter": mname, "decision": "kept (no reference sites)"})
            continue
        ref = float(ref_pool.groupby("site_id").native_int.median().median())
        nat = float(grp.native_int.median())
        conv = nat * u["factor_to_kwh"]
        d_conv, d_nat = abs(math.log10(conv / ref)), abs(math.log10(nat / ref))
        entry = {"site": int(site), "meter": mname, "table_unit": u["native_unit"], "factor": u["factor_to_kwh"],
                 "converted_vs_reference": round(conv / ref, 2), "unconverted_vs_reference": round(nat / ref, 2)}
        if d_conv > math.log10(PLAUSIBILITY_RATIO) and d_nat < d_conv:
            UNIT_OVERRIDES[(int(site), mname)] = {
                "native_unit": "as supplied", "factor_to_kwh": 1.0, "display_unit": "kWh", "status": "unverified",
                "note": (f"The BDG2 unit table lists {u['native_unit']} (x{u['factor_to_kwh']}) for this site and meter, "
                         f"but converting gave a median intensity {conv / ref:,.0f}x that of the same meter type at other "
                         f"sites, so readings are shown as supplied (assumed kWh). Confirm the unit before relying on totals.")}
            entry["decision"] = "conversion NOT applied (implausible)"
        else:
            entry["decision"] = "conversion applied"
        log.append(entry)
    return log


# ----------------------------------------------------------------------------- loading
def load_raw(data_dir: str):
    train = pd.read_csv(f"{data_dir}/train.csv", parse_dates=["timestamp"],
                        dtype={"building_id": "int16", "meter": "int8", "meter_reading": "float64"})
    meta = pd.read_csv(f"{data_dir}/building_metadata.csv")
    weather = pd.read_csv(f"{data_dir}/weather_train.csv", parse_dates=["timestamp"])
    return train, meta, weather


def local_weather(weather: pd.DataFrame) -> dict:
    """Per site: hourly local-time air temperature for 2016, interpolated."""
    out = {}
    for site, g in weather.groupby("site_id"):
        g = g.copy()
        g["timestamp"] = g["timestamp"] - pd.to_timedelta(SITE_UTC_OFFSET.get(int(site), 0), unit="h")
        s = g.drop_duplicates("timestamp").set_index("timestamp")["air_temperature"].reindex(HOURS)
        filled = s.interpolate(limit=24, limit_direction="both")
        if filled.isna().any():  # long gaps: same hour-of-day mean of the same month
            hod = filled.groupby([filled.index.month, filled.index.hour]).transform("mean")
            filled = filled.fillna(hod).ffill().bfill()
        out[int(site)] = {"temp": filled.values.astype(float), "raw_missing": int(s.isna().sum())}
    return out


# ----------------------------------------------------------------------------- helpers
def runs(mask: np.ndarray):
    """Return list of (start, end_exclusive) for True runs."""
    if mask.size == 0:
        return []
    m = np.concatenate([[False], mask, [False]]).astype(int)
    d = np.diff(m)
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def constant_runs(y: np.ndarray, recorded: np.ndarray, min_len: int, zero: bool):
    """Runs of identical consecutive recorded values (zero=True -> only zeros, else non-zero)."""
    res = []
    n = len(y)
    i = 0
    while i < n:
        if not recorded[i] or (zero and y[i] != 0) or (not zero and y[i] == 0):
            i += 1
            continue
        j = i + 1
        while j < n and recorded[j] and y[j] == y[i]:
            j += 1
        if j - i >= min_len:
            res.append((i, j))
        i = j
    return res


def r(x, nd=1):
    if x is None:
        return None
    try:
        if isinstance(x, (float, np.floating)) and (math.isnan(x) or math.isinf(x)):
            return None
    except TypeError:
        return None
    return round(float(x), nd)


def sig(x, digits=4):
    """Round to significant digits for compact JSON arrays."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    x = float(x)
    if x == 0:
        return 0.0
    return round(x, max(0, digits - 1 - int(math.floor(math.log10(abs(x))))))


def fmt_ts(i: int) -> str:
    return HOURS[i].strftime("%Y-%m-%d %H:00")


def fmt_day(d: int) -> str:
    return (HOURS[0] + pd.Timedelta(days=int(d))).strftime("%Y-%m-%d")


# ----------------------------------------------------------------------------- TOWT
def temp_basis(t: np.ndarray) -> np.ndarray:
    k = TEMP_KNOTS_C
    cols = [np.minimum(t, k[0])]
    for a, b in zip(k[:-1], k[1:]):
        cols.append(np.clip(t - a, 0, b - a))
    cols.append(np.maximum(t - k[-1], 0))
    return np.column_stack(cols)


def towt_design(how: np.ndarray, t: np.ndarray, occupied_how: np.ndarray) -> np.ndarray:
    X_how = np.zeros((len(how), 168))
    X_how[np.arange(len(how)), how] = 1.0
    tb = temp_basis(t)
    occ = occupied_how[how].astype(float)[:, None]
    return np.hstack([X_how, tb * occ, tb * (1 - occ)])


def occupied_hours_of_week(y, how, t, train_mask):
    """TOWT occupancy rule (Mathieu et al. 2011): fit load ~ temperature only; an hour of
    the week is 'occupied' when its residuals are positive more than 65 % of the time."""
    tb = np.column_stack([np.ones(train_mask.sum()), temp_basis(t[train_mask])])
    coef, *_ = np.linalg.lstsq(tb, y[train_mask], rcond=None)
    resid = y[train_mask] - tb @ coef
    share_pos = pd.Series(resid > 0).groupby(how[train_mask]).mean().reindex(range(168)).fillna(0).values
    return share_pos > 0.65


def fit_towt(y, how, t, train_mask):
    occupied_how = occupied_hours_of_week(y, how, t, train_mask)
    X = towt_design(how, t, occupied_how)
    coef, *_ = np.linalg.lstsq(X[train_mask], y[train_mask], rcond=None)
    return coef, occupied_how, X


def cross_fit_towt(y, t, valid):
    """Leave-one-month-out predictions for every hour of 2016."""
    how = (HOURS.dayofweek.values * 24 + HOURS.hour.values).astype(int)
    month = HOURS.month.values
    pred = np.full(N_HOURS, np.nan)
    for m in range(1, 13):
        train = valid & (month != m)
        if train.sum() < 24 * 60:
            train = valid
        if train.sum() < 24 * 14:
            continue
        coef, occ, X = fit_towt(y, how, t, train)
        sel = month == m
        pred[sel] = X[sel] @ coef
    full_coef, full_occ, _ = fit_towt(y, how, t, valid) if valid.sum() >= 24 * 14 else (None, None, None)
    return np.clip(pred, 0, None), full_coef, full_occ


def g14_metrics(y, yhat):
    ok = ~np.isnan(y) & ~np.isnan(yhat)
    y, yhat = y[ok], yhat[ok]
    if len(y) < 3 or y.mean() <= 0:
        return None, None
    ybar = y.mean()
    cv = math.sqrt(np.mean((y - yhat) ** 2)) / ybar * 100
    nmbe = np.sum(y - yhat) / (len(y) * ybar) * 100
    return cv, nmbe


# ----------------------------------------------------------------------------- per meter
def analyse_meter(y_native: np.ndarray, temp: np.ndarray, site_id: int, meter: str, area_m2: float):
    unit = unit_info(site_id, meter)
    factor = unit["factor_to_kwh"] or 1.0
    y = y_native * factor
    recorded = ~np.isnan(y)
    y0 = np.where(recorded, y, 0.0)

    # ---- data quality runs
    dq = []
    for a, b in runs(~recorded):
        if b - a >= DQ["missing_run_h"]:
            dq.append(("missing_data", a, b))
    if meter == "electricity":
        for a, b in constant_runs(y0, recorded, DQ["elec_zero_run_h"], zero=True):
            dq.append(("zero_readings", a, b))
    else:
        for a, b in constant_runs(y0, recorded, DQ["thermal_zero_run_h"], zero=True):
            dq.append(("extended_zero_readings", a, b))
    for a, b in constant_runs(y0, recorded, DQ["flatline_run_h"], zero=False):
        dq.append(("flatline", a, b))
    excluded = np.zeros(N_HOURS, bool)
    for kind, a, b in dq:
        if kind in ("zero_readings", "flatline"):
            excluded[a:b] = True
    if meter == "electricity":
        excluded |= recorded & (y0 == 0)
    valid = recorded & ~excluded

    # ---- baseline
    pred, coef, occ = cross_fit_towt(y0, temp, valid)
    has_baseline = not np.all(np.isnan(pred))
    cv_h, nmbe_h = g14_metrics(np.where(valid, y0, np.nan), np.where(valid, pred, np.nan))

    day_idx = np.arange(N_HOURS) // 24
    n_days = N_HOURS // 24
    df = pd.DataFrame({"day": day_idx, "month": HOURS.month.values, "y": np.where(valid, y0, np.nan),
                       "yrec": np.where(recorded, y0, np.nan),
                       "p": np.where(valid, pred, np.nan), "prec": np.where(recorded, pred, np.nan),
                       "valid": valid, "rec": recorded, "t": temp, "hour": HOURS.hour.values,
                       "dow": HOURS.dayofweek.values, "excluded": excluded})
    daily = df.groupby("day").agg(actual=("yrec", "sum"), base=("prec", "sum"), rec_h=("rec", "sum"),
                                  valid_h=("valid", "sum"), t=("t", "mean"),
                                  actual_v=("y", "sum"), base_v=("p", "sum"), excl=("excluded", "sum"))
    good_day = (daily.valid_h >= ANOMALY["min_day_hours"]).values & (daily.excl == 0).values

    monthly_v = df[df.valid].groupby("month").agg(y=("y", "sum"), p=("p", "sum"))
    cv_m, nmbe_m = g14_metrics(monthly_v.y.values, monthly_v.p.values) if len(monthly_v) >= 3 else (None, None)
    cv_d, nmbe_d = g14_metrics(daily.actual_v.values[good_day], daily.base_v.values[good_day])
    resid_d = daily.actual_v.values[good_day] - daily.base_v.values[good_day]
    if resid_d.size >= 10:
        med = float(np.median(resid_d))
        s_d = float(1.4826 * np.median(np.abs(resid_d - med)))
        s_d = max(s_d, 0.02 * float(np.mean(daily.base_v.values[good_day]) or 1e-9))
    else:
        med, s_d = 0.0, None

    g14_hourly_pass = cv_h is not None and cv_h <= G14["hourly_cv"] and abs(nmbe_h) <= G14["hourly_nmbe"]
    g14_monthly_pass = cv_m is not None and cv_m <= G14["monthly_cv"] and abs(nmbe_m) <= G14["monthly_nmbe"]

    # ---- descriptive statistics
    yv = y0[valid]
    n_rec, n_valid = int(recorded.sum()), int(valid.sum())
    weekday = HOURS.dayofweek.values < 5
    def mean_where(mask):
        m = valid & mask
        return float(y0[m].mean()) if m.sum() > 0 else None
    night = mean_where(weekday & (HOURS.hour.values <= 5))
    midday = mean_where(weekday & (HOURS.hour.values >= 10) & (HOURS.hour.values <= 15))
    wkend, wkday = mean_where(~weekday), mean_where(weekday)
    annualised = float(yv.mean() * N_HOURS) if n_valid else None
    peak_i = int(np.nanargmax(np.where(valid, y0, np.nan))) if n_valid else None
    stats = {
        "total_recorded": r(float(y0[recorded].sum()), 0),
        "annualised_estimate": r(annualised, 0),
        "annualised_note": "Mean of valid hourly readings x 8,784 hours (gaps filled with the average).",
        "intensity_per_m2": r(annualised / area_m2, 1) if annualised and area_m2 else None,
        "intensity_implausible": bool(annualised and area_m2 and unit["status"] != "native" and annualised / area_m2 > 1500),
        "mean_hourly": r(yv.mean(), 2) if n_valid else None,
        "median_hourly": r(np.median(yv), 2) if n_valid else None,
        "p95_hourly": r(np.percentile(yv, 95), 2) if n_valid else None,
        "peak_hourly": r(y0[peak_i], 2) if peak_i is not None else None,
        "peak_time": fmt_ts(peak_i) if peak_i is not None else None,
        "baseload_p05_hourly": r(np.percentile(yv, 5), 2) if n_valid else None,
        "night_to_midday_ratio": r(night / midday, 2) if night is not None and midday else None,
        "weekend_to_weekday_ratio": r(wkend / wkday, 2) if wkend is not None and wkday else None,
        "hours_expected": N_HOURS, "hours_recorded": n_rec, "hours_valid": n_valid,
        "hours_missing": int(N_HOURS - n_rec), "hours_excluded": int((recorded & excluded).sum()),
        "coverage_pct": r(100 * n_rec / N_HOURS, 1), "valid_pct": r(100 * n_valid / N_HOURS, 1),
        "zero_hours": int((recorded & (y0 == 0)).sum()),
    }

    # ---- temperature sensitivity from full-year TOWT coefficients
    sens = {"cooling_slope_per_c": None, "heating_slope_per_c": None,
            "note": "Change in modelled average hourly load per 1 degC, occupied hours, from the TOWT fit."}
    if coef is not None:
        tb_occ = coef[168:174]
        t_valid = temp[valid]
        if (t_valid > 22).sum() >= 200:
            sens["cooling_slope_per_c"] = r(tb_occ[3], 3)      # 20–25 °C segment
        if (t_valid < 8).sum() >= 200:
            sens["heating_slope_per_c"] = r(-tb_occ[0], 3)     # below 10 °C (positive = more when colder)

    # ---- monthly table
    mon = df.groupby("month").agg(actual=("yrec", "sum"), rec_h=("rec", "sum"), base=("prec", "sum"),
                                  t=("t", "mean"))
    hours_in_month = pd.Series(HOURS.month.values).value_counts().sort_index()
    monthly = []
    for m, row in mon.iterrows():
        cov = 100 * row.rec_h / hours_in_month[m]
        monthly.append({
            "month": f"2016-{m:02d}", "actual": r(row.actual, 0), "baseline": r(row.base, 0) if has_baseline else None,
            "difference_pct": r(100 * (row.actual - row.base) / row.base, 1) if has_baseline and row.base > 0 else None,
            "coverage_pct": r(cov, 1), "mean_temp_c": r(row.t, 1)})

    # ---- 24h profiles
    prof = df[df.valid].groupby([df.dow[df.valid] < 5, "hour"]).y.mean()
    profile = {"weekday": [sig(prof.get((True, h), np.nan), 4) for h in range(24)],
               "weekend": [sig(prof.get((False, h), np.nan), 4) for h in range(24)]}

    # ---- unusual consumption periods
    anomalies = []
    baseline_usable = has_baseline and s_d and (g14_hourly_pass or g14_monthly_pass)
    if baseline_usable:
        resid_all = daily.actual_v.values - daily.base_v.values
        z = (resid_all - med) / s_d
        rel = np.where(daily.base_v.values > 0, resid_all / np.maximum(daily.base_v.values, 1e-9), 0)
        hi = good_day & (z >= ANOMALY["z"]) & (rel >= ANOMALY["min_rel"])
        lo = good_day & (z <= -ANOMALY["z"]) & (rel <= -ANOMALY["min_rel"])
        for sign, flag in (("higher_than_expected", hi), ("lower_than_expected", lo)):
            # merge with 1-day gap tolerance
            f = flag.copy()
            for a, b in runs(~flag):
                if 0 < a and b < n_days and b - a <= ANOMALY["merge_gap_days"] and flag[a - 1] and flag[b]:
                    f[a:b] = True
            for a, b in runs(f):
                days = np.arange(a, b)
                use = days[good_day[days]]
                act, exp_ = float(daily.actual_v.values[use].sum()), float(daily.base_v.values[use].sum())
                hrs = (day_idx >= a) & (day_idx < b) & valid
                res_h = y0 - pred
                parts = {"night_00_06": (HOURS.hour.values < 6), "day_06_18": (HOURS.hour.values >= 6) & (HOURS.hour.values < 18),
                         "evening_18_24": (HOURS.hour.values >= 18)}
                diff_total = float(np.nansum(res_h[hrs]))
                share = {k: r(100 * float(np.nansum(res_h[hrs & v])) / diff_total, 0) if diff_total else None
                         for k, v in parts.items()}
                mzs = float(np.mean(np.abs(z[use])))
                if len(use) == 0 or (len(use) == 1 and mzs < 5):
                    continue  # single days need very strong evidence
                half = 1.96 * s_d * math.sqrt(len(use))
                same_month = (HOURS.month.values == HOURS[a * 24].month)
                typical_t = float(temp[same_month & ~((day_idx >= a) & (day_idx < b))].mean())
                wk = int(sum(1 for d in use if (HOURS[d * 24].dayofweek < 5)))
                conf = "medium"
                if len(use) >= 3 and mzs >= 4 and g14_hourly_pass:
                    conf = "high"
                if not g14_hourly_pass or (len(use) == 1 and mzs < 4):
                    conf = "low"
                anomalies.append({
                    "kind": sign, "start": fmt_day(a), "end": fmt_day(b - 1), "days": int(len(use)),
                    "weekdays": wk, "weekend_days": int(len(use) - wk),
                    "actual_total": r(act, 0), "expected_total": r(exp_, 0),
                    "difference": r(act - exp_, 0), "difference_pct": r(100 * (act - exp_) / exp_, 1) if exp_ > 0 else None,
                    "expected_range_low": r(max(exp_ - half, 0), 0), "expected_range_high": r(exp_ + half, 0),
                    "mean_abs_z": r(mzs, 1), "mean_temp_c": r(daily.t.values[use].mean(), 1),
                    "typical_month_temp_c": r(typical_t, 1), "difference_share_by_time_pct": share,
                    "confidence": conf})
        anomalies.sort(key=lambda x: -abs(x["difference"] or 0))
        anomalies = anomalies[:8]
        for i, a in enumerate(anomalies):
            a["id"] = f"{meter[:2].upper()}-A{i + 1}"
            a["questions"] = anomaly_questions(a, meter)

    data_quality = []
    for kind, a, b in sorted(dq, key=lambda x: x[1]):
        data_quality.append({"kind": kind, "start": fmt_ts(a), "end": fmt_ts(b - 1), "hours": int(b - a),
                             "note": {"missing_data": "No readings recorded.",
                                      "zero_readings": "Electricity reading of exactly zero; usually a meter or logging fault.",
                                      "extended_zero_readings": "Thermal meter reads zero for a week or more; may be a seasonal shutdown or a fault.",
                                      "flatline": "Identical non-zero value repeated; usually an estimated or stuck reading."}[kind]})
    data_quality = data_quality[:25]

    daily_out = {
        "start": fmt_day(0),
        "actual": [sig(v, 4) if rh >= ANOMALY["min_day_hours"] else None
                   for v, rh in zip(daily.actual.values, daily.rec_h.values)],
        "baseline": [sig(v, 4) if (has_baseline and rh >= ANOMALY["min_day_hours"]) else None
                     for v, rh in zip(daily.base.values, daily.rec_h.values)],
        "temp_c": [r(v, 1) for v in daily.t.values],
        "quality_flag": [int(e > 0) for e in daily.excl.values],
    }
    return {
        "unit": unit, "stats": stats, "temperature_sensitivity": sens, "monthly": monthly,
        "profile_24h": profile, "daily": daily_out,
        "baseline_fit": {
            "method": "TOWT regression (168 time-of-week terms + piecewise-linear temperature, "
                      "separate occupied/unoccupied slopes), leave-one-month-out cross-fitted.",
            "available": bool(has_baseline),
            "usable_for_anomalies": bool(baseline_usable),
            "cv_rmse_hourly_pct": r(cv_h, 1), "nmbe_hourly_pct": r(nmbe_h, 2),
            "cv_rmse_daily_pct": r(cv_d, 1), "nmbe_daily_pct": r(nmbe_d, 2),
            "cv_rmse_monthly_pct": r(cv_m, 1), "nmbe_monthly_pct": r(nmbe_m, 2),
            "g14_hourly_pass": bool(g14_hourly_pass), "g14_monthly_pass": bool(g14_monthly_pass),
            "daily_residual_sd_robust": r(s_d, 1) if s_d else None,
            "hours_used": n_valid},
        "anomalies": anomalies, "data_quality": data_quality,
    }


def anomaly_questions(a: dict, meter: str) -> list:
    q = []
    share = a.get("difference_share_by_time_pct") or {}
    higher = a["kind"] == "higher_than_expected"
    t_shift = (a.get("mean_temp_c") or 0) - (a.get("typical_month_temp_c") or 0)
    if higher:
        if (share.get("night_00_06") or 0) >= 40:
            q.append("Most of the extra use is between midnight and 06:00 — was equipment, lighting or HVAC left running out of hours?")
        if a["weekend_days"] >= max(1, a["days"] // 2):
            q.append("The period is mostly weekend days — were there events, extended opening or schedule overrides?")
        if abs(t_shift) >= 4:
            q.append(f"Outdoor temperature was {abs(t_shift):.1f} degC {'warmer' if t_shift > 0 else 'colder'} than usual for the month — did heating/cooling respond more than expected (setpoints, simultaneous heating and cooling)?")
        q.append("Were there changes in occupancy, opening hours, equipment or building use during this period?")
        q.append("Could this be a metering issue (meter swap, recalibration, estimated reads)? Check the meter log.")
    else:
        q.append("Was the building partly closed or less occupied (holiday, term break, refurbishment)?")
        q.append("Were any systems switched off, or was load moved to another meter?")
        q.append("Could readings be under-recorded (meter or data-logging fault)?")
    if meter in ("chilledwater", "steam", "hotwater"):
        q.append("Were there plant changes (chiller/boiler staging, district heating/cooling supply) at this time?")
    return q[:4]


# ----------------------------------------------------------------------------- peers
def building_intensities(train: pd.DataFrame, meta: pd.DataFrame) -> pd.DataFrame:
    """Annualised intensity for every building-meter (quick, vectorised), used for peer groups."""
    g = train.copy()
    g["meter_name"] = g.meter.map(METER_NAMES)
    g = g.merge(meta[["building_id", "site_id", "primary_use", "square_feet"]], on="building_id")
    g["factor"] = [unit_info(s, m)["factor_to_kwh"] or 1.0 for s, m in zip(g.site_id, g.meter_name)] \
        if len(g) < 200000 else 1.0
    if len(g) >= 200000:  # faster path for full dataset
        fac = {(s, m): (unit_info(s, m)["factor_to_kwh"] or 1.0)
               for s in range(16) for m in METER_NAMES.values()}
        g["factor"] = [fac[(s, m)] for s, m in zip(g.site_id.values, g.meter_name.values)]
    g["y"] = g.meter_reading * g.factor
    is_e = g.meter == 0
    g = g[~(is_e & (g.y <= 0))]
    agg = g.groupby(["building_id", "meter_name"]).agg(mean_y=("y", "mean"), n=("y", "size")).reset_index()
    agg = agg.merge(meta[["building_id", "site_id", "primary_use", "square_feet"]], on="building_id")
    agg["coverage"] = agg.n / N_HOURS
    agg["area_m2"] = agg.square_feet * SQFT_TO_M2
    agg["intensity"] = agg.mean_y * N_HOURS / agg.area_m2
    agg["unit_status"] = [unit_info(s, m)["status"] for s, m in zip(agg.site_id, agg.meter_name)]
    return agg


def peer_comparison(bid: int, meter: str, value: float, inten: pd.DataFrame, meta_row) -> dict:
    site, use, area = int(meta_row.site_id), meta_row.primary_use, float(meta_row.square_feet * SQFT_TO_M2)
    unit = unit_info(site, meter)
    pool = inten[(inten.meter_name == meter) & (inten.coverage >= 0.8) & (inten.building_id != bid)]
    groups = [
        ("same site, same primary use", pool[(pool.site_id == site) & (pool.primary_use == use)], ["Same weather and metering unit."]),
        ("same primary use, other sites, similar floor area (1/3x to 3x)",
         pool[(pool.primary_use == use) & pool.unit_status.isin(["verified", "converted"]) &
              (pool.area_m2 >= area / 3) & (pool.area_m2 <= area * 3)],
         ["Peers are in different climates, so heating/cooling needs differ."]),
        ("same site, any primary use", pool[pool.site_id == site], ["Peers have different uses, so occupancy and equipment differ."]),
    ]
    if value is None or unit["status"] == "native":
        return {"available": False, "reason": "No comparable intensity for this meter (insufficient data or non-energy unit)."}
    if unit["status"] == "unverified":
        groups = [groups[0], groups[2]]  # never mix unverified units across sites
    for name, grp, lim in groups:
        if len(grp) >= 5:
            vals = grp.intensity.values
            pct = float((vals < value).mean() * 100)
            near = grp.assign(d=(np.log(grp.area_m2) - math.log(area)).abs()).nsmallest(8, "d")
            return {
                "available": True, "group_definition": name, "n_peers": int(len(grp)),
                "metric": f"Annualised {METER_LABELS[meter].lower()} use per m2 of floor area ({unit['display_unit']}/m2/yr)",
                "value": r(value, 1), "peer_median": r(np.median(vals), 1),
                "peer_p25": r(np.percentile(vals, 25), 1), "peer_p75": r(np.percentile(vals, 75), 1),
                "percentile": r(pct, 0), "difference_vs_median_pct": r(100 * (value - np.median(vals)) / np.median(vals), 1),
                "peer_values": [r(v, 1) for v in np.sort(vals)][:200],
                "nearest_peers": [{"building_id": int(b), "intensity": r(v, 1), "floor_area_m2": r(a_, 0)}
                                  for b, v, a_ in zip(near.building_id, near.intensity, near.area_m2)],
                "limitations": lim + [
                    "Normalised by floor area only; occupancy, opening hours and equipment are not in the dataset.",
                    "Based on one year (2016) of readings with gaps filled by the average.",
                    f"Metering unit status: {unit['status']}."]}
    return {"available": False, "reason": "Fewer than 5 comparable buildings with 80 % data coverage."}


# ----------------------------------------------------------------------------- selection
def select_buildings(train, meta, n=16, must_include=None):
    must_include = list(must_include or [])
    e = train[train.meter == 0].groupby("building_id").agg(n=("meter_reading", "size"),
                                                           zeros=("meter_reading", lambda s: (s == 0).mean()))
    m = train.groupby("building_id").meter.nunique().rename("n_meters")
    cand = meta.set_index("building_id").join(e, how="inner").join(m)
    cand = cand[(cand.n / N_HOURS >= 0.9) & (cand.zeros < 0.05)].reset_index()
    cand = cand.sort_values(["n_meters", "n"], ascending=False)
    chosen = [b for b in must_include if b in set(meta.building_id)]
    uses = list(cand.primary_use.value_counts().index)
    sites_used = {}
    while len(chosen) < n and len(cand):
        progressed = False
        for u in uses:
            pool = cand[(cand.primary_use == u) & ~cand.building_id.isin(chosen)]
            if pool.empty:
                continue
            pool = pool.assign(site_n=pool.site_id.map(lambda s: sites_used.get(s, 0))).sort_values(
                ["site_n", "n_meters", "n"], ascending=[True, False, False])
            b = int(pool.iloc[0].building_id)
            chosen.append(b)
            sites_used[int(pool.iloc[0].site_id)] = sites_used.get(int(pool.iloc[0].site_id), 0) + 1
            progressed = True
            if len(chosen) >= n:
                break
        if not progressed:
            break
    return chosen[:n]


# ----------------------------------------------------------------------------- export
def build_assistant_data(data_dir: str, building_ids=None, n_buildings=16, synthetic=False,
                         gbm_daily=None):
    train, meta, weather = load_raw(data_dir)
    wx = local_weather(weather)
    unit_log = resolve_units(train, meta)
    if building_ids is None:
        building_ids = select_buildings(train, meta, n_buildings)
    inten = building_intensities(train, meta)
    buildings = {}
    for bid in building_ids:
        row = meta[meta.building_id == bid].iloc[0]
        site = int(row.site_id)
        area_m2 = float(row.square_feet * SQFT_TO_M2)
        temp = wx[site]["temp"] if site in wx else np.full(N_HOURS, 15.0)
        bt = train[train.building_id == bid]
        meters = {}
        for mcode, g in bt.groupby("meter"):
            mname = METER_NAMES[int(mcode)]
            y = g.drop_duplicates("timestamp").set_index("timestamp").meter_reading.reindex(HOURS).values.astype(float)
            res = analyse_meter(y, temp, site, mname, area_m2)
            res["peers"] = peer_comparison(bid, mname, res["stats"]["intensity_per_m2"], inten, row)
            if gbm_daily is not None and (bid, int(mcode)) in gbm_daily:
                res["daily"]["baseline_gbm"] = gbm_daily[(bid, int(mcode))]
            meters[mname] = res
        missing_meta = [k for k in ("year_built", "floor_count") if pd.isna(row[k])]
        buildings[str(bid)] = {
            "profile": {
                "building_id": int(bid), "site_id": site, "primary_use": row.primary_use,
                "square_feet": int(row.square_feet), "floor_area_m2": r(area_m2, 0),
                "year_built": None if pd.isna(row.year_built) else int(row.year_built),
                "floor_count": None if pd.isna(row.floor_count) else int(row.floor_count),
                "meters": list(meters.keys()), "missing_metadata": missing_meta,
                "site_weather": {"mean_temp_c": r(np.mean(temp), 1), "min_temp_c": r(np.min(temp), 1),
                                 "max_temp_c": r(np.max(temp), 1),
                                 "raw_missing_hours": wx.get(site, {}).get("raw_missing", None)},
                "data_period": {"start": YEAR_START[:10], "end": YEAR_END[:10]}},
            "meters": meters}
    return {
        "meta": {
            "dataset": "ASHRAE Great Energy Predictor III (Kaggle): train.csv, building_metadata.csv, weather_train.csv"
                       if not synthetic else "SYNTHETIC demo data in ASHRAE format (not real buildings)",
            "synthetic": bool(synthetic), "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pipeline_version": PIPELINE_VERSION, "period": {"start": YEAR_START[:10], "end": YEAR_END[:10]},
            "n_buildings_in_dataset": int(meta.building_id.nunique()),
            "methods": {
                "units": "Kaggle units per site/meter from the Building Data Genome 2 wiki, converted to kWh where a factor exists "
                         "and the converted values pass a plausibility check against kWh-as-supplied sites (within 3x of their median); "
                         "otherwise readings are shown as supplied and marked unverified.",
                "weather_alignment": "Weather timestamps shifted from UTC to site-local time with per-site offsets.",
                "baseline": "LBNL Time-Of-Week-and-Temperature regression, leave-one-month-out cross-fitted.",
                "fit_quality": "ASHRAE Guideline 14 CV(RMSE) and NMBE on out-of-sample predictions "
                               "(hourly <=30 % / +-10 %, monthly <=15 % / +-5 %).",
                "anomalies": f"Daily residual robust z-score >= {ANOMALY['z']} and difference >= {int(ANOMALY['min_rel'] * 100)} %, "
                             "days with >= 20 valid hours, consecutive days merged (1-day gap).",
                "expected_range": "Expected total +- 1.96 x robust daily residual SD x sqrt(days); approximate (ignores autocorrelation).",
                "peers": "Same meter, >= 80 % coverage; same site and use first, then same use at other sites "
                         "(verified/converted kWh only, floor area within 1/3x-3x), then same site any use; needs >= 5 peers.",
                "data_quality": f"Missing runs >= {DQ['missing_run_h']} h, electricity zero runs >= {DQ['elec_zero_run_h']} h, "
                                f"flat-lines >= {DQ['flatline_run_h']} h, thermal zero runs >= {DQ['thermal_zero_run_h']} h.",
            },
            "thresholds": {"g14": G14, "anomaly": ANOMALY, "data_quality": DQ, "temp_knots_c": TEMP_KNOTS_C},
            "unit_checks": unit_log,
        },
        "buildings": buildings,
    }


def save_json(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
