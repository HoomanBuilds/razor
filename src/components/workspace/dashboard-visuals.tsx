import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { PaymentActivity } from "@/lib/payment-activity";
import { proportion } from "@/lib/payment-activity";

export function CapsuleMeter({ value, label, light = false, compact = false }: { value: number; label: string; light?: boolean; compact?: boolean }) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return <div role="img" aria-label={label} className={`capsule-meter ${light ? "capsule-meter-light" : ""} ${compact ? "capsule-meter-compact" : ""}`}>
    {Array.from({ length: 28 }, (_, index) => <span key={index} aria-hidden="true" style={{ "--capsule-fill": `${Math.max(0, Math.min(1, fraction * 28 - index)) * 100}%` } as CSSProperties}/>) }
  </div>;
}

export function VisualCard({ title, action, children, className = "" }: { title: string; action?: () => void; children: ReactNode; className?: string }) {
  return <section className={`dashboard-visual-card ${className}`}><div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-xl font-normal tracking-tight">{title}</h2>{action && <button type="button" onClick={action} aria-label={`Open ${title.toLowerCase()}`} className="dashboard-arrow"><ArrowUpRight size={18} strokeWidth={1.7}/></button>}</div>{children}</section>;
}

export function ActivityChart({ activity, action, scope = "All payment records" }: { activity: PaymentActivity | null; action?: () => void; scope?: string }) {
  const series = activity?.series ?? [], max = Math.max(1, ...series.map(day => day.settled + day.open + day.review + day.closed));
  const total = series.reduce((sum, day) => sum + day.settled + day.open + day.review + day.closed, 0);
  const colors = { settled: "#101117", open: "#1749ff", review: "#bdcbff", closed: "#d9dbe2" };
  return <VisualCard title="Payment activity" action={action} className="dashboard-activity"><div className="flex items-baseline gap-2"><p className="text-[30px] font-light tracking-tight tabular-nums">{activity ? total.toLocaleString() : "..."}</p><span className="text-xs text-muted-foreground">records created · 21 days</span></div>
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">{Object.entries(colors).map(([key,color]) => <span key={key} className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full" style={{background:color}}/>{key === "settled" ? "Paid" : key === "review" ? "Review" : key === "closed" ? "Closed" : "Open"}</span>)}</div>
    <svg className="mt-3 h-30 w-full overflow-visible" viewBox="0 0 336 150" role="img" aria-label={activity ? `${total} payment records created from ${activity.window.from} to ${activity.window.to}, UTC. Bars group current payment status by creation date.` : "Payment activity is loading"}>
      <title>Payment creation activity in UTC, grouped by current status</title>
      {[0,1,2].map(row => <line key={row} x1="0" x2="336" y1={row*50+1} y2={row*50+1} stroke="#e6e6eb" strokeWidth=".7" strokeDasharray="2 5"/>)}
      {series.map((day,index) => { let baseline = 142; return <g key={day.date}><title>{`${day.date}: ${day.settled} paid, ${day.open} open, ${day.review} review, ${day.closed} closed`}</title>{(["settled","open","review","closed"] as const).map(state => { const height = day[state] / max * 132; baseline -= height; return <rect key={state} x={index*16+1} y={baseline} width="12" height={height} fill={colors[state]}/>; })}<line x1={index*16+1} x2={index*16+13} y1="143" y2="143" stroke="#e2e4ec" strokeWidth="1"/></g>; })}
    </svg>
    <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{activity?.window.from.slice(5) ?? ""}</span><span>Created date · UTC</span><span>{activity?.window.to.slice(5) ?? ""}</span></div><p className="mt-2 text-[10px] text-muted-foreground">{scope}{activity && total === 0 ? " · No records in this window" : ""}</p>
  </VisualCard>;
}

