"use client";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, CalendarDays, Check, ChevronRight, Circle, Plus, ReceiptText, Send, ShieldCheck, Users, Wallet } from "lucide-react";
import { usd, dateLabel } from "@/lib/format";
import { hasPermissions } from "@/lib/workspace-access";
import { TokenLogo } from "@/components/assets/asset-identity";
import { useWorkspace } from "./context";
import { focusWorkspaceForm } from "./page-metrics";
import { paymentLabel } from "@/lib/payment-label";
import { useResource } from "./hooks";
import { DataTable, Panel, Status } from "./shared";
import type { Payment, Section, Treasury } from "./types";

interface Summary {
  openPrincipal: string; uncommittedInvoicePrincipal: string; fundingGap: string;
  openCount: number; paidCount: number; treasury: Treasury;
  attention: Array<{ payment: Payment; recipientName: string; outstandingPrincipal: string; state: string; rootPaymentId: string; billId?: string }>;
}

export function Overview() {
  const { base, revision, recipients, recipientsLoading, recipientsError, navigate, organization, session } = useWorkspace();
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
    { title: "Link your signing wallet", done: signerLinked, section: "treasury", detail: "Verify a NEAR wallet to approve company actions.", href: "/account", show: canManage || canPrepare },
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
  const metrics = [
    { label: "Available balance", value: treasury ? usd(treasury.available) : null, detail: "USDC ready for company payments", icon: Wallet },
    { label: "Reserved funds", value: treasury ? usd(treasury.totalReserved ?? treasury.reserved) : null, detail: "Protected for payments and client earmarks", icon: ShieldCheck },
    ...(canReadPayments ? [
      { label: "Outstanding payments", value: summary.data ? usd(summary.data.openPrincipal) : null, detail: summary.data ? `${summary.data.openCount} open obligations, including invoice debt` : "All open company obligations", icon: ReceiptText },
      { label: "Funding gap", value: summary.data ? usd(summary.data.fundingGap) : null, detail: "Extra funds needed for current payment budgets", icon: ArrowDownLeft },
    ] : []),
  ];
  const failed = summary.error || balance.error;
  return <div className="grid min-w-0 gap-7 sm:gap-9">
    {failed && <p role="alert" className="rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">{failed} Use Refresh workspace to try again.</p>}
    <div className={`grid gap-y-7 py-2 sm:grid-cols-2 ${canReadPayments ? "xl:grid-cols-4" : "xl:grid-cols-2"}`}>
      {metrics.map((metric, index) => <section key={metric.label} aria-label={metric.label} className={`min-w-0 sm:px-6 sm:even:border-l sm:first:pl-0 ${canReadPayments ? "xl:border-l xl:first:border-l-0" : ""}`}>
        <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{metric.label}</p>{index === 0 ? <TokenLogo symbol="USDC" size={22}/> : <metric.icon size={16} strokeWidth={1.5} className="text-muted-foreground"/>}</div>
        {metric.value !== null ? <p className="mt-4 break-words text-[clamp(1.75rem,2.8vw,2.75rem)] font-normal leading-none tracking-[-.055em] tabular-nums">{metric.value}</p> : failed ? <p className="mt-4 text-2xl text-muted-foreground">Unavailable</p> : <div role="status" aria-label={`Loading ${metric.label}`} className="mt-4 h-11 w-40 animate-pulse rounded-lg bg-muted"/>}
        <p className="mt-4 text-xs leading-5 text-muted-foreground">{metric.detail}</p>
      </section>)}
    </div>
    {summary.data && BigInt(summary.data.uncommittedInvoicePrincipal) > 0n && <div className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-5 py-4 text-sm"><ReceiptText size={17} className="mt-0.5 shrink-0 text-primary"/><p className="leading-6">{usd(summary.data.uncommittedInvoicePrincipal)} of invoice debt needs future installments. This is included in outstanding payments and is separate from the current funding gap.</p></div>}
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid min-w-0 gap-5">
        {canReadPayments ? <Panel title="Recent payments" description="Your latest payment records and obligations to review." action={<button className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-medium hover:bg-secondary" onClick={() => navigate("payments")}>View all<ArrowUpRight size={14}/></button>}>
          <div role="group" aria-label="Payment overview filter" className="mb-5 flex w-fit flex-wrap gap-1 rounded-full bg-white p-1"><button type="button" aria-pressed={paymentView === "recent"} onClick={() => setPaymentView("recent")} className={`rounded-full px-4 py-2 text-xs font-medium ${paymentView === "recent" ? "bg-foreground text-white" : "text-muted-foreground hover:bg-muted"}`}>All recent</button><button type="button" aria-pressed={paymentView === "attention"} onClick={() => setPaymentView("attention")} className={`rounded-full px-4 py-2 text-xs font-medium ${paymentView === "attention" ? "bg-foreground text-white" : "text-muted-foreground hover:bg-muted"}`}>Needs attention{summary.data ? ` (${summary.data.openCount})` : ""}</button></div>
          {paymentView === "recent" ? <>{recent.error && <p role="alert" className="mb-4 rounded-xl border border-destructive/20 p-3 text-sm text-destructive">{recent.error}</p>}
          {recent.loading ? <div role="status" aria-label="Loading recent payments" className="grid gap-4">{[0,1,2].map(row => <div key={row} className="h-14 animate-pulse rounded-xl bg-white"/>)}</div> : recent.data?.payments.length ? <DataTable columns={["Payee / reference", "Amount", "Status", "Created"]}>{recent.data.payments.map(payment => <tr key={payment.id}><td><button className="text-left font-medium hover:text-primary" onClick={() => navigate("payments", payment.id)}>{payment.recipientName ?? "Recorded payee"}<span className="mt-1 block text-xs font-normal text-muted-foreground">{paymentLabel(payment)}</span></button></td><td className="whitespace-nowrap tabular-nums">{usd(payment.amount)}</td><td><Status value={payment.status}/></td><td className="whitespace-nowrap text-xs text-muted-foreground">{dateLabel(payment.created_at)}</td></tr>)}</DataTable> : !recent.error && <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl bg-white/70 px-5 py-8 text-center"><span className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary"><Send size={23} strokeWidth={1.5}/></span><h3 className="mt-5 text-base font-medium">Your payments start here</h3><p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">Your company's payment records will appear here. Prepare a payment or your team's first pay run.</p>{canPrepare && <button onClick={() => { navigate("payments"); focusWorkspaceForm("payment-compose"); }} className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"><Plus size={16}/>Create a payment</button>}</div>}</> : <>{summary.loading ? <div role="status" aria-label="Loading payment obligations" className="grid gap-4">{[0,1,2].map(row => <div key={row} className="h-14 animate-pulse rounded-xl bg-white"/>)}</div> : !summary.data ? <p className="rounded-xl bg-white px-5 py-10 text-center text-sm text-muted-foreground">Payment obligations could not be loaded.</p> : !summary.data.attention.length ? <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl bg-white/70 px-5 py-8 text-center"><span className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary"><Send size={23} strokeWidth={1.5}/></span><h3 className="mt-5 text-base font-medium">{summary.data.paidCount > 0 ? "You're all caught up" : "Your payments start here"}</h3><p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">{summary.data.paidCount > 0 ? "There are no outstanding payments to review." : "Create a payment, prepare payroll or add a supplier invoice to get started."}</p>{canPrepare && <button onClick={() => { navigate("payments"); focusWorkspaceForm("payment-compose"); }} className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"><Plus size={16}/>Create a payment</button>}</div> : <><DataTable columns={["Payee / reference", "Outstanding", "Scheduled", "Status"]}>{summary.data.attention.slice(0,6).map(item => <tr key={item.billId ?? item.rootPaymentId}><td><button className="text-left font-medium hover:text-primary" onClick={() => item.state === "needs_installment" ? navigate("bills") : navigate("payments", ["needs_remainder", "needs_replacement"].includes(item.state) ? item.rootPaymentId : item.payment.id)}>{item.recipientName}<span className="mt-1 block text-xs font-normal text-muted-foreground">{paymentLabel(item.payment)}</span></button></td><td className="whitespace-nowrap tabular-nums">{usd(item.outstandingPrincipal)}</td><td className="whitespace-nowrap text-xs text-muted-foreground">{dateLabel(item.payment.scheduled_for)}</td><td><Status value={item.state}/>{item.payment.hold_reason && <p className="mt-2 max-w-52 text-xs leading-5 text-amber-900">{item.payment.hold_reason}</p>}</td></tr>)}</DataTable>{summary.data.attention.length > 6 && <button className="mt-4 text-xs font-medium text-primary" onClick={() => navigate("payments")}>Review all open payments</button>}</>}</>}
        </Panel> : <Panel title="Your company workspace" description="Your role can view company information. Ask an administrator if you need payment access."><button className="inline-flex items-center gap-2 text-sm text-primary" onClick={() => navigate("settings")}>Company settings<ArrowUpRight size={16}/></button></Panel>}

      </div>
      <div className="grid min-w-0 gap-5">
        {actions.length > 0 && <Panel title="Quick actions" description="Keep your business moving."><div className="grid gap-1">{actions.map(action => <button key={action.title} className="group flex items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white" onClick={() => { navigate(action.section); focusWorkspaceForm(action.formId); }}><span className="grid size-10 shrink-0 place-items-center rounded-full border border-white bg-white text-foreground group-hover:text-primary"><action.icon size={18} strokeWidth={1.6}/></span><span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{action.title}</span><span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">{action.detail}</span></span><ArrowUpRight size={15} className="shrink-0 text-muted-foreground group-hover:text-primary"/></button>)}</div></Panel>}
        {canReadPayments && <section className="rounded-[1.25rem] bg-primary p-6 text-white"><div className="flex items-center justify-between"><h2 className="text-base font-medium">Funding status</h2><TokenLogo symbol="USDC" size={24}/></div><p className="mt-5 text-lg font-medium tracking-tight">{summary.data ? !summary.data.openCount ? "No open obligations" : BigInt(summary.data.fundingGap) > 0n ? "More funds needed" : "Current budgets covered" : failed ? "Status unavailable" : "Checking payment budgets..."}</p><p className="mt-3 text-xs text-white/80">Current payment funding gap</p><p className="mt-1 text-3xl font-normal tracking-tight tabular-nums">{summary.data ? usd(summary.data.fundingGap) : failed ? "N/A" : "..."}</p><p className="mt-3 text-[11px] leading-5 text-white/80">After protected payment funds and available company cash. Future invoice installments are separate.</p><button onClick={() => navigate("treasury")} className="mt-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-xs font-medium text-white hover:bg-white/25">Open treasury<ArrowUpRight size={13}/></button>{summary.data && <p className="mt-5 border-t border-white/20 pt-4 text-[11px] text-white/80">{summary.data.paidCount.toLocaleString()} completed payments · {summary.data.openCount.toLocaleString()} open obligations</p>}</section>}
        {needsSetup && <Panel title="Finish your setup" description={`${complete} of ${visibleSteps.length} steps complete.`}>
          <div className="grid gap-3">{visibleSteps.filter(step => !step.done).slice(0,2).map(step => <button key={step.title} className="flex items-start gap-3 rounded-xl bg-white/75 p-3 text-left hover:bg-white" onClick={() => step.href ? window.location.assign(step.href) : navigate(step.section)}><span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-primary"><Circle size={12}/></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{step.title}</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{step.detail}</span></span><ChevronRight size={13} className="mt-1 shrink-0 text-muted-foreground"/></button>)}</div>
          <details className="mt-4 text-xs"><summary className="cursor-pointer font-medium text-muted-foreground">All setup steps</summary><div className="mt-3 grid gap-1">{visibleSteps.map(step => <button key={step.title} className="flex items-center gap-2 rounded-lg p-2 text-left hover:bg-white" onClick={() => step.href ? window.location.assign(step.href) : navigate(step.section)}>{step.done ? <Check size={13} className="shrink-0 text-primary"/> : <Circle size={13} className="shrink-0 text-muted-foreground"/>}<span>{step.title}</span></button>)}</div></details>
        </Panel>}
        {permissions.includes("recipients:read") && <button onClick={() => navigate("recipients")} className="flex items-center gap-3 rounded-2xl border border-border px-5 py-4 text-left hover:bg-muted"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted"><Users size={17}/></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">Payee directory</span><span className="mt-1 block text-xs text-muted-foreground">{recipientsLoading ? "Loading your payees..." : recipientsError ? "Directory unavailable" : `${recipients.length.toLocaleString()} employees, contractors and suppliers`}</span></span><ArrowUpRight size={15} className="text-muted-foreground"/></button>}
      </div>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{treasury?.config?.network === "testnet" ? "Your treasury is on NEAR testnet. Cross-chain Intents settlement requires mainnet." : treasury?.lastSyncedAt ? `Treasury last synced ${new Date(treasury.lastSyncedAt).toLocaleString()}. All amounts above are recorded in USDC.` : "Sync your treasury to check confirmed funds. All amounts above are recorded in USDC."}</p>
  </div>;
}
