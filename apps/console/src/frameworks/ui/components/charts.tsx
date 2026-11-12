/**
 * SVG charts for the console: one y-axis, a tooltip on every chart, a legend for two or more
 * series, and a table view next to each chart. Entry animations run once and respect
 * prefers-reduced-motion.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Table2, BarChart3 } from "lucide-react";
import type { ParetoRow } from "../../../entities/models";

export interface Series<T> {
  key: string;
  label: string;
  color: string; // a CSS var, e.g. "var(--s1)"
  get: (d: T) => number | null;
}

const PAD = { l: 48, r: 12, t: 12, b: 26 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** eases a number toward its target (easeOutCubic); jumps straight there under reduced motion */
export function useCountUp(target: number, ms = 700) {
  const [v, setV] = useState(reducedMotion() ? target : 0);
  const from = useRef(v);
  useEffect(() => {
    if (reducedMotion()) return setV(target);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - p) ** 3;
      const x = a + (target - a) * e;
      setV(x);
      from.current = x;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** clean ticks: steps of 1/2/2.5/5 × 10^k, ~4 intervals */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

export const compact = (v: number) =>
  Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${+(v / 1e3).toFixed(1)}K` : v.toLocaleString();

/** monotone cubic (Fritsch–Carlson): smooth, but never overshoots the data the way a spline would */
function monotonePath(pts: [number, number][]) {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const m = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / (dx[i] || 1));
  // tangent at each point: the end slopes at the ends, flat at a peak or trough, else the average slope
  const t = pts.map((_, i) => {
    if (i === 0) return m[0];
    if (i === n - 1) return m[n - 2];
    if (m[i - 1] * m[i] <= 0) return 0;
    return (m[i - 1] + m[i]) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + h * t[i]).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - h * t[i + 1]).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

function Tip({ x, y, width, title, rows, keyShape }: { x: number; y: number; width: number; title: string; rows: { color: string; value: string; label: string }[]; keyShape: "line" | "rect" }) {
  const left = Math.min(Math.max(0, x + 14), width - 190);
  return (
    <div className="tip" style={{ left, top: Math.max(0, y) }} role="status">
      <div className="t">{title}</div>
      {rows.map((r) => (
        <div className="r" key={r.label}>
          {keyShape === "line" ? <i className="key-line" style={{ background: r.color }} /> : <i className="key-rect" style={{ background: r.color }} />}
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items, shape }: { items: { label: string; color: string; shape?: "line" | "rect" | "dash" }[]; shape: "line" | "rect" }) {
  return (
    <div className="legend">
      {items.map((i) => {
        const s = i.shape ?? shape;
        return (
          <span key={i.label}>
            {s === "line" ? <i className="key-line" style={{ background: i.color }} /> : s === "dash" ? <i className="key-dash" style={{ borderColor: i.color }} /> : <i className="key-rect" style={{ background: i.color }} />}
            {i.label}
          </span>
        );
      })}
    </div>
  );
}

interface TimeProps<T> {
  data: T[];
  x: (d: T) => number;
  xLabel: (t: number) => string;
  series: Series<T>[];
  format: (v: number) => string;
  height?: number;
  loading?: boolean;
}

function xTickIndexes(n: number, maxLabels = 6) {
  const every = Math.max(1, Math.ceil(n / maxLabels));
  return Array.from({ length: n }, (_, i) => i).filter((i) => (n - 1 - i) % every === 0);
}

const roundedTop = (xl: number, yTop: number, w: number, h: number, r: number) =>
  `M${xl},${yTop + h} V${yTop + r} Q${xl},${yTop} ${xl + r},${yTop} H${xl + w - r} Q${xl + w},${yTop} ${xl + w},${yTop + r} V${yTop + h} Z`;

/** stacked columns over time (e.g. requests by outcome) */
export function StackedColumns<T>({ data, x, xLabel, series, format, height = 220, loading }: TimeProps<T>) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const totals = data.map((d) => series.reduce((s, se) => s + (se.get(d) ?? 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1];
  // small fractional values (dollars) need the caller's formatter, or 0.0015 and 0.002 both print "0.002"
  const fractional = ticks.some((t) => !Number.isInteger(t));
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const band = iw / Math.max(1, n);
  const bw = Math.min(24, Math.max(3, band * 0.62));

  return (
    <div ref={ref} className={`chart${loading ? " loading" : ""}`}>
      <svg width={width} height={height} role="img" aria-label={`stacked columns: ${series.map((s) => s.label).join(", ")}`}>
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "base-line" : "grid-line"} x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end">{fractional ? format(t) : compact(t)}</text>
            </g>
          ))}
          {xTickIndexes(n).map((i) => (
            <text key={i} x={PAD.l + band * i + band / 2} y={height - 6} textAnchor="middle">{xLabel(x(data[i]))}</text>
          ))}
        </g>
        {hover !== null && <rect className="hover-band" x={PAD.l + band * hover} y={PAD.t} width={band} height={ih} rx={4} />}
        {data.map((d, i) => {
          const cx = PAD.l + band * i + band / 2;
          let acc = 0;
          const segs = series.map((s) => ({ s, v: s.get(d) ?? 0 })).filter((p) => p.v > 0);
          return (
            <g key={i} className="anim-grow-y" style={{ animationDelay: `${Math.min(i * 18, 500)}ms`, opacity: hover === null || hover === i ? 1 : 0.4 }}>
              {segs.map((p, j) => {
                const y0 = y(acc);
                acc += p.v;
                const y1 = y(acc);
                const isTop = j === segs.length - 1;
                const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
                const h = Math.max(0, y0 - y1 - gap);
                return <path key={p.s.key} d={roundedTop(cx - bw / 2, y1, bw, h, isTop ? Math.min(4, h) : 0)} fill={p.s.color} />;
              })}
            </g>
          );
        })}
        {/* hit targets: the full band, bigger than the mark */}
        {data.map((_, i) => (
          <rect
            key={i}
            x={PAD.l + band * i}
            y={PAD.t}
            width={band}
            height={ih}
            fill="transparent"
            tabIndex={0}
            aria-label={`${xLabel(x(data[i]))}: ${series.map((s) => `${s.label} ${format(s.get(data[i]) ?? 0)}`).join(", ")}`}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>
      {hover !== null && (
        <Tip
          x={PAD.l + band * hover + band / 2}
          y={8}
          width={width}
          title={`${xLabel(x(data[hover]))} · ${format(totals[hover])} total`}
          keyShape="rect"
          rows={[...series].reverse().map((s) => ({ color: s.color, value: format(s.get(data[hover]) ?? 0), label: s.label }))}
        />
      )}
    </div>
  );
}

/** smooth lines over time; nulls break the line. `area` adds a gradient wash (single series only). */
export function LineChart<T>({ data, x, xLabel, series, format, height = 220, loading, area }: TimeProps<T> & { area?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, "");
  const n = data.length;
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const vals = data.flatMap((d) => series.map((s) => s.get(d) ?? 0));
  const ticks = niceTicks(Math.max(...vals, 0));
  const top = ticks[ticks.length - 1];
  const px = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const py = (v: number) => PAD.t + ih - (v / top) * ih;

  const paths = series.map((s) => {
    const runs: [number, number][][] = [];
    let cur: [number, number][] = [];
    data.forEach((d, i) => {
      const v = s.get(d);
      if (v == null) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push([px(i), py(v)]);
    });
    if (cur.length) runs.push(cur);
    const last = [...data.keys()].reverse().find((i) => s.get(data[i]) != null);
    return { s, runs, last };
  });

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };

  return (
    <div ref={ref} className={`chart${loading ? " loading" : ""}`}>
      <svg width={width} height={height} role="img" aria-label={`line chart: ${series.map((s) => s.label).join(", ")}`}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.24} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "base-line" : "grid-line"} x1={PAD.l} x2={width - PAD.r} y1={py(t)} y2={py(t)} />
              <text x={PAD.l - 8} y={py(t) + 4} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {xTickIndexes(n).map((i) => (
            <text key={i} x={px(i)} y={height - 6} textAnchor="middle">{xLabel(x(data[i]))}</text>
          ))}
        </g>
        {area && paths[0] &&
          paths[0].runs.map((pts, k) => {
            const line = monotonePath(pts);
            const poly = `${line} L${pts[pts.length - 1][0]},${py(0)} L${pts[0][0]},${py(0)} Z`;
            return <path key={k} className="anim-fade" d={poly} fill={`url(#${gid}-${paths[0].s.key})`} />;
          })}
        {paths.map(({ s, runs }) =>
          runs.map((pts, k) => (
            <path key={`${s.key}${k}`} className="anim-draw" pathLength={1} d={monotonePath(pts)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          )),
        )}
        {/* end dots: r=4, 2px surface ring */}
        {paths.map(({ s, last }) =>
          last == null ? null : <circle key={s.key} className="anim-pop" cx={px(last)} cy={py(s.get(data[last])!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />,
        )}
        {hover !== null && (
          <g>
            <line className="crosshair" x1={px(hover)} x2={px(hover)} y1={PAD.t} y2={PAD.t + ih} />
            {series.map((s) => {
              const v = s.get(data[hover]);
              return v == null ? null : <circle key={s.key} className="hover-dot" cx={px(hover)} cy={py(v)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
            })}
          </g>
        )}
        <rect
          x={PAD.l}
          y={PAD.t}
          width={iw}
          height={ih}
          fill="transparent"
          tabIndex={0}
          aria-label="move to read values; use the table view for all values"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n - 1) - 1));
            if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? 0) + 1));
          }}
        />
      </svg>
      {hover !== null && (
        <Tip
          x={px(hover)}
          y={8}
          width={width}
          title={xLabel(x(data[hover]))}
          keyShape="line"
          rows={series.map((s) => {
            const v = s.get(data[hover]);
            return { color: s.color, value: v == null ? "–" : format(v), label: s.label };
          })}
        />
      )}
    </div>
  );
}