export function CompositionCard({ title, items, total, action, detail }: { title: string; items: { label: string; value: number }[]; total: number; action?: () => void; detail: string }) {
  return <VisualCard title={title} action={action}><div className="grid grid-cols-3 divide-x divide-border">{items.slice(0,3).map(item => <div key={item.label} className="min-w-0 px-3 first:pl-0 last:pr-0"><p className="text-[11px] text-muted-foreground">{item.label}</p><p className="mt-3 text-2xl font-light tabular-nums">{item.value.toLocaleString()}</p></div>)}</div><div className="mt-5 border-t border-border pt-4"><p className="mb-3 text-xs text-muted-foreground">{detail}</p><div className="grid gap-3">{items.slice(0,2).map(item => <div key={item.label}><div className="mb-2 flex items-center justify-between gap-2 text-[11px]"><span>{item.label}</span><span className="tabular-nums text-muted-foreground">{item.value} / {total}</span></div><CapsuleMeter compact value={proportion(item.value,total)} label={`${item.label}: ${item.value} of ${total}`}/></div>)}</div></div></VisualCard>;
}

export function AttentionCard({ items, action, detail = "Current payment records" }: { items: { label: string; value: number; status: string }[]; action?: () => void; detail?: string }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return <VisualCard title="Needs attention" action={action}><div className="flex items-end justify-between gap-3"><div><p className="text-xs text-muted-foreground">{detail}</p><p className="mt-2 text-3xl font-light tracking-tight">{total.toLocaleString()} <span className="text-sm font-normal">to review</span></p></div><span className={`mb-1 size-2 rounded-full ${total ? "bg-amber-500" : "bg-primary"}`}/></div><div className="mt-5 grid gap-1.5"><div className="flex justify-between px-3 text-[10px] text-muted-foreground"><span>Record state</span><span>Count</span></div>{items.map(item => <button key={item.label} type="button" disabled={!action} onClick={action} className="flex items-center justify-between gap-2 rounded-full border border-border bg-white/40 px-3 py-2 text-xs hover:bg-white disabled:cursor-default"><span>{item.label}</span><span className="inline-flex items-center gap-2 tabular-nums"><span className={`size-1 rounded-full ${item.status === "review" ? "bg-amber-500" : item.status === "paid" ? "bg-primary" : "bg-muted-foreground"}`}/>{item.value.toLocaleString()}</span></button>)}</div></VisualCard>;
}

export function FinanceCard({ title, value, unit, meter, stats, action, children }: { title: string; value: ReactNode; unit: string; meter: { value: number; label: string; left: string; right: string }; stats: { label: string; value: ReactNode }[]; action?: ReactNode; children?: ReactNode }) {
  return <section className="dashboard-finance-card"><div className="relative z-10"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{title}</h2>{action}</div><p className="mt-4 break-words text-[36px] font-light leading-none tracking-[-.045em] tabular-nums">{value}</p><p className="mt-1 text-[10px] text-white/70">{unit}</p><div className="mt-4"><div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-white/80"><span>{meter.left}</span><span>{meter.right}</span></div><CapsuleMeter light value={meter.value} label={meter.label}/></div><div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/15 pt-4">{stats.map(stat => <div key={stat.label} className="min-w-0"><p className="break-words text-[20px] font-light leading-tight tracking-tight tabular-nums">{stat.value}</p><p className="mt-1 text-[10px] leading-4 text-white/65">{stat.label}</p></div>)}</div>{children}</div></section>;
}

export function InsightState({ titles, error }: { titles: string[]; error: boolean }) {
  return <div className="dashboard-visual-grid" role={error ? undefined : "status"} aria-label={error ? "Payment insights unavailable" : "Loading payment insights"}>{titles.map(title => <VisualCard key={title} title={title}>{error ? <><p className="mt-8 text-2xl font-light">Unavailable</p><p className="mt-3 text-xs leading-6 text-muted-foreground">Refresh your records to load these insights.</p></> : <div className="mt-8 grid animate-pulse gap-5"><div className="h-8 w-24 rounded-lg bg-border/60"/><div className="h-24 rounded-xl bg-border/40"/></div>}</VisualCard>)}</div>;
}
