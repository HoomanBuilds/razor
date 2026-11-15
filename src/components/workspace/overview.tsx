"use client";

import { appNavigate } from "@/lib/demo-scope";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, CalendarDays, Check, ChevronRight, Circle, Plus, ReceiptText, Send, ShieldCheck, Users, Wallet } from "lucide-react";
import { proportion, type PaymentActivity } from "@/lib/payment-activity";
import { ActivityChart, AttentionCard, CompositionCard, FinanceCard, InsightState } from "./dashboard-visuals";
import { usd, dateLabel } from "@/lib/format";
import { hasPermissions } from "@/lib/workspace-access";
import { TokenLogo } from "@/components/assets/asset-identity";
import { useWorkspace } from "./context";
import { PageMetrics, focusWorkspaceForm } from "./page-metrics";
import { paymentLabel } from "@/lib/payment-label";
import { useResource } from "./hooks";
import { Panel, Status } from "./shared";
import { openInvoice } from "./invoice-navigation";
import type { Payment, Section, Treasury } from "./types";

interface Summary {
  activity?: PaymentActivity; unreservedBudget: string;
  openPrincipal: string; uncommittedInvoicePrincipal: string; fundingGap: string;
  openCount: number; paidCount: number; treasury: Treasury;
  attention: Array<{ payment: Payment; recipientName: string; outstandingPrincipal: string; state: string; rootPaymentId: string; billId?: string }>;
}

