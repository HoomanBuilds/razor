"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { api, RequestError } from "@/lib/api";
import { assertBillingReview, billingWalletActions } from "@/lib/billing-review";
import { dateLabel } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActions } from "@/lib/near-actions";
import type { BillingPlanVersion } from "@/server/billing/types";
import type { BillingOverview, BillingInvoiceDetail, BillingInvoicePage } from "@/server/billing/payment-types";
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
    <Panel title="Company plan" description="Razor payment markup is 0%. Subscription charges and actual network costs are separate from recipient entitlements.">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xl font-semibold">{billing.plan.name}</p><p className="mt-1 text-xs text-muted-foreground">Plan version {billing.plan.version}</p></div><Status value={billing.status}/></div>
      {billing.pilot && <p role="status" className="mt-4 rounded-lg bg-muted p-4 text-sm">Complimentary pilot access is enabled. This is not evidence of a paid subscription or an automatic charge.</p>}
      <dl className="mt-5 grid gap-4 sm:grid-cols-3"><div className="rounded-lg border p-4"><dt className="text-xs text-muted-foreground">Finance seats</dt><dd className="mt-2 text-lg font-semibold tabular-nums">{billing.usage.financeSeats} / {billing.limits.financeSeats}</dd><p className="mt-2 text-xs text-muted-foreground">Existing members retain access if a lower plan has fewer seats.</p></div><div className="rounded-lg border p-4"><dt className="text-xs text-muted-foreground">Private-AI attempts</dt><dd className="mt-2 text-lg font-semibold tabular-nums">{billing.usage.aiAttempts} / {billing.limits.aiAttempts}</dd><p className="mt-2 text-xs text-muted-foreground">{billing.usage.aiCompleted} completed, {billing.usage.aiFailed} failed. Dispatched attempts share one allowance across invoice analysis and finance planning.</p></div><div className="rounded-lg border p-4"><dt className="text-xs text-muted-foreground">Usage period</dt><dd className="mt-2 text-sm font-medium">{billing.period ? `${new Date(billing.period.startsAt).toLocaleDateString()} to ${new Date(billing.period.endsAt).toLocaleDateString()}` : "Calendar-month allowance"}</dd>{billing.paidThrough && <p className="mt-2 text-xs text-muted-foreground">Paid access through {new Date(billing.paidThrough).toLocaleDateString()}.</p>}</div></dl>
      <p className="mt-4 text-xs text-muted-foreground">Ownership controls, required approvals, manual payments, recipient records, exports and fund recovery remain available on every plan. AI provider configuration and required verification are checked separately from plan access.</p>
    </Panel>
    {billing.canManage && <OwnerBilling />}
    {!billing.canManage && <Panel title="Plan management"><p className="text-sm text-muted-foreground">Only the company owner can choose a paid plan, manage subscription invoices or request refunds. Your role can review these capabilities without access to the company's billing records.</p></Panel>}
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
    const read = () => setInvoiceId(new URLSearchParams(window.location.search).get("invoice") || "");
    read(); window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  function openInvoice(id: string) {
    setInvoiceId(id);
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
    openInvoice(detail.invoice.id); refresh();
  }
  const current = overview.data;
  return <>
    {error && <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">{error}</p>}
    <Panel title="Choose a company plan" description="Pilot offers are billed in USDC. Review the exact invoice before any wallet signature; renewal always needs a new explicit payment.">
      {overview.error ? <p role="alert" className="text-sm text-destructive">{overview.error}</p> : !current ? <Empty>Loading company subscription options...</Empty> : <div className="grid gap-5">
        {!current.checkout.ready && <div role="status" className="rounded-lg border bg-muted p-4 text-sm"><p className="font-medium">Subscription checkout needs setup</p><p className="mt-2 text-muted-foreground">{current.checkout.reason || "The operator must configure and verify the NEAR billing deployment before collecting payments."}</p><p className="mt-2 text-xs text-muted-foreground">Plan information and existing receipts stay available. No payment has been requested.</p></div>}
        {current.checkout.testnet && <p role="status" className="text-sm text-amber-900">This is NEAR testnet billing. Test token payments do not establish live USDC revenue.</p>}
        {current.payerAccounts.length ? <Field label="Verified NEAR wallet for subscription payment" hint={`NEAR ${current.checkout.network}. Subscription funds are separate from company payroll and treasury reserves.`}><select className={control} value={payer || current.payerAccounts[0]} disabled={!!busy} onChange={event => setPayer(event.target.value)}>{current.payerAccounts.map(account => <option key={account} value={account}>{account}</option>)}</select></Field> : <p className="text-sm text-muted-foreground">Link a verified NEAR wallet on {current.checkout.network} to pay a subscription. <a className="text-primary" href="/account">Open account and wallet setup</a></p>}
        <div className="grid gap-4 xl:grid-cols-3">{current.plans.map(plan => <article key={plan.id} className="flex min-w-0 flex-col gap-4 rounded-lg border p-5"><div><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{plan.name}</h3>{plan.id === current.entitlements.plan.id && <Status value={current.entitlements.pilot ? "pilot" : "active"}/>}</div><p className="mt-3 text-2xl font-semibold tabular-nums">{formatUnits(plan.monthlyAmount,6)} <span className="text-xs font-normal text-muted-foreground">USDC / month</span></p><p className="mt-1 text-xs text-muted-foreground">Per company workspace · version {plan.version}</p></div><ul className="grid gap-2 text-sm"><li>{plan.limits.financeSeats} finance seats</li><li>{plan.limits.aiAttempts} private-AI attempts per usage period</li>{features.filter(([feature]) => plan.features[feature]).map(([feature, label]) => <li key={feature} className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0 text-primary"/>{label}</li>)}</ul><div className="mt-auto grid gap-3">{BigInt(plan.monthlyAmount) > 0n ? <Action type="button" disabled={!!busy || !current.checkout.ready || !current.payerAccounts.length} busy={busy === plan.id} onClick={() => void run(plan.id, () => prepare(plan))}>Review {plan.name} payment</Action> : !current.subscriptionState.paidThrough ? <p className="text-xs text-muted-foreground">Available without a subscription payment.</p> : null}{current.subscriptionState.paidThrough && current.subscriptionState.currentPeriod?.planVersionId !== plan.id && <button type="button" disabled={!!busy} className="text-left text-sm text-primary disabled:opacity-50" onClick={() => void run(`schedule:${plan.id}`, async () => { await api(`${base}/billing/plan-change`, { planVersionId: plan.id }); refresh(); notify("Your next-period preference was saved. A paid plan still requires its explicit subscription payment."); })}>Choose after prepaid access ends</button>}</div></article>)}</div>
        <p className="text-xs text-muted-foreground">Recipient payments carry zero Razor percentage markup. Network costs, source funding and any independent off-ramp remain separate. AI allowance counts dispatched attempts, including failures, across invoice analysis and finance planning.</p>
      </div>}
    </Panel>
    {current && <Panel title="Subscription schedule" description="Payments are manual. Razor never pulls a renewal from your wallet or from employee entitlements."><div className="grid gap-4 text-sm"><p>{current.subscriptionState.paidThrough ? `Prepaid access ends ${dateLabel(current.subscriptionState.paidThrough)}.` : "No prepaid subscription period is active."}</p>{current.subscriptionState.nextPeriod && <p>A prepaid next period runs {dateLabel(current.subscriptionState.nextPeriod.startsAt)} to {dateLabel(current.subscriptionState.nextPeriod.endsAt)}.</p>}{current.subscriptionState.scheduledPlan && <p>Preferred next plan: <strong>{current.subscriptionState.scheduledPlan.name}</strong>. A paid next period requires its corresponding confirmed payment; otherwise this workspace returns to Free when prepaid access ends.</p>}{current.subscriptionState.cancelAtPeriodEnd ? <div className="space-y-3"><p>Cancellation is scheduled. Existing prepaid access, financial records and fund recovery remain available.</p><Action type="button" disabled={!!busy} busy={busy === "resume"} onClick={() => void run("resume", async () => { await api(`${base}/billing/resume`, {}); refresh(); notify("Cancellation was removed. No renewal payment was sent."); })}>Remove scheduled cancellation</Action></div> : current.subscriptionState.paidThrough && <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void run("cancel", async () => { await api(`${base}/billing/cancel`, {}); setCancelConfirmed(false); refresh(); notify("Paid-plan cancellation was scheduled. Prepaid access and financial recovery remain available."); }); }}><label className="flex items-start gap-2"><input type="checkbox" required className="mt-1" checked={cancelConfirmed} onChange={event => setCancelConfirmed(event.target.checked)} disabled={!!busy}/><span>End the paid plan after prepaid access finishes. Existing transfers and records remain accessible; a refund request is reviewed separately.</span></label><div><Action type="submit" disabled={!!busy || !cancelConfirmed} busy={busy === "cancel"}>End paid plan at period end</Action></div></form>}</div></Panel>}
    {invoiceId && <BillingInvoiceReview key={invoiceId} invoiceId={invoiceId} close={() => openInvoice("")} onResolved={forgetRequest}/>}
    <Panel title="Subscription invoices" description="Company software charges are separate from payroll, client funds and payment routing budgets." action={<a className="inline-flex items-center gap-2 text-sm text-primary" href={`/api${base}/billing/export`} download><Download size={15}/>Export billing CSV</a>}>
      {invoices.error && <p role="alert" className="mb-4 text-sm text-destructive">{invoices.error}</p>}
      {invoices.loading ? <Empty>Loading subscription invoices...</Empty> : !invoices.data?.invoices.length ? <Empty>No subscription invoices. Choosing a paid plan prepares a reviewable invoice before any payment.</Empty> : <DataTable columns={["Invoice", "Plan and period", "USDC charge", "Status", "Actions"]}>{invoices.data.invoices.map(invoice => <tr key={invoice.id}><td className="max-w-44 break-all font-mono text-xs">{invoice.id}<p className="mt-1 font-sans text-muted-foreground">{dateLabel(invoice.createdAt)}</p></td><td>{invoice.plan.name}<p className="mt-1 text-xs text-muted-foreground">{invoice.purchase.kind} · version {invoice.plan.version}</p><p className="mt-1 text-xs text-muted-foreground">{invoice.purchase.startsAt ? dateLabel(invoice.purchase.startsAt) : "Starts on confirmed activation"}{invoice.purchase.endsAt ? ` to ${dateLabel(invoice.purchase.endsAt)}` : ""}</p></td><td className="whitespace-nowrap tabular-nums">{formatUnits(invoice.amount,6)}{BigInt(invoice.refundedAmount) > 0n && <p className="mt-1 text-xs text-muted-foreground">{formatUnits(invoice.refundedAmount,6)} refunded</p>}</td><td><InvoiceStatus value={invoice.status}/>{invoice.refundRequest && <p className="mt-2 text-xs">Refund: {invoice.refundRequest.status}</p>}</td><td><div className="flex flex-wrap gap-3"><button type="button" className="text-primary" onClick={() => openInvoice(invoice.id)}>Review / resume</button><a className="inline-flex items-center gap-1 text-xs text-primary" href={`/api${base}/billing/invoices/${invoice.id}/receipt?download=1`} download><Download size={13}/>Receipt JSON</a></div></td></tr>)}</DataTable>}
      {invoices.data && invoices.data.total > 0 && <nav aria-label="Subscription invoice pages" className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">{(invoices.data.page - 1) * invoices.data.pageSize + 1}-{Math.min(invoices.data.page * invoices.data.pageSize, invoices.data.total)} of {invoices.data.total} invoices</p><div className="flex items-center gap-4"><Action type="button" disabled={invoices.loading || page <= 1} onClick={() => setPage(value => value - 1)}>Previous invoices</Action><span>Page {invoices.data.page}</span><Action type="button" disabled={invoices.loading || !invoices.data.hasMore} onClick={() => setPage(value => value + 1)}>Next invoices</Action></div></nav>}
    </Panel>
  </>;
}

function BillingInvoiceReview({ invoiceId, close, onResolved }: { invoiceId: string; close: () => void; onResolved: (invoiceId: string) => void }) {
  const { base, revision, refresh, notify } = useWorkspace();
  const endpoint = `${base}/billing/invoices/${encodeURIComponent(invoiceId)}`;
  const resource = useResource<BillingInvoiceDetail>(endpoint, revision);
  const [detail, setDetail] = useState<BillingInvoiceDetail | null>(null), [acknowledged, setAcknowledged] = useState(false), [savedHash, setSavedHash] = useState("");
  const [clock, setClock] = useState(Date.now);
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
    const hash = await signNearActions(billingWalletActions(claimed), claimed.network, [claimed.invoice.payerAccount]);
    setAcknowledged(false);
    if (hash) setSavedHash(hash);
    try { await reconcile(hash ?? undefined); }
    finally { refresh(); }
  }
  const invoice = detail?.invoice;
  const offerExpired = !!invoice && Date.parse(invoice.expiresAt) <= clock;
  const refundable = invoice && BigInt(invoice.amount) > BigInt(invoice.refundedAmount) && ["paid", "credit_required"].includes(invoice.status);
  const pendingRefund = invoice?.refundRequest && !["completed", "failed"].includes(invoice.refundRequest.status);
  return <Panel title="Review subscription invoice" description="This payment buys company software access. It never reduces an employee or contractor entitlement." action={<button type="button" className="text-sm text-primary" onClick={close}>Close invoice</button>}>
    {(error || resource.error) && <p role="alert" className="mb-4 text-sm text-destructive">{error || resource.error}</p>}
    {!detail ? <Empty>Loading the exact saved invoice...</Empty> : <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-lg font-semibold">{detail.invoice.plan.name} · {formatUnits(detail.invoice.amount,6)} USDC</p><p className="mt-1 break-all text-xs text-muted-foreground">Invoice {detail.invoice.id} · plan version {detail.invoice.plan.version}</p></div><InvoiceStatus value={detail.invoice.status}/></div>
      {detail.checkout.testnet && <p role="status" className="text-sm text-amber-900">NEAR testnet payment using a test token. This does not buy a mainnet transfer or prove real USDC revenue.</p>}
      <div className="grid gap-4 sm:grid-cols-2"><div className="rounded-lg border p-4 text-sm"><p className="font-medium">Price and access period</p><p className="mt-2">{detail.invoice.purchase.kind === "upgrade" ? "Prorated upgrade: " : "Due now: "}{formatUnits(detail.invoice.amount,6)} USDC.</p><p className="mt-2 text-xs text-muted-foreground">Monthly plan price {formatUnits(detail.invoice.purchase.monthlyAmount,6)} USDC. {detail.invoice.purchase.startsAt ? `Period starts ${dateLabel(detail.invoice.purchase.startsAt)}.` : "A new period starts after confirmed activation."} {detail.invoice.purchase.endsAt ? `Period ends ${dateLabel(detail.invoice.purchase.endsAt)}.` : "The calendar-month period is recorded on activation."}</p><p className="mt-2 text-xs text-muted-foreground">Invoice offer expires {new Date(detail.invoice.expiresAt).toLocaleString()}. Renewal requires a separate explicit payment.</p></div><div className="rounded-lg border p-4 text-sm"><p className="font-medium">Payment token and network</p><div className="mt-3"><AssetIdentity symbol="USDC" network="near" assetId={`nep141:${detail.invoice.tokenContract}`} showAssetId/></div><p className="mt-2 text-xs text-muted-foreground">NEAR {detail.network}. Network gas and the attached yoctoNEAR are separate from the USDC subscription price and shown by your wallet.</p></div><div><p className="mb-2 text-xs text-muted-foreground">Exact verified payer wallet</p><Address value={detail.invoice.payerAccount} network={detail.network}/></div><div><p className="mb-2 text-xs text-muted-foreground">Dedicated Razor billing contract</p><Address value={detail.invoice.billingContract} network={detail.network}/></div></div>
      <div className="rounded-lg bg-muted p-4 text-sm"><p>{detail.message}</p>{detail.invoice.creditReason && <p className="mt-2">{detail.invoice.creditReason}</p>}<p className="mt-2 text-xs text-muted-foreground">Final contract invoice state is required before paid access changes. Reusing this exact invoice cannot collect the subscription twice; any duplicate or excess transfer is returned by the billing contract.</p></div>
      {detail.invoice.refundRequest && <div className="rounded-lg border p-4 text-sm"><p className="font-medium">Refund request: {detail.invoice.refundRequest.status}</p><p className="mt-2">Requested amount {formatUnits(detail.invoice.refundRequest.amount,6)} USDC.</p><p className="mt-2 text-muted-foreground">{detail.invoice.refundRequest.reason}</p><p className="mt-2 text-xs text-muted-foreground">A request or prepared refund is not completed delivery. The operator reviews it and only final NEAR refund state confirms the return to the original payer.</p></div>}
      {detail.canSign && !offerExpired && <div className="grid gap-4"><details className="text-sm"><summary className="cursor-pointer text-primary">Inspect exact wallet calls</summary><pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-muted p-4 text-xs">{JSON.stringify(detail.walletActions, null, 2)}</pre></details><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={!!busy} onChange={event => setAcknowledged(event.target.checked)}/><span>I reviewed the company plan, exact USDC charge, period, network, token, billing contract and payer wallet. This is an explicit subscription payment; it does not authorize automatic renewal.</span></label><div><Action type="button" disabled={!!busy || !acknowledged} busy={busy === "pay"} onClick={() => void run("pay", pay)}>Pay reviewed invoice in NEAR wallet</Action></div></div>}
      {(!detail.canSign || offerExpired) && ["prepared", "claimed", "submitted", "expired"].includes(detail.invoice.status) && <div className="flex flex-wrap items-center gap-4"><Action type="button" disabled={!!busy} busy={busy === "refresh-offer"} onClick={() => void run("refresh-offer", async () => { const next = await api<BillingInvoiceDetail>(`${endpoint}/refresh`, {}); setDetail(next); setAcknowledged(false); refresh(); })}>Refresh checkout offer</Action>{offerExpired && <button type="button" disabled={!!busy} className="text-sm text-primary disabled:opacity-50" onClick={() => void run("close-unused", async () => { const next = await api<BillingInvoiceDetail>(`${endpoint}/close-unused`, {}); setDetail(next); setAcknowledged(false); refresh(); notify("The unpaid expired checkout was closed after final contract checks."); })}>Close unpaid expired checkout</button>}</div>}
      <div className="flex flex-wrap items-center gap-4"><Action type="button" disabled={!!busy} busy={busy === "reconcile"} onClick={() => void run("reconcile", () => reconcile())}><RefreshCw size={15}/>Check saved payment status</Action><a className="text-sm text-primary" href={`/api${endpoint}/receipt?download=1`} download>Download invoice and receipt JSON</a></div>
      {detail.invoice.submittedTransactionHash && !detail.invoice.transactionHash && <p className="break-all text-xs text-muted-foreground">Submitted transaction, awaiting verification: {detail.invoice.submittedTransactionHash}</p>}
      {detail.invoice.transactionHash && <p className="break-all text-xs text-muted-foreground">Recorded transaction: {detail.invoice.transactionHash}</p>}
      {!["paid", "refunded"].includes(detail.invoice.status) && <form className="grid gap-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("recover-hash", () => reconcile(String(values.get("transactionHash")))); }}><Field label="Existing NEAR transaction hash" hint="If your wallet sent the payment but the callback was lost, attach that original hash or check the saved invoice state. Do not prepare another invoice."><input name="transactionHash" className={control} required minLength={32} maxLength={64} value={savedHash || detail.invoice.submittedTransactionHash || detail.invoice.transactionHash || ""} onChange={event => setSavedHash(event.target.value)}/></Field>{savedHash && <p className="break-all text-xs">Wallet returned transaction: {savedHash}</p>}<div><Action type="submit" disabled={!!busy} busy={busy === "recover-hash"}>Recover original payment</Action></div></form>}
      {refundable && !pendingRefund && <form className="grid gap-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); void run("refund-request", async () => { await api(`${endpoint}/refund-request`, { reason: values.get("reason") }); form.reset(); refresh(); notify("Your refund request was recorded for operator review. No funds have been returned yet."); }); }}><Field label="Reason for billing refund request"><textarea name="reason" className={control} required minLength={5} maxLength={1000} rows={3}/></Field><p className="text-xs text-muted-foreground">Refunds return only to this invoice's original payer. Paid access remains governed by the recorded period and final refund outcome.</p><div><Action type="submit" disabled={!!busy} busy={busy === "refund-request"}>Request refund review</Action></div></form>}
      <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck size={15} className="shrink-0"/>Company payroll, custody controls, recipient records and recovery remain separate from subscription billing.</p>
    </div>}
  </Panel>;
}
