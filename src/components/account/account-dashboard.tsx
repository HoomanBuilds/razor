"use client";

import { appHref } from "@/lib/demo-scope";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Building2, ChevronLeft, ChevronRight, LayoutDashboard, LifeBuoy, LogOut, Menu, ShieldCheck, UserRound, Wallet, X } from "lucide-react";
import { RazorMark } from "@/components/brand/razor-logo";
import { useIdentity } from "@/components/auth/identity-provider";
import { accountReturnPath, accountView, type AccountView } from "@/lib/account-navigation";
import { workspacePath } from "@/lib/workspace-access";
import { errorMessage } from "@/lib/api";
import { AccountRecoveryPanel } from "./account-recovery-panel";

const views: Array<{ id: AccountView; label: string }> = [{ id: "profile", label: "Profile" }, { id: "wallets", label: "Connected wallets" }, { id: "security", label: "Security" }, { id: "recovery", label: "Recovery" }];

export function AccountDashboard({ initialView = "profile", returnTo }: { initialView?: AccountView; returnTo?: string }) {
  const { session, refresh, signOut } = useIdentity();
  const [view, setView] = useState(initialView), [expanded, setExpanded] = useState(false), [mobileOpen, setMobileOpen] = useState(false), [notice, setNotice] = useState("");
  const mobileDialog = useRef<HTMLDialogElement>(null), tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const returnPath = accountReturnPath(session?.organizations.map(company => company.id) ?? [], session?.activeOrganizationId ?? null, returnTo);
  const company = session?.organizations.find(value => value.id === session.activeOrganizationId);
  useEffect(() => {
    const read = () => setView(accountView(new URLSearchParams(window.location.search).get("view")));
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    const dialog = mobileDialog.current;
    if (!dialog) return;
    const previous = document.body.style.overflow;
    if (mobileOpen) { dialog.showModal(); document.body.style.overflow = "hidden"; }
    else if (dialog.open) dialog.close();
    return () => { document.body.style.overflow = previous; };
  }, [mobileOpen, session?.user.id]);
  if (!session) return null;
  const name = session.user.name || session.user.email || "Your account";
  const select = (next: AccountView) => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === "profile") url.searchParams.delete("view"); else url.searchParams.set("view", next);
    window.history.pushState(null, "", url.pathname + url.search);
  };
  const navigation = (full: boolean) => <>
    <a href={appHref(returnPath)} title={company?.name ?? "Company workspace"} aria-label="Open company workspace" className={`flex min-h-11 items-center rounded-2xl border border-white/60 text-muted-foreground hover:bg-white ${full ? "gap-3 px-3" : "size-11 justify-center"}`}><LayoutDashboard size={19}/>{full && <span className="text-sm">Company workspace</span>}</a>
    <a href={appHref("/receive")} title="Personal payments" aria-label="Open personal payments" className={`flex min-h-11 items-center rounded-2xl border border-white/60 text-muted-foreground hover:bg-white ${full ? "gap-3 px-3" : "size-11 justify-center"}`}><Wallet size={19}/>{full && <span className="text-sm">Personal payments</span>}</a>
    <a href={appHref("/account")} aria-current="page" title="My account" aria-label="My account" className={`flex min-h-11 items-center rounded-2xl border border-white bg-white text-primary shadow-sm ${full ? "gap-3 px-3" : "size-11 justify-center"}`}><UserRound size={19}/>{full && <span className="text-sm">My account</span>}</a>
    <a href="/help" title="Help and support" aria-label="Help and support" className={`flex min-h-11 items-center rounded-2xl border border-white/60 text-muted-foreground hover:bg-white ${full ? "gap-3 px-3" : "size-11 justify-center"}`}><LifeBuoy size={19}/>{full && <span className="text-sm">Help and support</span>}</a>
  </>;
  return <div className="min-h-screen bg-background">
    <aside aria-label="Account navigation" data-expanded={expanded} className={`dashboard-dock fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-border/60 bg-white p-3 lg:flex ${expanded ? "w-64" : "w-[84px]"}`}>
      <div className={`flex min-h-12 shrink-0 items-center ${expanded ? "justify-between px-1" : "flex-col justify-center gap-2"}`}><a href={appHref(returnPath)} aria-label="Razor workspace" className="text-foreground"><RazorMark size={28}/></a><button type="button" aria-label={expanded ? "Collapse account navigation" : "Expand account navigation"} onClick={() => setExpanded(value => !value)} className="rounded-full p-1.5 text-muted-foreground hover:bg-muted">{expanded ? <ChevronLeft size={16}/> : <ChevronRight size={14}/>}</button></div>
      <nav className={`dashboard-dock-nav grid gap-2 ${expanded ? "px-2" : "justify-items-center"}`}>{navigation(expanded)}</nav>
      <div className={`dashboard-account-dock mt-auto grid gap-3 ${expanded ? "px-3" : "justify-items-center"}`}><span title={name} className="grid size-10 place-items-center rounded-full bg-foreground text-sm font-medium text-white">{name[0].toUpperCase()}</span><button type="button" title="Sign out" aria-label="Sign out of Razor" onClick={() => void signOut().catch(cause => setNotice(errorMessage(cause)))} className={`flex min-h-10 items-center text-muted-foreground hover:text-foreground ${expanded ? "gap-3" : "w-10 justify-center"}`}><LogOut size={18}/>{expanded && <span className="text-sm">Sign out</span>}</button></div>
    </aside>
    <div className={`min-w-0 ${expanded ? "lg:ml-64" : "lg:ml-[84px]"}`}>
      <header className="flex min-h-20 items-center justify-between gap-4 px-5 sm:px-8 lg:px-10"><div className="flex min-w-0 items-center gap-3"><button type="button" aria-label="Open account navigation" onClick={() => setMobileOpen(true)} className="rounded-full p-2 hover:bg-muted lg:hidden"><Menu size={20}/></button><span className="truncate text-sm font-medium">My account</span><span className="hidden h-4 border-l border-border sm:block"/><span className="hidden truncate text-xs text-muted-foreground sm:block">{company?.name ? `${company.name} / Personal settings` : "Personal settings"}</span></div><a href={appHref(returnPath)} className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-4 py-2.5 text-xs font-medium hover:bg-muted"><ArrowLeft size={14}/><span>{company ? "Back to workspace" : "Company workspace"}</span></a></header>
      <main className="dashboard-canvas min-w-0 px-5 pb-10 pt-3 sm:px-8 lg:px-10">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Your account</h1></div><span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><ShieldCheck size={14}/>Signed in</span></div>
        {notice && <div role="alert" className="mb-5 flex items-center justify-between gap-3 rounded-2xl border border-destructive/20 p-4 text-sm text-destructive"><span>{notice}</span><button type="button" aria-label="Dismiss account message" onClick={() => setNotice("")}><X size={16}/></button></div>}
        <div role="tablist" aria-label="Account settings" className="dashboard-nav-scroll mb-7 flex max-w-full gap-1 overflow-x-auto rounded-full bg-muted p-1.5 sm:w-fit">{views.map((item, index) => <button key={item.id} ref={element => { tabButtons.current[index] = element; }} id={`account-tab-${item.id}`} aria-controls={`account-view-${item.id}`} role="tab" aria-selected={view === item.id} tabIndex={view === item.id ? 0 : -1} type="button" onClick={() => select(item.id)} onKeyDown={event => {
          let next = index;
          if (event.key === "ArrowRight") next = (index + 1) % views.length; else if (event.key === "ArrowLeft") next = (index - 1 + views.length) % views.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = views.length - 1; else return;
          event.preventDefault(); select(views[next].id); tabButtons.current[next]?.focus(); tabButtons.current[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }} className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium ${view === item.id ? "bg-foreground text-white" : "text-muted-foreground hover:text-foreground"}`}>{item.label}</button>)}</div>
        <AccountRecoveryPanel key={session.user.id} view={view} onViewChange={select}/>
        <footer className="mt-8 flex flex-wrap items-center gap-4 text-xs text-muted-foreground"><a href={appHref("/receive")} className="inline-flex items-center gap-1 hover:text-primary">Personal payments<ArrowUpRight size={12}/></a><a href={appHref(session.organizations.length ? returnPath : "/app")} className="inline-flex items-center gap-1 hover:text-primary"><Building2 size={12}/>{session.organizations.length ? "Company workspace" : "Create a company"}</a><button type="button" onClick={() => void refresh().catch(cause => setNotice(errorMessage(cause)))} className="hover:text-primary">Refresh account</button></footer>
      </main>
    </div>
    <dialog ref={mobileDialog} onCancel={() => setMobileOpen(false)} onClose={() => setMobileOpen(false)} aria-label="Account navigation" className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[90vw] border-r border-border bg-white p-5 backdrop:bg-black/20"><div className="mb-8 flex items-center justify-between"><a href={appHref(returnPath)} aria-label="Razor workspace"><RazorMark size={28}/></a><button type="button" aria-label="Close account navigation" onClick={() => setMobileOpen(false)} className="rounded-full p-2 hover:bg-muted"><X size={19}/></button></div><nav className="grid gap-3">{navigation(true)}</nav></dialog>
  </div>;
}
