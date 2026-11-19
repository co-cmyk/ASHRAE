"use client";
// Hand-built SVG charts (no chart library): thin marks, recessive grid, hover tooltips,
// legends with labels so identity never relies on colour alone.
import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, dayIndex, num } from "../lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function niceStep(max, count) {
  const raw = max / Math.max(count, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

function ticks(max, count = 4) {
  if (!max || max <= 0) return [0, 1];
  const step = niceStep(max, count);
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function compact(v) {
  if (Math.abs(v) >= 1e6) return `${num(v / 1e6, v % 1e6 ? 1 : 0)}M`;
  if (Math.abs(v) >= 1e4) return `${num(v / 1e3, 0)}K`;
  return num(v, v < 10 && v % 1 ? 1 : 0);
}

function linePath(values, x, y) {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Render SVGs at their real pixel width so text stays legible at any panel size. */
function useWidth(fallback = 440) {
  const box = useRef(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = Math.round(entries[0].contentRect.width);
      if (cw > 0) setW(Math.max(300, cw));
    });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  return [box, w];
}

function useHover() {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  return { ref, hover, setHover };
}

function Legend({ items }) {
  return (
    <div className="legend" role="list">
      {items.map((it) => (
        <span key={it.label} className="legend-item" role="listitem">
          {it.kind === "band" ? (
            <span className="key-band" style={{ background: it.color }} />
          ) : it.kind === "dot" ? (
            <span className="key-dot" style={{ background: it.color }} />
          ) : (
            <span className="key-line" style={{ background: it.color }} />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ hover, children }) {
  if (!hover) return null;
  const left = Math.min(Math.max(hover.px, 70), (hover.w || 600) - 70);
  return (
    <div className="tooltip" style={{ left, top: hover.py }} role="status">
      {children}
    </div>
  );
}

// ----------------------------------------------------------------------------- daily
export function DailyChart({ meter, unit, focus }) {
  const [box, W] = useWidth();
  const H = 250, L = 46, R = 8, T = 14, B = 26;
  const d = meter.daily;
  const n = d.actual.length;
  const showGbm = Array.isArray(d.baseline_gbm) && d.baseline_gbm.some((v) => v !== null);
  const { ref, hover, setHover } = useHover();
  const [min, max] = useMemo(() => {
    const vals = [...d.actual, ...d.baseline].filter((v) => v !== null);
    return [Math.min(...vals), Math.max(1, ...vals)];
  }, [d]);
  // line chart: zoom the y-axis when all values sit far above zero (baseline label says so)
  const yMinRaw = min > 0.45 * max ? min * 0.9 : 0;
  const stepY = niceStep(max - yMinRaw, 4);
  const yMin = Math.floor(yMinRaw / stepY) * stepY;
  const yt = [];
  for (let v = yMin; v <= max + stepY * 0.999; v += stepY) yt.push(v);
  const yMax = yt[yt.length - 1];
  const x = (i) => L + (i * (W - L - R)) / Math.max(n - 1, 1);
  const y = (v) => T + (H - T - B) * (1 - (Math.max(v, yMin) - yMin) / (yMax - yMin || 1));
  const step = (W - L - R) / Math.max(n - 1, 1);
  const focusSet = new Set(focus?.anomalyIds ?? []);
  const period = focus?.period;

  function move(e) {
    const rect = ref.current.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((sx - L) / (W - L - R)) * (n - 1));
    if (i < 0 || i >= n) return setHover(null);
    setHover({ i, px: (x(i) / W) * rect.width, py: 8, w: rect.width });
  }

  const h = hover ? hover.i : null;
  const flagged = h !== null ? meter.anomalies.find((a) => h >= dayIndex(d.start, a.start) && h <= dayIndex(d.start, a.end)) : null;
  return (
    <figure className="chart">
      <Legend
        items={[
          { label: `Actual (${unit}/day)`, color: "var(--series-1)" },
          { label: "Expected (weather-adjusted baseline)", color: "var(--series-2)" },
          ...(showGbm ? [{ label: "Leaderboard model (out-of-fold)", color: "var(--series-3)" }] : []),
          { label: "Higher than expected", color: "var(--flag-high)", kind: "band" },
          { label: "Lower than expected", color: "var(--flag-low)", kind: "band" },
        ]}
      />
      <div className="chart-box" ref={box}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily ${unit} actual versus expected`} onMouseMove={move} onMouseLeave={() => setHover(null)}>
          {yt.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
              <text x={L - 6} y={y(v) + 4} className="tick" textAnchor="end">{compact(v)}</text>
            </g>
          ))}
          {meter.anomalies.map((a) => {
            const i0 = dayIndex(d.start, a.start), i1 = dayIndex(d.start, a.end);
            const on = focusSet.has(a.id);
            return (
              <g key={a.id}>
                <rect x={x(i0) - step / 2} y={T} width={Math.max(x(i1) - x(i0) + step, 3)} height={H - T - B}
                  fill={a.kind === "higher_than_expected" ? "var(--flag-high)" : "var(--flag-low)"} opacity={on || !focusSet.size ? 1 : 0.45}
                  className={on ? "band-focus" : ""} />
                {on && <text x={x(i0)} y={T + 11} className="band-label">{a.kind === "higher_than_expected" ? "↑" : "↓"} {a.id}</text>}
              </g>
            );
          })}
          {period && (
            <rect x={x(Math.max(0, dayIndex(d.start, period.start))) - step / 2} y={T} height={H - T - B}
              width={Math.max(0, x(Math.min(n - 1, dayIndex(d.start, period.end))) - x(Math.max(0, dayIndex(d.start, period.start))) + step)}
              className="period-band" />
          )}
          <line x1={L} x2={W - R} y1={y(yMin)} y2={y(yMin)} className="axis" />
          {yMin > 0 && <text x={L + 4} y={y(yMin) - 4} className="tick">axis starts at {compact(yMin)}</text>}
          {MONTHS.map((m, k) => {
            const i = dayIndex(d.start, `2016-${String(k + 1).padStart(2, "0")}-01`);
            if (W < 420 && k % 2) return null;
            return <text key={m} x={x(i) + 2} y={H - 8} className="tick">{m}</text>;
          })}
          <path d={linePath(d.baseline, x, y)} className="line" stroke="var(--series-2)" />
          {showGbm && <path d={linePath(d.baseline_gbm, x, y)} className="line thin" stroke="var(--series-3)" />}
          <path d={linePath(d.actual, x, y)} className="line" stroke="var(--series-1)" />
          {h !== null && (
            <g>
              <line x1={x(h)} x2={x(h)} y1={T} y2={H - B} className="crosshair" />
              {d.actual[h] !== null && <circle cx={x(h)} cy={y(d.actual[h])} r="4" fill="var(--series-1)" className="ring" />}
              {d.baseline[h] !== null && <circle cx={x(h)} cy={y(d.baseline[h])} r="4" fill="var(--series-2)" className="ring" />}
            </g>
          )}
        </svg>
        <Tooltip hover={hover}>
          {h !== null && (
            <>
              <strong>{addDays(d.start, h)}</strong>
              <div>Actual: {num(d.actual[h])} {unit}</div>
              <div>Expected: {num(d.baseline[h])} {unit}</div>
              {showGbm && <div>Leaderboard model: {num(d.baseline_gbm[h])} {unit}</div>}
              <div>Mean temperature: {num(d.temp_c[h], 1)} °C</div>
              {d.quality_flag[h] ? <div className="muted">Includes excluded readings</div> : null}
              {flagged && <div>Flagged: {flagged.id} ({flagged.confidence})</div>}
            </>
          )}
        </Tooltip>
      </div>
    </figure>
  );
}

// ----------------------------------------------------------------------------- monthly
function topRoundedBar(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function MonthlyChart({ meter, unit, focus }) {
  const [box, W] = useWidth();
  const H = 230, L = 46, R = 8, T = 12, B = 26;
  const rows = meter.monthly;
  const { ref, hover, setHover } = useHover();
  const max = Math.max(1, ...rows.map((r) => Math.max(r.actual ?? 0, r.baseline ?? 0)));
  const yt = ticks(max, 4);
  const yMax = yt[yt.length - 1];
  const slot = (W - L - R) / rows.length;
  const bw = slot - 2;
  const y = (v) => T + (H - T - B) * (1 - v / yMax);
  const inPeriod = (m) => focus?.period && `${m}-01` <= focus.period.end && `${m}-31` >= focus.period.start;
  return (
    <figure className="chart">
      <Legend items={[{ label: `Actual (${unit}/month)`, color: "var(--series-1)", kind: "band" }, { label: "Expected (baseline)", color: "var(--series-2)" }]} />
      <div className="chart-box" ref={box}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Monthly ${unit}`} onMouseLeave={() => setHover(null)}>
          {yt.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
              <text x={L - 6} y={y(v) + 4} className="tick" textAnchor="end">{compact(v)}</text>
            </g>
          ))}
          {rows.map((r, k) => {
            const x0 = L + k * slot + 1;
            const v = r.actual ?? 0;
            const partial = (r.coverage_pct ?? 0) < 90;
            return (
              <g key={r.month} onMouseEnter={() => { const rect = ref.current.getBoundingClientRect(); setHover({ k, px: ((x0 + bw / 2) / W) * rect.width, py: 8, w: rect.width }); }}>
                <rect x={x0 - 1} y={T} width={slot} height={H - T - B} fill="transparent" />
                <path d={topRoundedBar(x0, y(v), bw, Math.max(0, y(0) - y(v)), 4)} fill="var(--series-1)" opacity={partial ? 0.45 : inPeriod(r.month) || !focus?.period ? 1 : 0.55} />
                {r.baseline !== null && <line x1={x0 + 3} x2={x0 + bw - 3} y1={y(r.baseline)} y2={y(r.baseline)} stroke="var(--series-2)" strokeWidth="3" strokeLinecap="round" />}
                <text x={x0 + bw / 2} y={H - 8} className="tick" textAnchor="middle">{MONTHS[k]}</text>
              </g>
            );
          })}
          <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="axis" />
        </svg>
        <Tooltip hover={hover}>
          {hover && (
            <>
              <strong>{rows[hover.k].month}</strong>
              <div>Actual: {num(rows[hover.k].actual)} {unit}</div>
              <div>Expected: {num(rows[hover.k].baseline)} {unit}</div>
              <div>Difference: {rows[hover.k].difference_pct === null ? "n/a" : `${rows[hover.k].difference_pct > 0 ? "+" : ""}${num(rows[hover.k].difference_pct, 1)}%`}</div>
              <div>Coverage: {num(rows[hover.k].coverage_pct, 1)}%{(rows[hover.k].coverage_pct ?? 0) < 90 ? " (partial month)" : ""}</div>
              <div>Mean temperature: {num(rows[hover.k].mean_temp_c, 1)} °C</div>
            </>
          )}
        </Tooltip>
      </div>
    </figure>
  );
}

// ----------------------------------------------------------------------------- 24h profile
export function ProfileChart({ meter, unit }) {
  const [box, W] = useWidth();
  const H = 220, L = 46, R = 8, T = 12, B = 26;
  const { weekday, weekend } = meter.profile_24h;
  const { ref, hover, setHover } = useHover();
  const max = Math.max(1, ...weekday.filter((v) => v !== null), ...weekend.filter((v) => v !== null));
  const yt = ticks(max, 4);
  const yMax = yt[yt.length - 1];
  const x = (i) => L + (i * (W - L - R)) / 23;
  const y = (v) => T + (H - T - B) * (1 - v / yMax);
  function move(e) {
    const rect = ref.current.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((sx - L) / (W - L - R)) * 23);
    if (i < 0 || i > 23) return setHover(null);
    setHover({ i, px: (x(i) / W) * rect.width, py: 8, w: rect.width });
  }
  const h = hover?.i ?? null;
  return (
    <figure className="chart">
      <Legend items={[{ label: `Weekday mean (${unit}/h)`, color: "var(--series-1)" }, { label: `Weekend mean (${unit}/h)`, color: "var(--series-2)" }]} />
      <div className="chart-box" ref={box}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Average daily profile" onMouseMove={move} onMouseLeave={() => setHover(null)}>
          {yt.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
              <text x={L - 6} y={y(v) + 4} className="tick" textAnchor="end">{compact(v)}</text>
            </g>
          ))}
          {[0, 3, 6, 9, 12, 15, 18, 21, 23].map((i) => (
            <text key={i} x={x(i)} y={H - 8} className="tick" textAnchor="middle">{String(i).padStart(2, "0")}:00</text>
          ))}
          <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="axis" />
          <path d={linePath(weekend, x, y)} className="line" stroke="var(--series-2)" />
          <path d={linePath(weekday, x, y)} className="line" stroke="var(--series-1)" />
          {h !== null && (
            <g>
              <line x1={x(h)} x2={x(h)} y1={T} y2={H - B} className="crosshair" />
              {weekday[h] !== null && <circle cx={x(h)} cy={y(weekday[h])} r="4" fill="var(--series-1)" className="ring" />}
              {weekend[h] !== null && <circle cx={x(h)} cy={y(weekend[h])} r="4" fill="var(--series-2)" className="ring" />}
            </g>
          )}
        </svg>
        <Tooltip hover={hover}>
          {h !== null && (
            <>
              <strong>{String(h).padStart(2, "0")}:00–{String(h).padStart(2, "0")}:59</strong>
              <div>Weekday: {num(weekday[h], 1)} {unit}/h</div>
              <div>Weekend: {num(weekend[h], 1)} {unit}/h</div>
            </>
          )}
        </Tooltip>
      </div>
    </figure>
  );
}

