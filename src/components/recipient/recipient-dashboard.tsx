"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Bell, Building2, CircleDollarSign, Gift, Home, Menu, ReceiptText, RefreshCw, ShoppingBag, Users, Wallet, X } from "lucide-react";
import { RazorMark } from "@/components/brand/razor-logo";
import { useIdentity } from "../auth/identity-provider";

export type RecipientView = "overview" | "payments" | "profiles" | "invoices" | "expenses" | "purchasing" | "distributions" | "financing" | "notifications";
const pages = [
  { id: "overview", title: "Dashboard", icon: Home, description: "Your receiving profiles and payments, across the companies you work with." },
  { id: "payments", title: "My payments", icon: Wallet, description: "Follow your entitlements, delivery records and payment receipts." },
  { id: "profiles", title: "Payout profiles", icon: Users, description: "Separate receiving preferences for every payer company." },
  { id: "invoices", title: "Invoices", icon: ReceiptText, description: "Your invoice requests, finance reviews and supplier credits." },
  { id: "expenses", title: "Expenses", icon: CircleDollarSign, description: "Submit receipts and follow your reimbursements." },
  { id: "purchasing", title: "Supplier workspace", icon: ShoppingBag, description: "Review company invitations, quotes and private agreements." },
  { id: "distributions", title: "Distributions", icon: Gift, description: "Review fixed company allocations and claim your entitlements." },
  { id: "financing", title: "Lending agreements", icon: Building2, description: "Your invited lending opportunities and agreements." },
  { id: "notifications", title: "Notifications", icon: Bell, description: "Updates for your personal account." },
] as const;

