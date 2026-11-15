"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { AssetIdentity, TokenLogo } from "@/components/assets/asset-identity";
import { api, RequestError } from "@/lib/api";
import { assertBillingReview, billingWalletActions } from "@/lib/billing-review";
import { dateLabel } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./task-drawer";
import { signNearActions } from "@/lib/near-actions";
import type { BillingPlanVersion } from "@/server/billing/types";
import type { BillingOverview, BillingInvoiceDetail, BillingInvoicePage } from "@/server/billing/payment-types";
import { OptionalCapabilityUsage, OptionalPlanCapabilities } from "./billing-capabilities";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, DataTable, Empty, Field, Panel, Status } from "./shared";
import type { Section } from "./types";

export function BillingAccessNotice({ section }: { section: Section }) {
  const { billing, navigate } = useWorkspace();
  if (!billing) return null;
  const exhausted = billing.usage.aiAttempts >= billing.limits.aiAttempts;
  const message = section === "payroll" && !billing.features.batch_payroll
    ? "Batch payroll needs a company plan. Manual payments and existing pay-run records remain available."
    : section === "payments" && !billing.features.recurring
      ? "New recurring automation needs a company plan. Existing payment monitoring and recovery remain available."
      : section === "assistant" && (!billing.features.private_ai || exhausted)
        ? exhausted && billing.features.private_ai
          ? "This company's private-AI attempt allowance is used for the current period. Manual invoice entry and retained evidence remain available."
          : "New private-AI analysis needs a company plan. Manual invoice entry and retained evidence remain available."
        : section === "clearing" && !billing.features.clearing
          ? "New business clearing proposals need a company plan. Existing rounds and recovery remain available."
          : null;
  if (!message) return null;
  return <div role="status" className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted p-4 text-sm"><div className="min-w-0"><p>{message}</p>{!billing.canManage && <p className="mt-1 text-xs text-muted-foreground">Ask your company owner to review the plan.</p>}</div><button type="button" className="shrink-0 text-primary" onClick={() => navigate("billing")}>View company plan</button></div>;
}

export function Billing() {
  const { billing, billingError, refresh } = useWorkspace();
  if (billingError) return <Panel title="Company plan"><p role="alert" className="text-sm text-destructive">{billingError}</p><Action type="button" className="mt-4" onClick={refresh}>Refresh company plan</Action></Panel>;
  if (!billing) return <Panel title="Company plan"><Empty>Loading the company's plan and usage...</Empty></Panel>;
  return <div className="grid gap-6">
    <Panel title="Company plan">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xl font-semibold">{billing.plan.name}</p></div><Status value={billing.status}/></div>
      {billing.pilot && <p role="status" className="mt-4 rounded-lg bg-muted p-4 text-sm">Complimentary pilot access</p>}
      <dl className="mt-5 grid gap-4 sm:grid-cols-3"><div className="rounded-2xl border border-border bg-white p-5"><dt className="text-xs text-muted-foreground">Finance seats</dt><dd className="mt-3 text-2xl font-normal tracking-tight tabular-nums">{billing.usage.financeSeats} / {billing.limits.financeSeats}</dd></div><div className="rounded-2xl border border-border bg-white p-5"><dt className="text-xs text-muted-foreground">Private-AI attempts</dt><dd className="mt-3 text-2xl font-normal tracking-tight tabular-nums">{billing.usage.aiAttempts} / {billing.limits.aiAttempts}</dd><p className="mt-2 text-xs text-muted-foreground">{billing.usage.aiCompleted} completed · {billing.usage.aiFailed} failed</p></div><div className="rounded-2xl border border-border bg-white p-5"><dt className="text-xs text-muted-foreground">Usage period</dt><dd className="mt-2 text-sm font-medium">{billing.period ? `${new Date(billing.period.startsAt).toLocaleDateString()} to ${new Date(billing.period.endsAt).toLocaleDateString()}` : "Calendar-month allowance"}</dd>{billing.paidThrough && <p className="mt-2 text-xs text-muted-foreground">Paid access through {new Date(billing.paidThrough).toLocaleDateString()}.</p>}</div></dl>
      <p className="mt-4 text-xs text-muted-foreground">0% Razor transfer markup · Network costs separate</p>
    </Panel>
    <OptionalCapabilityUsage value={billing.optionalCapabilities} />
    {billing.canManage && <OwnerBilling />}
    {!billing.canManage && <Panel title="Plan management"><p className="text-sm text-muted-foreground">Your company owner manages plans and subscription payments.</p></Panel>}
  </div>;
}