// ----------------------------------------------------------------------------- peers
export function PeerStrip({ meter, unit, buildingId }) {
  const p = meter.peers;
  const { ref, hover, setHover } = useHover();
  const [box, W] = useWidth();
  if (!p.available) return <p className="muted">Peer comparison not available: {p.reason}</p>;
  const vals = (p.peer_values ?? []).filter((v) => v !== null);
  const H = 130, L = 20, R = 20;
  const lo = Math.min(...vals, p.value), hi = Math.max(...vals, p.value);
  const pad = (hi - lo) * 0.06 || 1;
  const x = (v) => L + ((v - lo + pad) / (hi - lo + 2 * pad)) * (W - L - R);
  const cy = 62;
  return (
    <figure className="chart">
      <Legend items={[{ label: `Building ${buildingId}`, color: "var(--series-1)", kind: "dot" }, { label: `Peers (${p.n_peers})`, color: "var(--muted)", kind: "dot" }, { label: "Middle half of peers", color: "var(--band)", kind: "band" }]} />
      <div className="chart-box" ref={box}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Peer comparison, ${p.metric}`} onMouseLeave={() => setHover(null)}>
          <rect x={x(p.peer_p25)} y={cy - 22} width={Math.max(2, x(p.peer_p75) - x(p.peer_p25))} height="44" fill="var(--band)" rx="4" />
          <line x1={L} x2={W - R} y1={cy + 30} y2={cy + 30} className="axis" />
          <line x1={x(p.peer_median)} x2={x(p.peer_median)} y1={cy - 26} y2={cy + 26} stroke="var(--text-secondary)" strokeWidth="2" />
          <text x={x(p.peer_median)} y={cy - 30} className="tick" textAnchor={x(p.peer_median) < W * 0.2 ? "start" : x(p.peer_median) > W * 0.8 ? "end" : "middle"}>peer median {num(p.peer_median, 1)}</text>
          {vals.map((v, k) => (
            <circle key={k} cx={x(v)} cy={cy + ((k % 5) - 2) * 6} r="4" fill="var(--muted)" className="ring"
              onMouseEnter={() => { const rect = ref.current.getBoundingClientRect(); setHover({ v, px: (x(v) / W) * rect.width, py: 4, w: rect.width }); }} />
          ))}
          <circle cx={x(p.value)} cy={cy} r="7" fill="var(--series-1)" className="ring" />
          <text x={x(p.value)} y={cy + 48} className="tick strong" textAnchor={x(p.value) < W * 0.25 ? "start" : x(p.value) > W * 0.75 ? "end" : "middle"}>
            this building {num(p.value, 1)} {unit}/m²/yr
          </text>
        </svg>
        <Tooltip hover={hover}>{hover && <div>Peer: {num(hover.v, 1)} {unit}/m²/yr</div>}</Tooltip>
      </div>
      <figcaption className="muted">Peers range {num(lo, 1)}–{num(hi, 1)} {unit}/m²/yr · {p.group_definition} · {ordinalText(p.percentile)} percentile.</figcaption>
    </figure>
  );
}

function ordinalText(n) {
  const v = Math.round(n ?? 0);
  const s = ["th", "st", "nd", "rd"], r = v % 100;
  return `${v}${s[(r - 20) % 10] || s[r] || s[0]}`;
}
