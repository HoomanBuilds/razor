import type { ReactNode } from "react";
import { TokenLogo } from "@/components/assets/asset-identity";

export function PageMetrics({ items }: { items: { label: string; value: ReactNode; detail?: string; asset?: string }[] }) {
  return <div className="grid min-w-0 gap-y-6 py-2 sm:grid-cols-2 xl:flex">{items.map((item, index) => <div key={item.label} className={`min-w-0 flex-1 sm:px-6 ${index ? "xl:border-l" : "sm:pl-0"}`}><div className="flex items-center justify-between gap-3"><p className="text-[13px] text-muted-foreground">{item.label}</p>{item.asset && <TokenLogo symbol={item.asset} size={19}/>}</div>{item.value === null || item.value === undefined ? <div role="status" aria-label={`Loading ${item.label}`} className="mt-4 h-10 w-28 animate-pulse rounded-lg bg-muted"/> : <p className="mt-3 break-words text-[32px] font-normal leading-tight tracking-[-.045em] tabular-nums sm:text-[38px]">{item.value}</p>}{item.detail && <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>}</div>)}</div>;
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