function InvoiceStatus({ value }: { value: string }) {
  const labels: Record<string, string> = { prepared: "ready_to_review", claimed: "wallet_confirmation_started", submitted: "verifying_payment", credit_required: "billing_review_required" };
  return <Status value={labels[value] || value}/>;
}

const features = [
  ["batch_payroll", "Batch payroll"],
  ["recurring", "Recurring automation"],
  ["private_ai", "Private AI"],
  ["clearing", "New business clearing proposals"],
] as const;

function OwnerBilling() {
  const { base, revision, refresh, notify } = useWorkspace();
  const overview = useResource<BillingOverview>(`${base}/billing`, revision);
  const [page, setPage] = useState(1), [invoiceId, setInvoiceId] = useState(""), [payer, setPayer] = useState(""), [cancelConfirmed, setCancelConfirmed] = useState(false);
  const requests = useRef(new Map<string, { requestKey: string; invoiceId?: string }>()), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const forgetRequest = useCallback((id: string) => { for (const [key, request] of requests.current) if (request.invoiceId === id) requests.current.delete(key); }, []);
  const invoices = useResource<BillingInvoicePage>(`${base}/billing/invoices?page=${page}&pageSize=25`, revision);
  const { run, busy, error } = useAction();
  useEffect(() => {
    const read = () => {const id=new URLSearchParams(window.location.search).get("invoice") || "";setInvoiceId(id);if(id)requestAnimationFrame(()=>openTaskDrawer("billing-invoice-flow"));};
    read(); window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  function openInvoice(id: string) {
    setInvoiceId(id);
    if(id)requestAnimationFrame(()=>openTaskDrawer("billing-invoice-flow"));else closeTaskDrawer("billing-invoice-flow");
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("invoice", id); else url.searchParams.delete("invoice");
    window.history.replaceState(null, "", url.pathname + url.search);
  }
  async function prepare(plan: BillingPlanVersion) {
    if (!overview.data) return;
    const selected = payer || overview.data.payerAccounts[0];
    if (!selected) throw new RequestError("Link a verified NEAR wallet for subscription payments first.", 409, "BILLING_PAYER_REQUIRED");
    const key = `${plan.id}:${selected}:${overview.data.subscriptionState.revision}`;
    const request = requests.current.get(key) ?? { requestKey: crypto.randomUUID() };
    requests.current.set(key, request);
    const detail = await api<BillingInvoiceDetail>(`${base}/billing/checkout`, { planVersionId: plan.id, payerAccount: selected, requestKey: request.requestKey });
    request.invoiceId = detail.invoice.id;
    if (!active.current) return;
    closeTaskDrawer("billing-plan-flow",true);openInvoice(detail.invoice.id); refresh();
  }
  const current = overview.data;
  return <>
    {error && <p role="alert" className="rounded-2xl border border-border bg-white p-5 text-sm text-destructive">{error}</p>}
    <div className="flex justify-end"><Action type="button" onClick={()=>openTaskDrawer("billing-plan-flow")}>Compare company plans</Action></div><TaskDrawer id="billing-plan-flow" title="Choose a plan" wide><div aria-busy={!!busy}>    <div className="grid gap-5">
      {overview.error ? <p role="alert" className="text-sm text-destructive">{overview.error}</p> : !current ? <Empty>Loading company subscription options...</Empty> : <div className="grid gap-5">
        {!current.checkout.ready && <div role="status" className="rounded-lg border bg-muted p-4 text-sm"><p className="font-medium">Subscription checkout needs setup</p><p className="mt-2 text-muted-foreground">{current.checkout.reason || "The operator must configure and verify the NEAR billing deployment before collecting payments."}</p><p className="mt-2 text-xs text-muted-foreground">Plan information and existing receipts stay available. No payment has been requested.</p></div>}
        {current.checkout.testnet && <p role="status" className="text-sm text-amber-900">This is NEAR testnet billing. Test token payments do not establish live USDC revenue.</p>}
        {current.payerAccounts.length ? <Field label="Pay from" hint={`NEAR ${current.checkout.network}`}><select className={control} value={payer || current.payerAccounts[0]} disabled={!!busy} onChange={event => setPayer(event.target.value)}>{current.payerAccounts.map(account => <option key={account} value={account}>{account}</option>)}</select></Field> : <p className="text-sm text-muted-foreground">Link a verified NEAR wallet on {current.checkout.network} to pay a subscription. <a className="text-primary" href="/account">Open account and wallet setup</a></p>}
        <div className="grid gap-4 xl:grid-cols-3">{current.plans.map(plan => <article key={plan.id} className={`flex min-w-0 flex-col gap-5 rounded-2xl border p-6 ${plan.id === current.entitlements.plan.id ? "border-primary/30 bg-secondary/50" : "border-border bg-muted/50"}`}><div><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{plan.name}</h3>{plan.id === current.entitlements.plan.id && <Status value={current.entitlements.pilot ? "pilot" : "active"}/>}</div><div className="mt-5 flex flex-wrap items-center gap-2"><TokenLogo symbol="USDC" size={22}/><p className="text-4xl font-normal tracking-tight tabular-nums">{formatUnits(plan.monthlyAmount,6)}</p><span className="self-end pb-1 text-xs text-muted-foreground">USDC / month</span></div><p className="mt-1 text-xs text-muted-foreground">Per company workspace</p></div><ul className="grid gap-2 text-sm"><li>{plan.limits.financeSeats} finance seats</li><li>{plan.limits.aiAttempts} private-AI attempts per usage period</li>{features.filter(([feature]) => plan.features[feature]).map(([feature, label]) => <li key={feature} className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0 text-primary"/>{label}</li>)}</ul><details className="rounded-xl border border-border bg-white/60 p-3 text-xs"><summary className="cursor-pointer font-medium">View plan allowances</summary><div className="mt-4"><OptionalPlanCapabilities policy={plan.capabilityPolicy}/></div></details><div className="mt-auto grid gap-3">{BigInt(plan.monthlyAmount) > 0n ? <Action type="button" disabled={!!busy || !current.checkout.ready || !current.payerAccounts.length} busy={busy === plan.id} onClick={() => void run(plan.id, () => prepare(plan))}>Review {plan.name} payment</Action> : !current.subscriptionState.paidThrough ? <p className="text-xs text-muted-foreground">Available without a subscription payment.</p> : null}{current.subscriptionState.paidThrough && current.subscriptionState.currentPeriod?.planVersionId !== plan.id && <button type="button" disabled={!!busy} className="text-left text-sm text-primary disabled:opacity-50" onClick={() => void run(`schedule:${plan.id}`, async () => { await api(`${base}/billing/plan-change`, { planVersionId: plan.id }); refresh(); notify("Your next-period preference was saved. A paid plan still requires its explicit subscription payment."); })}>Choose after prepaid access ends</button>}</div></article>)}</div>
        <p className="text-xs text-muted-foreground">Manual renewal · AI usage includes failed attempts · Network costs separate</p>
      </div>}
    </div>{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}</div></TaskDrawer>
    {current && <Panel collapsible title="Renewal settings" tone="muted"><div className="grid gap-4 text-sm"><p>{current.subscriptionState.paidThrough ? `Prepaid access ends ${dateLabel(current.subscriptionState.paidThrough)}.` : "No prepaid subscription period is active."}</p>{current.subscriptionState.nextPeriod && <p>A prepaid next period runs {dateLabel(current.subscriptionState.nextPeriod.startsAt)} to {dateLabel(current.subscriptionState.nextPeriod.endsAt)}.</p>}{current.subscriptionState.scheduledPlan && <p>Preferred next plan: <strong>{current.subscriptionState.scheduledPlan.name}</strong>. A paid next period requires its corresponding confirmed payment; otherwise this workspace returns to Free when prepaid access ends.</p>}{current.subscriptionState.cancelAtPeriodEnd ? <div className="space-y-3"><p>Cancellation is scheduled. Existing prepaid access, financial records and fund recovery remain available.</p><Action type="button" disabled={!!busy} busy={busy === "resume"} onClick={() => void run("resume", async () => { await api(`${base}/billing/resume`, {}); refresh(); notify("Cancellation was removed. No renewal payment was sent."); })}>Remove scheduled cancellation</Action></div> : current.subscriptionState.paidThrough && <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void run("cancel", async () => { await api(`${base}/billing/cancel`, {}); setCancelConfirmed(false); refresh(); notify("Paid-plan cancellation was scheduled. Prepaid access and financial recovery remain available."); }); }}><label className="flex items-start gap-2"><input type="checkbox" required className="mt-1" checked={cancelConfirmed} onChange={event => setCancelConfirmed(event.target.checked)} disabled={!!busy}/><span>End my paid plan after prepaid access. Refund requests are separate.</span></label><div><Action type="submit" disabled={!!busy || !cancelConfirmed} busy={busy === "cancel"}>End paid plan at period end</Action></div></form>}</div></Panel>}
    <TaskDrawer id="billing-invoice-flow" title="Subscription invoice">{invoiceId && <BillingInvoiceReview key={invoiceId} invoiceId={invoiceId} close={() => openInvoice("")} onResolved={forgetRequest}/>}</TaskDrawer>
    <Panel title="Subscription invoices" tone="white" action={<a className="inline-flex items-center gap-2 text-sm text-primary" href={`/api${base}/billing/export`} download><Download size={15}/>Export billing CSV</a>}>
      {invoices.error && <p role="alert" className="mb-4 text-sm text-destructive">{invoices.error}</p>}
      {invoices.loading ? <Empty>Loading subscription invoices...</Empty> : !invoices.data?.invoices.length ? <Empty>No subscription invoices. Choosing a paid plan prepares a reviewable invoice before any payment.</Empty> : <div className="divide-y">{invoices.data.invoices.map(invoice=><button type="button" key={invoice.id} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4 text-left sm:grid-cols-[minmax(0,1fr)_auto_170px]" onClick={()=>openInvoice(invoice.id)}><div className="min-w-0"><p className="text-sm font-medium">{invoice.plan.name}</p><p className="mt-1 text-xs text-muted-foreground">{dateLabel(invoice.createdAt)} · {invoice.purchase.kind}</p></div><div className="text-right text-sm tabular-nums">{formatUnits(invoice.amount,6)} USDC{BigInt(invoice.refundedAmount)>0n && <p className="mt-1 text-xs text-muted-foreground">{formatUnits(invoice.refundedAmount,6)} refunded</p>}</div><div className="col-span-2 sm:col-span-1 sm:justify-self-end"><InvoiceStatus value={invoice.status}/>{invoice.refundRequest && <p className="mt-1 text-xs text-muted-foreground">Refund {invoice.refundRequest.status}</p>}</div></button>)}</div>}
      {invoices.data && (page>1||invoices.data.hasMore) && <nav aria-label="Subscription invoice pages" className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">{(invoices.data.page - 1) * invoices.data.pageSize + 1}-{Math.min(invoices.data.page * invoices.data.pageSize, invoices.data.total)} of {invoices.data.total} invoices</p><div className="flex items-center gap-4"><Action type="button" disabled={invoices.loading || page <= 1} onClick={() => setPage(value => value - 1)}>Previous invoices</Action><span>Page {invoices.data.page}</span><Action type="button" disabled={invoices.loading || !invoices.data.hasMore} onClick={() => setPage(value => value + 1)}>Next invoices</Action></div></nav>}
    </Panel>
  </>;
}

function BillingInvoiceReview({ invoiceId, close, onResolved }: { invoiceId: string; close: () => void; onResolved: (invoiceId: string) => void }) {
  const { base, revision, refresh, notify } = useWorkspace();
  const endpoint = `${base}/billing/invoices/${encodeURIComponent(invoiceId)}`;
  const resource = useResource<BillingInvoiceDetail>(endpoint, revision);
  const [detail, setDetail] = useState<BillingInvoiceDetail | null>(null), [acknowledged, setAcknowledged] = useState(false), [savedHash, setSavedHash] = useState("");
  const [clock, setClock] = useState(Date.now);
  const [task,setTask] = useState<"payment"|"recovery"|"refund">("payment");
  const { run, busy, error } = useAction();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (resource.data) { setDetail(resource.data); setAcknowledged(false); } else if (!resource.loading && resource.error) { setDetail(null); setAcknowledged(false); } }, [resource.data, resource.loading, resource.error]);
  useEffect(() => {
    setClock(Date.now());
    if (!detail || Date.parse(detail.invoice.expiresAt) <= Date.now()) return;
    const timer = setTimeout(() => { setClock(Date.now()); setAcknowledged(false); }, Math.min(2_147_483_647, Date.parse(detail.invoice.expiresAt)-Date.now()+50));
    return () => clearTimeout(timer);
  }, [detail?.invoice.expiresAt]);
  useEffect(() => { if (detail && ["paid", "credit_required", "refunded", "expired", "cancelled"].includes(detail.invoice.status)) onResolved(detail.invoice.id); }, [detail, onResolved]);
  async function reconcile(transactionHash?: string) {
    if (transactionHash) await api(`${endpoint}/submitted`, { transactionHash });
    const fresh = await api<BillingInvoiceDetail>(`${endpoint}/reconcile`, {});
    setDetail(fresh); setAcknowledged(false); refresh();
    if (fresh.invoice.status === "paid") notify("The final NEAR invoice payment was verified. Review the updated subscription period.");
    else if (fresh.invoice.status === "credit_required") notify("The payment was recorded and needs billing recovery. Review its credit or refund status before paying again.");
  }
  async function pay() {
    if (!detail || !acknowledged) return;
    const claimed = await api<BillingInvoiceDetail>(`${endpoint}/claim`, {});
    if (!active.current) return;
    setDetail(claimed);
    if (!claimed.canSign || !claimed.walletActions.length) { setAcknowledged(false); refresh(); return; }
    try { assertBillingReview(detail, claimed); }
    catch (cause) { setAcknowledged(false); throw cause; }
    const hash = await withTaskDrawerWallet(()=>signNearActions(billingWalletActions(claimed), claimed.network, [claimed.invoice.payerAccount]));
    setAcknowledged(false);
    if (hash) setSavedHash(hash);
    try { await reconcile(hash ?? undefined); }
    finally { refresh(); }
  }
  const invoice = detail?.invoice;
  const offerExpired = !!invoice && Date.parse(invoice.expiresAt) <= clock;
  const refundable = invoice && BigInt(invoice.amount) > BigInt(invoice.refundedAmount) && ["paid", "credit_required"].includes(invoice.status);
  const pendingRefund = invoice?.refundRequest && !["completed", "failed"].includes(invoice.refundRequest.status);
  return <div aria-busy={!!busy}>
    {(error || resource.error) && <p role="alert" className="mb-4 text-sm text-destructive">{error || resource.error}</p>}
    {!detail ? <Empty>Loading the exact saved invoice...</Empty> : <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-lg font-semibold">{detail.invoice.plan.name} · {formatUnits(detail.invoice.amount,6)} USDC</p></div><InvoiceStatus value={detail.invoice.status}/></div>
      {detail.checkout.testnet && <p role="status" className="text-sm text-amber-900">NEAR testnet payment using a test token. This does not buy a mainnet transfer or prove real USDC revenue.</p>}
      <div className="grid gap-4 sm:grid-cols-2"><div className="rounded-2xl border border-border bg-white p-5 text-sm"><p className="font-medium">Price and access period</p>{detail.invoice.purchase.kind === "upgrade" && <p className="mt-2 text-xs">Prorated upgrade</p>}<p className="mt-2 text-xs text-muted-foreground">Monthly plan price {formatUnits(detail.invoice.purchase.monthlyAmount,6)} USDC. {detail.invoice.purchase.startsAt ? `Period starts ${dateLabel(detail.invoice.purchase.startsAt)}.` : "A new period starts after confirmed activation."} {detail.invoice.purchase.endsAt ? `Period ends ${dateLabel(detail.invoice.purchase.endsAt)}.` : "The calendar-month period is recorded on activation."}</p><p className="mt-2 text-xs text-muted-foreground">Invoice offer expires {new Date(detail.invoice.expiresAt).toLocaleString()}. Renewal requires a separate explicit payment.</p></div><div className="rounded-2xl border border-border bg-white p-5 text-sm"><p className="font-medium">Payment token and network</p><div className="mt-3"><AssetIdentity symbol="USDC" network="near" assetId={`nep141:${detail.invoice.tokenContract}`}/></div><p className="mt-2 text-xs text-muted-foreground">NEAR {detail.network} · Wallet gas and attached deposits separate</p></div><div><p className="mb-2 text-xs text-muted-foreground">Exact verified payer wallet</p><Address value={detail.invoice.payerAccount} network={detail.network}/></div><div><p className="mb-2 text-xs text-muted-foreground">Dedicated Razor billing contract</p><Address value={detail.invoice.billingContract} network={detail.network}/></div></div>
      <div className="rounded-lg bg-muted p-4 text-sm"><p>{detail.message}</p>{detail.invoice.creditReason && <p className="mt-2">{detail.invoice.creditReason}</p>}</div>
      {detail.invoice.refundRequest && <div className="rounded-2xl border border-border bg-white p-5 text-sm"><p className="font-medium">Refund request: {detail.invoice.refundRequest.status}</p><p className="mt-2">Requested amount {formatUnits(detail.invoice.refundRequest.amount,6)} USDC.</p><p className="mt-2 text-muted-foreground">{detail.invoice.refundRequest.reason}</p><p className="mt-2 text-xs text-muted-foreground">Awaiting final refund to the original payer.</p></div>}
      <div role="group" aria-label="Invoice tasks" className="flex flex-wrap gap-2"><button type="button" disabled={!!busy} className={`rounded-full px-4 py-2 text-sm ${task==="payment"?"bg-foreground text-white":"bg-muted"}`} onClick={()=>setTask("payment")}>Payment</button>{!["paid","refunded"].includes(detail.invoice.status) && <button type="button" disabled={!!busy} className={`rounded-full px-4 py-2 text-sm ${task==="recovery"?"bg-foreground text-white":"bg-muted"}`} onClick={()=>setTask("recovery")}>Recover payment</button>}{refundable && !pendingRefund && <button type="button" disabled={!!busy} className={`rounded-full px-4 py-2 text-sm ${task==="refund"?"bg-foreground text-white":"bg-muted"}`} onClick={()=>setTask("refund")}>Request refund</button>}</div>
      {task==="payment" && detail.canSign && !offerExpired && <div className="grid gap-4"><details className="text-sm"><summary className="cursor-pointer text-primary">Inspect exact wallet calls</summary><pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-muted p-4 text-xs">{JSON.stringify(detail.walletActions, null, 2)}</pre></details><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={!!busy} onChange={event => setAcknowledged(event.target.checked)}/><span>I approve this plan, amount, period and payer. Renewal requires a new payment.</span></label><div><Action type="button" disabled={!!busy || !acknowledged} busy={busy === "pay"} onClick={() => void run("pay", pay)}>Pay reviewed invoice in NEAR wallet</Action></div></div>}
      {task==="payment" && (!detail.canSign || offerExpired) && ["prepared", "claimed", "submitted", "expired"].includes(detail.invoice.status) && <div className="flex flex-wrap items-center gap-4"><Action type="button" disabled={!!busy} busy={busy === "refresh-offer"} onClick={() => void run("refresh-offer", async () => { const next = await api<BillingInvoiceDetail>(`${endpoint}/refresh`, {}); setDetail(next); setAcknowledged(false); refresh(); })}>Refresh checkout offer</Action>{offerExpired && <button type="button" disabled={!!busy} className="text-sm text-primary disabled:opacity-50" onClick={() => void run("close-unused", async () => { const next = await api<BillingInvoiceDetail>(`${endpoint}/close-unused`, {}); setDetail(next); setAcknowledged(false); refresh(); notify("The unpaid expired checkout was closed after final contract checks."); })}>Close unpaid expired checkout</button>}</div>}
      <div className="flex flex-wrap items-center gap-4"><Action type="button" disabled={!!busy} busy={busy === "reconcile"} onClick={() => void run("reconcile", () => reconcile())}><RefreshCw size={15}/>Check saved payment status</Action><a className="text-sm text-primary" href={`/api${endpoint}/receipt?download=1`} download>Download invoice and receipt JSON</a></div>
      <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Invoice and transaction details</summary><div className="mt-3 grid gap-3"><Address value={detail.invoice.id} label="invoice ID"/>
      {detail.invoice.submittedTransactionHash && !detail.invoice.transactionHash && <p className="break-all text-xs text-muted-foreground">Submitted transaction, awaiting verification: {detail.invoice.submittedTransactionHash}</p>}
      {detail.invoice.transactionHash && <p className="break-all text-xs text-muted-foreground">Recorded transaction: {detail.invoice.transactionHash}</p>}
      </div></details>
      {task==="recovery" && !["paid", "refunded"].includes(detail.invoice.status) && <form className="grid gap-3 rounded-2xl border border-border bg-white p-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("recover-hash", () => reconcile(String(values.get("transactionHash")))); }}><Field label="Existing NEAR transaction hash" hint="Use the original transfer. Do not pay again."><input name="transactionHash" className={control} required minLength={32} maxLength={64} value={savedHash || detail.invoice.submittedTransactionHash || detail.invoice.transactionHash || ""} onChange={event => setSavedHash(event.target.value)}/></Field>{savedHash && <p className="break-all text-xs">Wallet returned transaction: {savedHash}</p>}<div><Action type="submit" disabled={!!busy} busy={busy === "recover-hash"}>Recover original payment</Action></div></form>}
      {task==="refund" && refundable && !pendingRefund && <form className="grid gap-3 rounded-2xl border border-border bg-white p-5" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); void run("refund-request", async () => { await api(`${endpoint}/refund-request`, { reason: values.get("reason") }); form.reset(); refresh(); notify("Your refund request was recorded for operator review. No funds have been returned yet."); }); }}><Field label="Reason for billing refund request"><textarea name="reason" className={control} required minLength={5} maxLength={1000} rows={3}/></Field><p className="text-xs text-muted-foreground">Returns to the original payer after approval.</p><div><Action type="submit" disabled={!!busy} busy={busy === "refund-request"}>Request refund review</Action></div></form>}

    </div>}
  </div>;
}
