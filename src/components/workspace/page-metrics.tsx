import type { CSSProperties, ReactNode } from "react";
import { CapsuleMeter } from "./dashboard-visuals";
import { TokenLogo } from "@/components/assets/asset-identity";

export function PageMetrics({ items }: { items: { label: string; value: ReactNode; detail?: string; asset?: string; progress?: { value: number; label: string; detail?: string } }[] }) {
  return <div className="dashboard-metrics" style={{"--metric-count":Math.min(items.length,4)} as CSSProperties}>{items.map(item => <section key={item.label} className="dashboard-metric"><div className="flex items-center justify-between gap-3"><p className="text-[13px] text-foreground">{item.label}</p>{item.asset && <TokenLogo symbol={item.asset} size={19}/>}</div>{item.value === null || item.value === undefined ? <div role="status" aria-label={`Loading ${item.label}`} className="mt-5 h-14 w-28 animate-pulse rounded-lg bg-muted"/> : <p className={`dashboard-metric-value ${typeof item.value === "string" && item.value.length > 12 ? "dashboard-metric-value-compact" : ""}`}>{item.value}</p>}{item.progress ? <div className="mt-6"><div className="mb-3 flex items-center justify-between gap-2 text-[11px]"><span>{item.progress.label}</span><span className="tabular-nums text-muted-foreground">{item.progress.detail}</span></div><CapsuleMeter value={item.progress.value} label={`${item.progress.label}${item.progress.detail ? `: ${item.progress.detail}` : ""}`}/></div> : item.detail && <p className="mt-4 text-xs leading-5 text-muted-foreground">{item.detail}</p>}</section>)}</div>;
}

export function focusWorkspaceForm(id: string) {
  let remaining = 8;
  const focus = () => {
    const form = document.getElementById(id);
    if (!form || !form.getClientRects().length) {
      if (remaining-- > 0) requestAnimationFrame(focus);
      return;
    }
    form.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const control = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)')).find(input => input.getClientRects().length > 0 && !input.closest('[hidden], [aria-hidden="true"]'));
    control?.focus({ preventScroll: true });
  };
  focus();
}