export function Overview() {
  const { base, revision, recipients, recipientsLoading, recipientsError, navigate, organization, session } = useWorkspace();
  const accountHref = `/account?returnTo=${encodeURIComponent(typeof window === "undefined" ? "/app" : window.location.pathname + window.location.search)}`;
  const permissions = organization.permissions ?? [];
  const canReadPayments = hasPermissions(permissions, ["payments:read"]);
  const canPrepare = hasPermissions(permissions, ["payments:prepare", "recipients:read"]);
  const canManage = hasPermissions(permissions, ["company:manage"]);
  const canManageRecipients = hasPermissions(permissions, ["recipients:manage"]);
  const summary = useResource<Summary>(canReadPayments ? `${base}/payments/summary` : null, revision);
  const recent = useResource<{ payments: Payment[] }>(canReadPayments ? `${base}/payments?page=1&pageSize=5` : null, revision);
  const [paymentView, setPaymentView] = useState<"recent" | "attention">("recent");
  const balance = useResource<Treasury>(!canReadPayments ? `${base}/treasury` : null, revision);
  const treasury = summary.data?.treasury ?? balance.data;
  const signingNetwork = treasury?.config?.network ?? organization.near_network;
  const signerLinked = session.wallets.some(wallet => wallet.family === "near" && wallet.network === signingNetwork);
  const steps: { title: string; done: boolean; section: Section; detail: string; href?: string; show: boolean }[] = [
    { title: "Company created", done: true, section: "settings", detail: organization.name, show: true },
    { title: "Link your signing wallet", done: signerLinked, section: "treasury", detail: "Verify a NEAR wallet to approve company actions.", href: accountHref, show: canManage || canPrepare },
    { title: "Connect your treasury", done: !!treasury?.config, section: "treasury", detail: "Verify your company's NEAR contract and authority.", show: canManage },
    { title: "Add your first payee", done: recipients.length > 0, section: "recipients", detail: "Invite an employee, contractor or supplier.", show: canManageRecipients },
    { title: "Add company funds", done: BigInt(treasury?.balance ?? "0") > 0n || (summary.data?.paidCount ?? 0) > 0, section: "treasury", detail: "Fund with any currently supported source asset.", show: canPrepare },
    { title: "Make your first payment", done: (summary.data?.paidCount ?? 0) > 0, section: "payments", detail: "Approve a payment and confirm its delivery.", show: canPrepare },
  ];
  const visibleSteps = steps.filter(step => step.show);
  const complete = visibleSteps.filter(step => step.done).length;
  const needsSetup = (canManage || canPrepare || canManageRecipients) && complete < visibleSteps.length;
  const actions = [
    { title: "Send a payment", detail: "Pay a confirmed recipient", section: "payments" as const, formId: "payment-compose", icon: Send, show: canPrepare },
    { title: "Run payroll", detail: "Prepare your team's next pay run", section: "payroll" as const, formId: "payroll-compose", icon: CalendarDays, show: canPrepare },
    { title: "Add an invoice", detail: "Manage a supplier payment", section: "bills" as const, formId: "bill-compose", icon: ReceiptText, show: canPrepare },
    { title: "Invite a payee", detail: "Save their receiving preferences", section: "recipients" as const, formId: "payee-compose", icon: Users, show: canManageRecipients },
  ].filter(action => action.show);
  const failed = summary.error || balance.error;
  const activity = summary.error ? null : summary.data?.activity ?? null;
  const metrics = [
    { label: "Available balance", value: failed ? "Unavailable" : treasury ? usd(treasury.available) : null, asset: "USDC", progress: treasury && !failed ? { value: proportion(treasury.available, treasury.balance), label: "Of confirmed cash", detail: `${usd(treasury.available)} / ${usd(treasury.balance)}` } : undefined },
    { label: "Reserved funds", value: failed ? "Unavailable" : treasury ? usd(treasury.totalReserved ?? treasury.reserved) : null, progress: treasury && !failed ? { value: proportion(treasury.totalReserved ?? treasury.reserved, treasury.balance), label: "Company reservations", detail: `${usd(treasury.totalReserved ?? treasury.reserved)}` } : undefined },
    ...(canReadPayments ? [
      { label: "Outstanding payments", value: failed ? "Unavailable" : summary.data ? usd(summary.data.openPrincipal) : null, progress: summary.data && !failed ? { value: proportion(summary.data.openCount, summary.data.openCount + summary.data.paidCount), label: "Open obligations", detail: `${summary.data.openCount} / ${summary.data.openCount + summary.data.paidCount}` } : undefined },
      { label: "Funding gap", value: failed ? "Unavailable" : summary.data ? usd(summary.data.fundingGap) : null, progress: summary.data && !failed ? { value: proportion(summary.data.fundingGap, summary.data.unreservedBudget), label: "Uncovered current budget", detail: usd(summary.data.fundingGap) } : undefined },
    ] : []),
  ];
  return <div className="grid min-w-0 gap-5">
    {failed && <p role="alert" className="rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">{failed} Use Refresh workspace to try again.</p>}
    <PageMetrics items={metrics}/>
    {canReadPayments && (activity ? <div className="dashboard-visual-grid">
      <ActivityChart activity={activity} action={() => navigate(permissions.includes("reports:read") ? "activity" : "payments")} scope={summary.data?.activity ? "All company payment records" : "Shown recent payment records"}/>
      <CompositionCard title="Payment types" total={activity.total} action={() => navigate("payments")} detail={summary.data?.activity ? "All company payment records" : "Shown recent payment records"} items={[{label:"Payroll",value:activity.kinds.payroll},{label:"Invoices",value:activity.kinds.invoices},{label:"Other",value:activity.kinds.other}]}/>
      <AttentionCard action={() => { setPaymentView("attention"); document.getElementById("dashboard-recent")?.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",block:"start"}); }} items={[{label:"Drafts",value:activity.statuses.draft ?? 0,status:"open"},{label:"Needs funds",value:activity.statuses.approved_unfunded ?? 0,status:"review"},{label:"Held / partial",value:(activity.statuses.held ?? 0)+(activity.statuses.partially_paid ?? 0),status:"review"}]}/>
    </div> : <InsightState titles={["Payment activity","Payment types","Needs attention"]} error={!!summary.error}/>)}
    <div className="dashboard-lower-grid">
      <div id="dashboard-recent" className="dashboard-recent-card min-w-0 scroll-mt-6">{canReadPayments ? <Panel title="Recent payments" action={<div className="flex flex-wrap items-center gap-2"><div role="group" aria-label="Payment overview filter" className="flex w-fit flex-wrap gap-1 rounded-full bg-white p-1"><button type="button" aria-pressed={paymentView === "recent"} onClick={() => setPaymentView("recent")} className={`rounded-full px-4 py-2 text-xs font-medium ${paymentView === "recent" ? "bg-foreground text-white" : "text-muted-foreground hover:bg-muted"}`}>All recent</button><button type="button" aria-pressed={paymentView === "attention"} onClick={() => setPaymentView("attention")} className={`rounded-full px-4 py-2 text-xs font-medium ${paymentView === "attention" ? "bg-foreground text-white" : "text-muted-foreground hover:bg-muted"}`}>Needs attention{summary.data ? ` (${summary.data.openCount})` : ""}</button></div><button className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-medium hover:bg-secondary" onClick={() => navigate("payments")}>View all<ArrowUpRight size={14}/></button></div>}>

          {paymentView === "recent" ? <>{recent.error && <p role="alert" className="mb-4 rounded-xl border border-destructive/20 p-3 text-sm text-destructive">{recent.error}</p>}
          {recent.loading ? <div role="status" aria-label="Loading recent payments" className="grid gap-4">{[0,1,2].map(row => <div key={row} className="h-14 animate-pulse rounded-xl bg-white"/>)}</div> : recent.data?.payments.length ? <div className="divide-y">{recent.data.payments.slice(0,3).map(payment => <button type="button" key={payment.id} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4 text-left sm:grid-cols-[minmax(0,1fr)_auto_130px]" onClick={() => navigate("payments", payment.id)}><div className="min-w-0"><p className="truncate text-sm font-medium">{payment.recipientName ?? "Recorded payee"}</p><p className="mt-1 truncate text-xs text-muted-foreground">{paymentLabel(payment)}</p></div><p className="text-right text-sm font-medium tabular-nums">{usd(payment.amount)}</p><div className="col-span-2 sm:col-span-1 sm:justify-self-end"><Status value={payment.status}/></div></button>)}</div> : !recent.error && <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl bg-white/70 px-5 py-8 text-center"><span className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary"><Send size={23} strokeWidth={1.5}/></span><h3 className="mt-5 text-base font-medium">Your payments start here</h3>{canPrepare && <button onClick={() => { navigate("payments"); focusWorkspaceForm("payment-compose"); }} className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"><Plus size={16}/>Create a payment</button>}</div>}</> : <>{summary.loading ? <div role="status" aria-label="Loading payment obligations" className="grid gap-4">{[0,1,2].map(row => <div key={row} className="h-14 animate-pulse rounded-xl bg-white"/>)}</div> : !summary.data ? <p className="rounded-xl bg-white px-5 py-10 text-center text-sm text-muted-foreground">Payment obligations could not be loaded.</p> : !summary.data.attention.length ? <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl bg-white/70 px-5 py-8 text-center"><span className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary"><Send size={23} strokeWidth={1.5}/></span><h3 className="mt-5 text-base font-medium">{summary.data.paidCount > 0 ? "You're all caught up" : "Your payments start here"}</h3>{canPrepare && <button onClick={() => { navigate("payments"); focusWorkspaceForm("payment-compose"); }} className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"><Plus size={16}/>Create a payment</button>}</div> : <><div className="divide-y">{summary.data.attention.slice(0,6).map(item => <button type="button" key={item.billId ?? item.rootPaymentId} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4 text-left sm:grid-cols-[minmax(0,1fr)_auto_180px]" onClick={() => item.state === "needs_installment" && item.billId ? openInvoice(item.billId) : navigate("payments", ["needs_remainder", "needs_replacement"].includes(item.state) ? item.rootPaymentId : item.payment.id)}><div className="min-w-0"><p className="truncate text-sm font-medium">{item.recipientName}</p><p className="mt-1 truncate text-xs text-muted-foreground">{paymentLabel(item.payment)}{item.payment.scheduled_for ? ` · ${dateLabel(item.payment.scheduled_for)}` : ""}</p></div><p className="text-right text-sm font-medium tabular-nums">{usd(item.outstandingPrincipal)}</p><div className="col-span-2 sm:col-span-1 sm:justify-self-end"><Status value={item.state}/></div></button>)}</div>{summary.data.attention.length > 6 && <button className="mt-4 text-xs font-medium text-primary" onClick={() => navigate("payments")}>Review all open payments</button>}</>}</>}
        </Panel> : <Panel title="Your company workspace" ><button className="inline-flex items-center gap-2 text-sm text-primary" onClick={() => navigate("settings")}>Company settings<ArrowUpRight size={16}/></button></Panel>}</div>
      {canReadPayments && <FinanceCard title="Company balance" value={failed ? "Unavailable" : treasury ? usd(treasury.available) : "..."} unit="Available USDC" meter={{value:treasury && !failed ? proportion(treasury.available,treasury.balance) : 0,label:treasury && !failed ? `${usd(treasury.available)} available of ${usd(treasury.balance)} confirmed` : "Treasury balance loading",left:"Available funds",right:treasury && !failed ? usd(treasury.balance) : "..."}} stats={[{label:"Reserved USDC",value:treasury && !failed ? usd(treasury.totalReserved ?? treasury.reserved) : "..."},{label:"Open obligations",value:failed ? "..." : summary.data?.openCount ?? "..."},{label:"Funding gap",value:summary.data && !failed ? usd(summary.data.fundingGap) : "..."}]} action={<button className="dashboard-glass-button" onClick={() => navigate("treasury")} aria-label="Open company treasury"><ArrowUpRight size={17}/></button>}/>}
    </div>
    {summary.data && BigInt(summary.data.uncommittedInvoicePrincipal) > 0n && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted px-5 py-4 text-sm"><span>Invoices needing installments</span><button type="button" className="font-medium text-primary tabular-nums" onClick={() => navigate("bills")}>{usd(summary.data.uncommittedInvoicePrincipal)}</button></div>}
    {actions.length > 0 && <div className="flex flex-wrap gap-2">{actions.map(action => <button key={action.title} className="inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2.5 text-xs hover:bg-secondary" onClick={() => { navigate(action.section); focusWorkspaceForm(action.formId); }}><action.icon size={14}/>{action.title}<ArrowUpRight size={12} className="text-muted-foreground"/></button>)}</div>}
    {needsSetup && <Panel collapsible title="Finish company setup" description={`${complete} of ${visibleSteps.length} steps complete.`}><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{visibleSteps.map(step => <button key={step.title} className="flex items-center gap-2 rounded-xl bg-white p-3 text-left text-xs hover:bg-secondary/40" onClick={() => step.href ? appNavigate(step.href) : navigate(step.section)}>{step.done ? <Check size={14} className="shrink-0 text-primary"/> : <Circle size={14} className="shrink-0 text-muted-foreground"/>}<span>{step.title}</span></button>)}</div></Panel>}
    <p className="text-[10px] leading-5 text-muted-foreground">{treasury?.config?.network === "testnet" ? "Your treasury is on NEAR testnet. Intents settlement requires mainnet." : treasury?.lastSyncedAt ? `Synced ${new Date(treasury.lastSyncedAt).toLocaleString()} · USDC` : "USDC · Treasury not synced"}</p>
  </div>;
}
