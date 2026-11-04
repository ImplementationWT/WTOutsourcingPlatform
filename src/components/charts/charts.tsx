import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Gráficos del panel en HTML/SVG con los tokens `--viz-*` (colores en ./viz): tooltip CSS al pasar
// el mouse (no se queda pegado) y vista de tabla en cada tarjeta.

export interface Series {
  key: string;
  label: string;
  color: string;
}

/** Tarjeta de un gráfico: título, subtítulo, filtro opcional y «Ver como tabla». */
export function ChartCard({ title, sub, action, table, children, className }: { title: string; sub?: string; action?: ReactNode; table: { columns: string[]; rows: (string | number)[][] }; children: ReactNode; className?: string }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-card", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {action}
          <button type="button" onClick={() => setAsTable(!asTable)} aria-pressed={asTable} className="text-xs font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {asTable ? "Ver gráfico" : "Ver como tabla"}
          </button>
        </div>
      </div>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col" className="text-caps-label border-b border-border px-2 py-1.5 text-left font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {r.map((v, j) => (
                    <td key={j} className={cn("px-2 py-1.5", j > 0 && "tabular-nums")}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!table.rows.length && <p className="py-6 text-center text-sm text-muted-foreground">Sin datos.</p>}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/** Tooltip CSS sobre un objetivo de hover más grande que la marca. */
function Tip({ text, children, className, style }: { text: string; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn("group/tip relative", className)} style={style} tabIndex={0} aria-label={text}>
      {children}
      <span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 hidden -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-popover-foreground shadow-popover group-hover/tip:block group-focus-visible/tip:block">
        {text}
      </span>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-sm" style={{ background: i.color }} />
          <span className="text-foreground">{i.label}</span>
          {i.value && <span className="tabular-nums">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

const niceMax = (max: number) => {
  if (max <= 0) return { top: 1, step: 1 };
  const mag = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => max / s <= 5) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
};

/**
 * Barras verticales; con varias series se apilan (2px de separación entre segmentos). El valor
 * total va encima de cada barra; el detalle por serie, en el tooltip.
 */
export function ColumnChart({ columns, series, format, height = 240, labelEvery = 1, totals: showTotals = true }: { columns: { label: string; values: Record<string, number> }[]; series: Series[]; format: (v: number) => string; height?: number; /** Cada cuántas columnas se escribe la etiqueta del eje (las demás quedan en el tooltip). */ labelEvery?: number; /** Valor encima de cada barra. */ totals?: boolean }) {
  const totals = columns.map((c) => series.reduce((n, s) => n + (c.values[s.key] ?? 0), 0));
  const { top, step } = niceMax(Math.max(0, ...totals));
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  return (
    <div className="space-y-3">
      <div className="flex gap-2 pt-5">
        <div className="relative w-12 shrink-0 text-right text-[11px] text-muted-foreground" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2 tabular-nums" style={{ bottom: `${(t / top) * 100}%` }}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }}>
          {ticks.map((t) => (
            <div key={t} aria-hidden className="absolute inset-x-0 border-t border-dashed border-border" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-1">
            {columns.map((c, i) => (
              <Tip key={c.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" text={`${c.label}: ${series.length > 1 ? series.filter((s) => c.values[s.key]).map((s) => `${s.label} ${format(c.values[s.key])}`).join(" · ") : format(totals[i])}`}>
                <span className="absolute left-1/2 -translate-x-1/2 text-[11px] font-semibold whitespace-nowrap tabular-nums" style={{ bottom: `calc(${(totals[i] / top) * 100}% + 4px)` }}>
                  {showTotals && totals[i] ? format(totals[i]) : ""}
                </span>
                <div className="flex w-[72%] max-w-16 flex-col-reverse gap-[2px]" style={{ height: `${(totals[i] / top) * 100}%` }}>
                  {series.map((s, k) => {
                    const v = c.values[s.key] ?? 0;
                    if (!v) return null;
                    const topMost = series.slice(k + 1).every((x) => !(c.values[x.key] ?? 0));
                    return <div key={s.key} className={cn("w-full transition-[filter] group-hover/tip:brightness-110", topMost && "rounded-t-[4px]")} style={{ height: `${(v / totals[i]) * 100}%`, background: s.color }} />;
                  })}
                </div>
              </Tip>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-1 pl-14">
        {columns.map((c, i) => (
          <span key={c.label} className="min-w-0 flex-1 overflow-visible text-center text-[11px] whitespace-nowrap text-muted-foreground" title={c.label}>
            {i % labelEvery === 0 ? c.label : ""}
          </span>
        ))}
      </div>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
    </div>
  );
}

/** Barras horizontales: una fila por categoría con su valor a la derecha. */
export function BarList({ rows }: { rows: { label: string; value: number; text: string; color: string; tip?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">Sin datos.</p>;
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Tip key={r.label} text={r.tip ?? `${r.label} · ${r.text}`} className="rounded-lg px-1.5 py-1 hover:bg-muted/50">
          <div className="flex justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <b className="shrink-0 tabular-nums">{r.text}</b>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${r.value > 0 ? Math.max(2, (r.value / max) * 100) : 0}%`, background: r.color }} />
          </div>
        </Tip>
      ))}
    </div>
  );
}

/** Dona: arcos con 2px de separación; al pasar el mouse por un arco o su leyenda, el centro muestra su parte. */
export function Donut({ parts, center, centerLabel }: { parts: { label: string; value: number; color: string }[]; center: string; centerLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((n, p) => n + p.value, 0);
  const r = 70;
  const c = 2 * Math.PI * r;
  const gap = total && parts.filter((p) => p.value).length > 1 ? 2 : 0;
  let offset = 0;
  const active = hover !== null ? parts[hover] : null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <div className="relative size-44 shrink-0">
        <svg viewBox="0 0 180 180" className="size-full -rotate-90" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
          <circle cx="90" cy="90" r={r} fill="none" stroke="var(--muted)" strokeWidth="22" />
          {total > 0 &&
            parts.map((p, i) => {
              const len = (p.value / total) * c;
              const dash = Math.max(0, len - gap);
              const el = p.value ? (
                <circle
                  key={p.label}
                  cx="90"
                  cy="90"
                  r={r}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={hover === i ? 26 : 22}
                  strokeDasharray={`${dash} ${c - dash}`}
                  strokeDashoffset={-offset}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  className="cursor-default transition-[stroke-width]"
                />
              ) : null;
              offset += len;
              return el;
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <b className="text-2xl tabular-nums">{active ? `${Math.round((active.value / total) * 1000) / 10}%` : center}</b>
          <span className="max-w-24 text-xs leading-tight text-muted-foreground">{active ? `${active.label} · ${active.value}` : centerLabel}</span>
        </div>
      </div>
      <ul className="min-w-40 space-y-1.5 text-sm" onMouseLeave={() => setHover(null)}>
        {parts.map((p, i) => (
          <li key={p.label} onMouseEnter={() => setHover(i)} className={cn("flex items-center gap-2 rounded-md px-1.5 py-0.5", hover === i && "bg-muted")}>
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: p.color }} />
            <span className="flex-1">{p.label}</span>
            <b className="pl-3 tabular-nums">
              {total ? Math.round((p.value / total) * 1000) / 10 : 0}% · {p.value}
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Línea de una serie (2px) con marcadores de 8px y el valor de los puntos destacados encima; cada
 * punto tiene su tooltip con un objetivo de hover más ancho que la marca.
 */
export function LineChart({ points, color, format, height = 240, labelEvery = 3 }: { points: { label: string; value: number }[]; color: string; format: (v: number) => string; height?: number; /** Cada cuántos puntos se escribe el valor (además del último). */ labelEvery?: number }) {
  const { top, step } = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const n = points.length;
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - (v / top) * 100;
  return (
    <div className="space-y-3">
      <div className="flex gap-2 pt-5">
        <div className="relative w-14 shrink-0 text-right text-[11px] text-muted-foreground" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2 tabular-nums" style={{ bottom: `${(t / top) * 100}%` }}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }}>
          {ticks.map((t) => (
            <div key={t} aria-hidden className="absolute inset-x-0 border-t border-dashed border-border" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            <polyline fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
          </svg>
          {points.map((p, i) => (
            <Tip key={p.label} text={`${p.label}: ${format(p.value)}`} className="absolute flex h-full -translate-x-1/2 justify-center" style={{ left: `${x(i)}%`, width: `${Math.max(4, 100 / Math.max(1, n))}%`, top: 0 }}>
              <span aria-hidden className="absolute size-2 -translate-y-1/2 rounded-full ring-2 ring-card" style={{ top: `${y(p.value)}%`, background: color }} />
              {(i === n - 1 || (i % labelEvery === 0 && p.value > 0)) && (
                <span className="absolute -translate-y-[calc(100%+8px)] text-[11px] font-semibold whitespace-nowrap tabular-nums" style={{ top: `${y(p.value)}%` }}>
                  {format(p.value)}
                </span>
              )}
            </Tip>
          ))}
        </div>
      </div>
      <div className="relative ml-16 h-4">
        {points.map((p, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <span key={p.label} className="absolute -translate-x-1/2 text-[11px] whitespace-nowrap text-muted-foreground" style={{ left: `${x(i)}%` }}>
              {p.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