export function RecipientDashboard({ active, onNavigate, views, onRefresh, notice }: { active: RecipientView; onNavigate: (view: RecipientView) => void; views: Record<RecipientView, ReactNode>; onRefresh: () => void; notice?: ReactNode }) {
  const { session } = useIdentity();
  const [expanded, setExpanded] = useState(false), [statuses, setStatuses] = useState<string[]>([]);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const sidebar = useRef<HTMLElement>(null);
  const page = pages.find(page => page.id === active) ?? pages[0];
  const name = session?.user.name || session?.user.email || "Your account";
  useEffect(() => {
    const read = () => {
      const next = panels.current.map(panel => panel?.querySelector('[aria-busy="true"]') ? "busy" : Array.from(panel?.querySelectorAll('[role="alert"]') ?? []).some(node => node.textContent?.trim()) ? "error" : "");
      setStatuses(previous => previous.join() === next.join() ? previous : next);
    };
    const observer = new MutationObserver(read);
    panels.current.forEach(panel => { if (panel) observer.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-busy"] }); });
    read();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const mobile = window.matchMedia("(max-width: 1023px)").matches;
    const overflow = document.body.style.overflow;
    const targets = () => Array.from(sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)') ?? []);
    if (mobile) { document.body.style.overflow = "hidden"; targets()[0]?.focus(); }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (!mobile || event.key !== "Tab") return;
      const items = targets(), first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keyboard);
    return () => { window.removeEventListener("keydown", keyboard); if (mobile) { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); } };
  }, [expanded]);
  const navigate = (view: RecipientView) => { onNavigate(view); setExpanded(false); };
  return <div className="workspace-surface min-h-screen">
    <aside id="personal-navigation" ref={sidebar} aria-label="Personal navigation" data-expanded={expanded} className={`dashboard-dock ${expanded ? "flex w-64" : "hidden w-[84px]"} fixed inset-y-0 left-0 z-40 flex-col border-r border-border/60 bg-white p-3 lg:flex`}>
      <div className={`flex h-14 shrink-0 items-center ${expanded ? "justify-between px-2" : "justify-center"}`}><a href="/receive" aria-label="Razor personal dashboard" className="flex items-center gap-3"><RazorMark size={31} className="shrink-0 text-[#5c5e68]"/><span className={`${expanded ? "" : "lg:hidden"} text-2xl font-semibold tracking-tight`}>Razor</span></a>{expanded && <button onClick={() => setExpanded(false)} aria-label="Collapse personal navigation" className="rounded-full p-2 text-muted-foreground hover:bg-muted"><X size={17}/></button>}</div>
      <p className={`${expanded ? "" : "lg:sr-only"} mb-3 mt-7 px-3 text-[10px] font-medium uppercase tracking-[.12em] text-muted-foreground`}>Personal workspace</p>
      <nav className="dashboard-dock-nav dashboard-nav-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pb-4" aria-label="Personal workspace pages">{pages.map((item, index) => <button key={item.id} data-recipient-view={item.id} type="button" aria-label={item.title} aria-current={active === item.id ? "page" : undefined} title={`${item.title}${statuses[index] === "error" ? ": needs attention" : statuses[index] === "busy" ? ": action running" : ""}`} onClick={() => navigate(item.id)} className={`relative flex min-h-11 items-center rounded-xl text-left text-[13px] transition-colors ${expanded ? "gap-3 px-3" : "justify-center lg:mx-auto lg:w-11"} ${active === item.id ? "bg-secondary font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><item.icon size={19} strokeWidth={active === item.id ? 2 : 1.7} className="shrink-0"/><span className={expanded ? "" : "lg:sr-only"}>{item.title}</span>{statuses[index] && <span aria-hidden="true" className={`absolute right-1.5 top-1.5 size-1.5 rounded-full ${statuses[index] === "busy" ? "animate-pulse bg-primary" : "bg-amber-500"}`}/>}</button>)}</nav>
      <div className="dashboard-account-dock grid shrink-0 gap-2 border-t border-border/60 pt-3"><a href="/app" title="Company workspace" className={`flex min-h-10 items-center gap-3 rounded-xl text-xs text-muted-foreground hover:bg-muted ${expanded ? "px-3" : "justify-center"}`}><Building2 size={18}/><span className={expanded ? "" : "lg:sr-only"}>Company workspace</span></a><a href="/account" title="Account and recovery" className={`flex items-center gap-3 rounded-xl text-xs ${expanded ? "p-2" : "justify-center"}`}><span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-sm font-medium text-white">{name[0].toUpperCase()}</span><span className={`${expanded ? "min-w-0 truncate" : "lg:sr-only"}`}>{name}</span></a></div>
    </aside>
    {expanded && <button aria-label="Close personal navigation overlay" className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[2px] lg:hidden" onClick={() => setExpanded(false)}/>}
    <div className={`min-w-0 ${expanded ? "lg:ml-64" : "lg:ml-[104px]"}`}>
      <header className="dashboard-canvas flex min-h-18 items-center justify-between gap-3 px-5 sm:px-8 lg:px-10"><div className="flex min-w-0 items-center gap-3"><button aria-label={expanded ? "Collapse personal navigation" : "Expand personal navigation"} aria-expanded={expanded} aria-controls="personal-navigation" className="rounded-full p-2 text-muted-foreground hover:bg-muted" onClick={() => setExpanded(value => !value)}><Menu size={19}/></button><span className="truncate text-sm font-medium">Personal workspace</span><span className="hidden rounded-full bg-muted px-3 py-1 text-[10px] text-muted-foreground sm:block">Receiving account</span></div><div className="flex items-center gap-2"><a href="/help" className="hidden items-center gap-1 rounded-full px-3 py-2 text-xs text-muted-foreground hover:bg-muted sm:flex">Help<ArrowUpRight size={12}/></a><button type="button" aria-label="Refresh my records" title="Refresh my records" onClick={onRefresh} className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-secondary"><RefreshCw size={16}/></button><a href="/account" aria-label="Open personal account" className="grid size-9 place-items-center rounded-full bg-secondary text-sm font-medium text-primary">{name[0].toUpperCase()}</a></div></header>
      <main className="dashboard-canvas mx-auto max-w-[1480px] px-5 pb-8 pt-5 sm:px-8 sm:pt-6 lg:px-9"><div className="mb-7"><h1 className="text-[30px] font-medium tracking-[-.04em] sm:text-4xl">{page.title}</h1>{active !== "overview" && <p className="mt-2 text-sm leading-6 text-muted-foreground">{page.description}</p>}</div>
        {notice}
        {statuses.some((value,index) => value === "busy" && pages[index].id !== active) && <p role="status" className="mb-5 rounded-xl border border-primary/15 bg-secondary/50 px-4 py-3 text-xs text-primary">An action is still running in {pages.filter((_,index) => statuses[index] === "busy" && pages[index].id !== active).map(page => page.title).join(", ")}. Return to that page to follow its progress.</p>}
        {pages.map((page,index) => <div ref={node => { panels.current[index] = node; }} key={page.id} hidden={page.id !== active} className="workspace-content min-w-0" aria-label={page.title}>{views[page.id]}</div>)}
      </main><footer className="mx-auto max-w-[1536px] px-5 pb-6 text-[11px] leading-5 text-muted-foreground sm:px-8 lg:px-10">Your personal records only. Receiving profiles do not grant access to company treasuries.</footer>
    </div>
  </div>;
}
