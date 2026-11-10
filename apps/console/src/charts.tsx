/**
 * Hand-rolled SVG charts following the dataviz method:
 * thin marks (2px lines, ≤24px columns with 4px rounded data-ends), a 2px surface gap
 * between stacked segments, hairline solid grid, one y-axis, a crosshair/tooltip layer on
 * every chart, a legend for ≥2 series, and a table view next to every chart.
 * Text always uses ink tokens; only marks carry series color.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface Series<T> {
  key: string;
  label: string;
  color: string; // a CSS var, e.g. "var(--s1)"
  get: (d: T) => number | null;
}

const PAD = { l: 44, r: 12, t: 10, b: 24 };

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

function Tip({ x, y, width, title, rows, keyShape }: { x: number; y: number; width: number; title: string; rows: { color: string; value: string; label: string }[]; keyShape: "line" | "rect" }) {
  const left = Math.min(Math.max(0, x + 14), width - 170);
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

export function Legend({ items, shape }: { items: { label: string; color: string }[]; shape: "line" | "rect" }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          {shape === "line" ? <i className="key-line" style={{ background: i.color }} /> : <i className="key-rect" style={{ background: i.color }} />}
          {i.label}
        </span>
      ))}
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

/** stacked columns over time (e.g. requests by outcome) */
export function StackedColumns<T>({ data, x, xLabel, series, format, height = 200, loading }: TimeProps<T>) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const totals = data.map((d) => series.reduce((s, se) => s + (se.get(d) ?? 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1];
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
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end">{compact(t)}</text>
            </g>
          ))}
          {xTickIndexes(n).map((i) => (
            <text key={i} x={PAD.l + band * i + band / 2} y={height - 6} textAnchor="middle">{xLabel(x(data[i]))}</text>
          ))}
        </g>
        {data.map((d, i) => {
          const cx = PAD.l + band * i + band / 2;
          let acc = 0;
          const segs = series
            .map((s) => ({ s, v: s.get(d) ?? 0 }))
            .filter((p) => p.v > 0);
          return (
            <g key={i} opacity={hover === null || hover === i ? 1 : 0.45}>
              {segs.map((p, j) => {
                const y0 = y(acc);
                acc += p.v;
                const y1 = y(acc);
                const isTop = j === segs.length - 1;
                const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
                const h = Math.max(0, y0 - y1 - gap);
                const yTop = y1;
                const r = isTop ? Math.min(4, h) : 0;
                const xl = cx - bw / 2;
                const path = `M${xl},${yTop + h} V${yTop + r} Q${xl},${yTop} ${xl + r},${yTop} H${xl + bw - r} Q${xl + bw},${yTop} ${xl + bw},${yTop + r} V${yTop + h} Z`;
                return <path key={p.s.key} d={path} fill={p.s.color} />;
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

/** lines over time; nulls break the line. `area` adds a 10% wash (single series only). */
export function LineChart<T>({ data, x, xLabel, series, format, height = 200, loading, area }: TimeProps<T> & { area?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const vals = data.flatMap((d) => series.map((s) => s.get(d) ?? 0));
  const ticks = niceTicks(Math.max(...vals, 0));
  const top = ticks[ticks.length - 1];
  const px = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const py = (v: number) => PAD.t + ih - (v / top) * ih;

  const paths = series.map((s) => {
    const segs: string[] = [];
    let cur = "";
    data.forEach((d, i) => {
      const v = s.get(d);
      if (v == null) {
        if (cur) segs.push(cur);
        cur = "";
      } else cur += `${cur ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
    });
    if (cur) segs.push(cur);
    const last = [...data.keys()].reverse().find((i) => s.get(data[i]) != null);
    return { s, segs, last };
  });

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const rel = e.clientX - r.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round((rel / r.width) * (n - 1)))));
  };

  return (
    <div ref={ref} className={`chart${loading ? " loading" : ""}`}>
      <svg width={width} height={height} role="img" aria-label={`line chart: ${series.map((s) => s.label).join(", ")}`}>
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
          paths[0].segs.map((d, k) => {
            const pts = d.slice(1).split("L").map((p) => p.split(",").map(Number));
            const poly = `M${pts[0][0]},${py(0)} L${pts.map((p) => p.join(",")).join(" L")} L${pts[pts.length - 1][0]},${py(0)} Z`;
            return <path key={k} d={poly} fill={paths[0].s.color} opacity={0.1} />;
          })}
        {paths.map(({ s, segs }) =>
          segs.map((d, k) => <path key={`${s.key}${k}`} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />),
        )}
        {/* end dots: r=4, 2px surface ring */}
        {paths.map(({ s, last }) =>
          last == null ? null : <circle key={s.key} cx={px(last)} cy={py(s.get(data[last])!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />,
        )}
        {hover !== null && (
          <g>
            <line className="crosshair" x1={px(hover)} x2={px(hover)} y1={PAD.t} y2={PAD.t + ih} />
            {series.map((s) => {
              const v = s.get(data[hover]);
              return v == null ? null : <circle key={s.key} cx={px(hover)} cy={py(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
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
  const rowH = 30;
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
              <text x={0} y={y + barH - 2} fill="var(--ink-2)" fontSize={12}>
                <title>{r.label}</title>
                {short(r.label)}
              </text>
              {w > 0 && <path d={path} fill={color} />}
              <text x={labelW + w + 6} y={y + barH - 2} fill="var(--ink)" fontSize={12} style={{ fontVariantNumeric: "tabular-nums" }}>{format(r.value)}</text>
              <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" tabIndex={0} aria-label={`${r.label}: ${format(r.value)}`}
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
        <line x1={labelW} x2={labelW} y1={0} y2={rows.length * rowH} className="base-line" stroke="var(--line-strong)" />
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
      <svg width={width} height={28} role="img" aria-label={live.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(", ")}>
        {live.map((p, i) => {
          const w = ((width - gaps) * p.value) / total;
          const share = `${Math.round((p.value / total) * 100)}%`;
          const fits = w > share.length * 7 + 14;
          const el = (
            <g key={p.label} opacity={hover === null || hover === i ? 1 : 0.55}>
              <rect x={x} y={0} width={w} height={28} rx={4} fill={p.color} />
              {fits && <text x={x + 8} y={18} fontSize={12} fontWeight={600} fill={p.ink ?? "#ffffff"}>{share}</text>}
              <rect x={x} y={0} width={w + 2} height={28} fill="transparent" tabIndex={0} aria-label={`${p.label}: ${format(p.value)} (${share})`}
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
          x += w + 2;
          return el;
        })}
      </svg>
      <Legend shape="rect" items={live.map((p) => ({ label: p.label, color: p.color }))} />
      {hover !== null && (
        <Tip x={20} y={34} width={width} title={live[hover].label} keyShape="rect"
          rows={[{ color: live[hover].color, value: format(live[hover].value), label: `${Math.round((live[hover].value / total) * 100)}% of model-served requests` }]} />
      )}
    </div>
  );
}

/** 12-point trend in the de-emphasis hue, current point in the accent */
export function Sparkline({ values, width = 120, height = 26 }: { values: (number | null)[]; width?: number; height?: number }) {
  const v = values.map((x) => x ?? 0);
  const max = Math.max(...v, 0) || 1;
  const px = (i: number) => (v.length <= 1 ? width / 2 : (width - 4) * (i / (v.length - 1)) + 2);
  const py = (x: number) => height - 3 - (x / max) * (height - 6);
  const d = v.map((x, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(x).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--line-strong)" strokeWidth={1.5} strokeLinejoin="round" />
      {v.length > 0 && <circle cx={px(v.length - 1)} cy={py(v[v.length - 1])} r={2.5} fill="var(--accent)" />}
    </svg>
  );
}

/** a chart panel with an always-available table view */
export function ChartPanel({ title, sub, legend, table, children, tools }: { title: string; sub?: ReactNode; legend?: ReactNode; table?: ReactNode; children: ReactNode; tools?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="panel">
      <header>
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        <div className="tools">
          {tools}
          {table && (
            <button className="btn ghost sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              {asTable ? "Show chart" : "Show table"}
            </button>
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