/**
 * Pareto: categories sorted by size (columns, share of total) with the running total (line).
 * Both are percentages of the same whole, so they share one 0–100% axis: no second y-scale.
 * The "vital few" (up to the bar that crosses 80%) are full strength; the rest are a lighter step.
 */
export function Pareto({ rows, unit, height = 250, color = "var(--s1)" }: { rows: ParetoRow[]; unit: string; height?: number; color?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = rows.length;
  const pad = { ...PAD, b: 40 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const y = (v: number) => pad.t + ih - v * ih;
  const band = iw / Math.max(1, n);
  const bw = Math.min(40, Math.max(6, band * 0.6));
  const cx = (i: number) => pad.l + band * i + band / 2;
  const vitalUntil = rows.findIndex((r) => r.cumulative >= 0.8);
  const vital = (i: number) => vitalUntil < 0 || i <= vitalUntil;
  const maxChars = Math.max(3, Math.floor(band / 6.5));
  const short = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
  const linePts = rows.map((r, i) => [cx(i), y(r.cumulative)] as [number, number]);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height} role="img" aria-label={`Pareto chart of ${unit}: ${rows.map((r) => `${r.label} ${pct(r.share)}`).join(", ")}`}>
        <g className="axis">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line className={t === 0 ? "base-line" : "grid-line"} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end">{pct(t)}</text>
            </g>
          ))}
          {rows.map((r, i) => (
            <text key={r.label} x={cx(i)} y={height - pad.b + 16} textAnchor="middle">
              <title>{r.label}</title>
              {short(r.label)}
            </text>
          ))}
        </g>
        {/* the 80% reference */}
        <line x1={pad.l} x2={width - pad.r} y1={y(0.8)} y2={y(0.8)} className="ref-line" />
        <text x={width - pad.r} y={y(0.8) - 5} textAnchor="end" className="ref-label">80%</text>
        {hover !== null && <rect className="hover-band" x={pad.l + band * hover} y={pad.t} width={band} height={ih} rx={4} />}
        {rows.map((r, i) => {
          const h = Math.max(r.count > 0 ? 2 : 0, y(0) - y(r.share));
          return (
            <path
              key={r.label}
              className="anim-grow-y"
              style={{ animationDelay: `${i * 60}ms`, opacity: hover === null || hover === i ? 1 : 0.45 }}
              d={roundedTop(cx(i) - bw / 2, y(0) - h, bw, h, Math.min(4, h))}
              fill={vital(i) ? color : `color-mix(in srgb, ${color} 32%, var(--surface))`}
            />
          );
        })}
        <path className="anim-draw anim-late" pathLength={1} d={monotonePath(linePts)} fill="none" stroke="var(--s2)" strokeWidth={2} strokeLinecap="round" />
        {linePts.map(([px, py], i) => (
          <circle key={i} className="anim-pop anim-late" cx={px} cy={py} r={hover === i ? 5 : 3.5} fill="var(--s2)" stroke="var(--surface)" strokeWidth={2} />
        ))}
        {rows.map((r, i) => (
          <rect
            key={r.label}
            x={pad.l + band * i}
            y={pad.t}
            width={band}
            height={ih + 24}
            fill="transparent"
            tabIndex={0}
            aria-label={`${r.label}: ${r.count} ${unit}, ${pct(r.share)} of total, ${pct(r.cumulative)} cumulative`}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>
      {hover !== null && (
        <Tip
          x={cx(hover)}
          y={8}
          width={width}
          title={rows[hover].label}
          keyShape="rect"
          rows={[
            { color: vital(hover) ? color : `color-mix(in srgb, ${color} 32%, var(--surface))`, value: `${rows[hover].count.toLocaleString()} ${unit}`, label: `${pct(rows[hover].share)} of total` },
            { color: "var(--s2)", value: pct(rows[hover].cumulative), label: "cumulative" },
          ]}
        />
      )}
      <Legend
        shape="rect"
        items={[
          { label: "Vital few (to 80%)", color },
          { label: "The rest", color: `color-mix(in srgb, ${color} 32%, var(--surface))` },
          { label: "Cumulative share", color: "var(--s2)", shape: "line" },
        ]}
      />
    </div>
  );
}

/** ranked horizontal bars, one series (slot 1), value at the tip */
export function HBars({ rows, format, color = "var(--s1)" }: { rows: { label: string; value: number; sub?: string }[]; format: (v: number) => string; color?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const longest = Math.max(...rows.map((r) => r.label.length), 4);
  const labelW = Math.min(Math.round(width * 0.38), longest * 7 + 12);
  const maxChars = Math.floor((labelW - 12) / 7);
  const short = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
  const valueW = 84;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const rowH = 32;
  const barH = 14;
  const track = Math.max(40, width - labelW - valueW);
  return (
    <div ref={ref} className="chart">
      <svg width={width} height={rows.length * rowH} role="img" aria-label="bar chart">
        {rows.map((r, i) => {
          const w = Math.max(r.value > 0 ? 2 : 0, (r.value / max) * track);
          const y = i * rowH + (rowH - barH) / 2;
          const rad = Math.min(4, w);
          const path = `M${labelW},${y} H${labelW + w - rad} Q${labelW + w},${y} ${labelW + w},${y + rad} V${y + barH - rad} Q${labelW + w},${y + barH} ${labelW + w - rad},${y + barH} H${labelW} Z`;
          return (
            <g key={r.label} opacity={hover === null || hover === i ? 1 : 0.5}>
              <rect x={labelW} y={y} width={track} height={barH} rx={4} fill="var(--surface-2)" />
              <text x={0} y={y + barH - 2} fill="var(--ink-2)" fontSize={12}>
                <title>{r.label}</title>
                {short(r.label)}
              </text>
              {w > 0 && <path className="anim-grow-x" style={{ animationDelay: `${i * 70}ms` }} d={path} fill={color} />}
              <text className="anim-fade" x={labelW + w + 6} y={y + barH - 2} fill="var(--ink)" fontSize={12} style={{ fontVariantNumeric: "tabular-nums" }}>{format(r.value)}</text>
              <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" tabIndex={0} aria-label={`${r.label}: ${format(r.value)}`}
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover].sub && (
        <Tip x={labelW + 20} y={hover * rowH + rowH} width={width} title={rows[hover].label} keyShape="rect"
          rows={[{ color, value: format(rows[hover].value), label: rows[hover].sub! }]} />
      )}
    </div>
  );
}

/** tall segmented bar: one whole split into ≤6 parts, share printed inside when it fits */
export function SegmentedBar({ parts, format }: { parts: { label: string; value: number; color: string; ink?: string }[]; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const live = parts.filter((p) => p.value > 0);
  const gaps = Math.max(0, live.length - 1) * 2;
  let x = 0;
  return (
    <div ref={ref} className="chart">
      <svg width={width} height={32} role="img" aria-label={live.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(", ")}>
        <g className="anim-grow-x">
          {live.map((p, i) => {
            const w = ((width - gaps) * p.value) / total;
            const share = `${Math.round((p.value / total) * 100)}%`;
            const fits = w > share.length * 7 + 14;
            const el = (
              <g key={p.label} opacity={hover === null || hover === i ? 1 : 0.55}>
                <rect x={x} y={0} width={w} height={32} rx={6} fill={p.color} />
                {fits && <text x={x + 10} y={20} fontSize={12} fontWeight={600} fill={p.ink ?? "#ffffff"}>{share}</text>}
                <rect x={x} y={0} width={w + 2} height={32} fill="transparent" tabIndex={0} aria-label={`${p.label}: ${format(p.value)} (${share})`}
                  onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
              </g>
            );
            x += w + 2;
            return el;
          })}
        </g>
      </svg>
      <Legend shape="rect" items={live.map((p) => ({ label: p.label, color: p.color }))} />
      {hover !== null && (
        <Tip x={20} y={38} width={width} title={live[hover].label} keyShape="rect"
          rows={[{ color: live[hover].color, value: format(live[hover].value), label: `${Math.round((live[hover].value / total) * 100)}% of model-served requests` }]} />
      )}
    </div>
  );
}

/** 12-point trend with a soft area, in the accent; the current point is marked */
export function Sparkline({ values, width = 132, height = 30 }: { values: (number | null)[]; width?: number; height?: number }) {
  const gid = useId().replace(/:/g, "");
  const v = values.map((x) => x ?? 0);
  const max = Math.max(...v, 0) || 1;
  const px = (i: number) => (v.length <= 1 ? width / 2 : (width - 6) * (i / (v.length - 1)) + 3);
  const py = (x: number) => height - 4 - (x / max) * (height - 8);
  const pts = v.map((x, i) => [px(i), py(x)] as [number, number]);
  const d = monotonePath(pts);
  return (
    <svg width={width} height={height} aria-hidden="true" className="spark">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {pts.length > 1 && <path className="anim-fade" d={`${d} L${pts[pts.length - 1][0]},${height} L${pts[0][0]},${height} Z`} fill={`url(#${gid})`} />}
      <path className="anim-draw" pathLength={1} d={d} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
      {v.length > 0 && <circle className="anim-pop anim-late" cx={px(v.length - 1)} cy={py(v[v.length - 1])} r={2.5} fill="var(--accent)" />}
    </svg>
  );
}

/** a chart panel with an always-available table view */
export function ChartPanel({ title, sub, legend, table, children, tools, tour }: { title: string; sub?: ReactNode; legend?: ReactNode; table?: ReactNode; children: ReactNode; tools?: ReactNode; tour?: string }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="panel" data-tour={tour}>
      <header>
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        <div className="tools">
          {tools}
          {table && (
            <div className="view-toggle" role="group" aria-label="View">
              <button aria-pressed={!asTable} onClick={() => setAsTable(false)} title="Chart" aria-label="Show chart"><BarChart3 size={15} /></button>
              <button aria-pressed={asTable} onClick={() => setAsTable(true)} title="Table" aria-label="Show table"><Table2 size={15} /></button>
            </div>
          )}
        </div>
      </header>
      <div className="body">
        {asTable ? <div className="table-wrap">{table}</div> : children}
        {!asTable && legend}
      </div>
    </section>
  );
}

export function TableView<T>({ rows, cols }: { rows: T[]; cols: { label: string; get: (r: T) => ReactNode }[] }) {
  return (
    <table className="table-view">
      <thead>
        <tr>{cols.map((c) => <th key={c.label}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{cols.map((c) => <td key={c.label}>{c.get(r)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
