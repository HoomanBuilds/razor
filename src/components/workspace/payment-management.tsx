"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, FileText, History, LockKeyhole, RefreshCw, Search, ShieldCheck, Wallet, X } from "lucide-react";
import { AssetIdentity, TokenLogo } from "@/components/assets/asset-identity";
import { focusWorkspaceForm } from "./page-metrics";
import type { Token } from "./types";
import { api, RequestError } from "@/lib/api";
import { microUsd, usdcInput, usd } from "@/lib/format";
import { paymentLabel } from "@/lib/payment-label";
import { canCancelManagedPayment } from "@/lib/payment-management-eligibility";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import type { managementOverview, managedPaymentReview, payrollPreview, billBatchPreview } from "@/server/payment-management/service";
import type { RecipientSnapshot } from "@/server/payments/types";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./shared";
import { PurchaseMatchReview } from "./vendor-commitments";

type Overview = ReturnType<typeof managementOverview>;
type RunReview = Awaited<ReturnType<typeof payrollPreview>>;
type PaymentReview = ReturnType<typeof managedPaymentReview>;
type BillReview = Awaited<ReturnType<typeof billBatchPreview>>;
interface Props { mode?: "all" | "payroll" | "bills" | "payments"; initialRunId?: string; initialBillId?: string; initialPaymentId?: string }

function moneyInput(value: FormDataEntryValue | null, signed = false) {
  const text = String(value ?? "0").trim();
  const negative = signed && text.startsWith("-");
  try { return `${negative ? "-" : ""}${microUsd(negative ? text.slice(1) : signed ? text.replace(/^\+/, "") : text, true)}`; } catch (cause) { throw new RequestError((cause as Error).message, 422, "INVALID_NET_AMOUNT"); }
}

function signedInput(value: string) { return value.startsWith("-") ? `-${usdcInput(value.slice(1))}` : usdcInput(value); }

function Profile({ value, title }: { value: RecipientSnapshot; title: string }) {
  return <div className="rounded-lg border p-3 text-xs"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{title} · version {value.version}</p><Status value={value.preference_status ?? "pending_confirmation"} /></div><p className="mb-1 break-all text-muted-foreground">Primary: {value.primary_asset} on {value.primary_network}</p><Address value={value.primary_address} network={value.primary_network} />{value.primary_memo!==null&&value.primary_memo!==undefined&&<p className="mt-1">XRP tag: {value.primary_memo} (encoded in address)</p>}{value.backup_address && value.backup_network ? <div className="mt-3"><p className="mb-1 text-muted-foreground">USDC backup on {value.backup_network} · {value.fallback_consent ? "Recipient consent confirmed" : "No fallback consent"}</p><Address value={value.backup_address} network={value.backup_network} /></div> : <p className="mt-2 text-muted-foreground">No backup destination</p>}</div>;
}

function RoutingReview({ value }: { value: RunReview["items"][number]["routeReadiness"] }) {
  return <div className="grid gap-2 rounded-lg border bg-muted p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><span>Primary catalog support</span><Status value={value.primary.status}/><span>USDC backup</span><Status value={value.backup.status}/></div><p>{value.primary.reason}</p>{value.exceptions.length>0&&<ul className="list-disc space-y-1 pl-4">{value.exceptions.map(reason=><li key={reason}>{reason}</li>)}</ul>}<p className="text-muted-foreground">No payable quote was created. Amount limits, liquidity, fees and current authority are rechecked before execution. Approval records the liability without guaranteeing delivery.</p></div>;
}

function FundingReview({ value, openTreasury }: { value: RunReview["funding"]; openTreasury: () => void }) {
  return <div className="grid gap-3 rounded-lg border bg-muted p-4 text-sm"><div className="grid gap-3 sm:grid-cols-3"><p>Available operating cash<br /><strong>{usd(value.available)}</strong></p><p>Additional reservation needed<br /><strong>{usd(value.unreserved)}</strong></p><p>Funding shortfall<br /><strong>{usd(value.shortfall)}</strong></p></div><p className="text-xs text-muted-foreground">Already reserved: {usd(value.alreadyReserved)}. Awaiting reconciliation: {usd(value.awaitingReconciliation)}. Cash protected for these payments: {usd(value.protectedFunding)}. Other client earmarks stay excluded from operating cash.</p>{!value.treasuryConfigured && <p className="text-xs">Connect or create the company NEAR treasury before execution.</p>}{BigInt(value.shortfall) > 0n && <p className="text-xs">Approval can record an unfunded obligation. Payment still requires confirmed funds and NEAR authorization.</p>}<button type="button" className="justify-self-start text-primary" onClick={openTreasury}>Open company treasury</button></div>;
}

export function PaymentManagementPanel(props: Props) {
  const { base, organization } = useWorkspace();
  if (!organization.permissions?.includes("payments:read")) return null;
  if (props.mode === "payments") return <PaymentToolsWorkspace key={`${base}:${props.initialPaymentId}`} initialPaymentId={props.initialPaymentId} />;
  return <ManagementWorkspace key={`${base}:${props.mode}:${props.initialRunId}:${props.initialBillId}:${props.initialPaymentId}`} {...props} />;
}

function PaymentToolsWorkspace({ initialPaymentId = "" }: { initialPaymentId?: string }) {
  const { base, revision, refresh, notify, navigate, organization } = useWorkspace();
  const overview = useResource<Overview>(`${base}/payment-management`, revision);
  const [paymentId, setPaymentId] = useState(initialPaymentId);
  const review = useResource<PaymentReview>(paymentId ? `${base}/payment-management/payments/${paymentId}` : null, revision);
  const assets = useResource<{ tokens: Token[] }>(paymentId ? "/assets" : null, revision);
  const { busy, error, run, setError } = useAction();
  const [search, setSearch] = useState("");
  const [choosing, setChoosing] = useState(!initialPaymentId);
  const [task, setTask] = useState<"cancel" | "replace" | null>(null);
  const [reason, setReason] = useState("");
  const [cancellation, setCancellation] = useState<{ paymentId: string; walletActions: NearWalletAction[]; treasuryNetwork: string } | null>(null);
  const taskHeading = useRef<HTMLHeadingElement>(null);
  const activePaymentId = useRef(paymentId);
  activePaymentId.current = paymentId;
  const current = review.data;
  const allowed = (permission: string) => organization.permissions?.includes(permission) === true;
  const selectionLocked = !!busy || !!cancellation || !!task;
  const actionLocked = !!busy || review.refreshing || !!review.error;
  const blockedAttempts = current?.attempts.some(attempt => ["prepared", "submitted", "processing", "unknown", "recovery_pending", "reported_delivered", "reported_partial"].includes(attempt.state));
  const partial = !!current && (current.payment.status === "partially_paid" || !!current.payment.partial_delivery_observed || BigInt(current.payment.delivered_amount) > 0n && current.payment.status !== "paid");
  const needsReconciliation = !!current && (partial || blockedAttempts || ["in_flight", "recovery_pending", "unknown"].includes(current.payment.status));
  const canCancel = canCancelManagedPayment(current, allowed("payments:approve"));
  const canReplace = !!current?.canReplace && !current.activeClearingRound && !partial && allowed("payments:prepare");
  const payments = overview.data?.payments ?? [];
  const term = search.trim().toLowerCase();
  const matches = payments.filter(item => `${paymentLabel(item.payment)} ${item.recipientName} ${item.payment.status.replaceAll("_", " ")}`.toLowerCase().includes(term));

  useEffect(() => { if (task || cancellation) taskHeading.current?.focus(); }, [task, cancellation]);

  const choosePayment = (id: string) => {
    if (selectionLocked) return;
    setPaymentId(id);
    setReason("");
    setChoosing(false);
    setError("");
  };
  const openQueue = () => { if (!selectionLocked) { navigate("payments", paymentId || undefined); focusWorkspaceForm("payment-queue"); } };
  const openReconciliation = () => { if (!selectionLocked) focusWorkspaceForm("payment-reconciliation"); };
  const openLinkedReview = () => {
    if (!current || selectionLocked) return;
    const isBill = !!current.billId;
    const linkedId = current.billId || current.payrollRunId;
    if (!linkedId) { openQueue(); return; }
    navigate(isBill ? "bills" : "payroll");
    const location = new URL(window.location.href);
    location.searchParams.set(isBill ? "reviewBill" : "reviewRun", linkedId);
    window.history.replaceState(null, "", location);
    focusWorkspaceForm(isBill ? "bill-batch-review" : "payroll-review");
  };
  const cancel = () => run("cancel", async () => {
    if (!current || current.payment.id !== activePaymentId.current) return;
    const capturedId = current.payment.id;
    const result = await api<{ payment: { status: string }; walletActions: NearWalletAction[]; treasuryNetwork: string | null; cancellationConfirmed: boolean }>(`${base}/payment-management/payments/${capturedId}/cancel`, {});
    if (activePaymentId.current !== capturedId) return;
    if (result.walletActions.length && result.treasuryNetwork) setCancellation({ paymentId: capturedId, walletActions: result.walletActions, treasuryNetwork: result.treasuryNetwork });
    else { notify(result.cancellationConfirmed ? "Cancellation confirmed. The original obligation remains in history." : "Refresh cancellation status before replacing this payment."); refresh(); }
    setTask(null);
  });
  const confirmCancellation = () => run("sign-cancel", async () => {
    if (!cancellation || cancellation.paymentId !== activePaymentId.current) return;
    const captured = cancellation;
    try {
      await signNearActions(captured.walletActions, captured.treasuryNetwork);
      const result = await api<{ cancellationConfirmed: boolean }>(`${base}/payment-management/payments/${captured.paymentId}/cancel`, {});
      notify(result.cancellationConfirmed ? "NEAR cancellation confirmed. A replacement may now be prepared." : "Cancellation is not final yet. Check its status before replacing the obligation.");
      refresh();
    } finally { setCancellation(null); }
  });
  const replacement = () => run("replace", async () => {
    if (!current || current.payment.id !== activePaymentId.current || !canReplace) return;
    const capturedId = current.payment.id;
    const result = await api<{ payment: { id: string } }>(`${base}/payment-management/payments/${capturedId}/replace`, { reason });
    if (activePaymentId.current !== capturedId) return;
    setPaymentId(result.payment.id);
    setTask(null);
    setReason("");
    notify("Replacement saved as a new draft. Fresh approval is required.");
    refresh();
  });

  let nextTitle = "Ready for your review";
  let nextDescription = "Review this payment's business terms before approving or funding it.";
  let nextLabel = current?.billId ? "Review invoice" : current?.payrollRunId ? "Review pay run" : "Review payment";
  let nextAction = openLinkedReview;
  let nextIcon = <FileText size={19} />;
  if (current?.activeClearingRound) {
    nextTitle = "Included in business clearing";
    nextDescription = "Review its clearing commitment before changing this payment.";
    nextLabel = "Review clearing";
    nextAction = () => navigate("clearing");
    nextIcon = <LockKeyhole size={19} />;
  } else if (needsReconciliation) {
    nextTitle = partial ? "Partial delivery needs review" : "Resolve the existing delivery first";
    nextDescription = partial ? "Review the amount received and the unpaid remainder. This payment cannot be cancelled or replaced in full." : "Confirm the original outcome before cancelling, replacing or sending again.";
    nextLabel = "Review in Reconciliation";
    nextAction = openReconciliation;
    nextIcon = <ShieldCheck size={19} />;
  } else if (canReplace) {
    nextTitle = "Ready for a replacement draft";
    nextDescription = "Keep the unpaid amount and use the recipient's current receiving details. Fresh approval is required.";
    nextLabel = "Create replacement";
    nextAction = () => setTask("replace");
    nextIcon = <RefreshCw size={19} />;
  } else if (current?.payment.status === "cancelled") {
    nextTitle = "Payment cancelled";
    nextDescription = "The original record remains in your payment history.";
    nextLabel = allowed("payments:approve") ? "Check cancellation" : "View payment queue";
    nextAction = allowed("payments:approve") ? () => { void cancel(); } : openQueue;
    nextIcon = <CircleCheck size={19} />;
  } else if (current?.payment.status === "paid") {
    nextTitle = "Payment completed";
    nextDescription = "Completed payments remain in history and cannot be replaced.";
    nextLabel = "View payment queue";
    nextAction = openQueue;
    nextIcon = <CircleCheck size={19} />;
  } else if (current?.profileChanged) {
    nextTitle = "Receiving details have changed";
    nextDescription = "This payment still uses its recorded receiving details. Review the change before proceeding.";
  } else if (current?.payment.status === "held") {
    nextTitle = "Payment needs attention";
    nextDescription = "Review the hold in the payment queue before continuing.";
    nextLabel = "Review payment hold";
    nextAction = openQueue;
  }

  return <div className="grid min-w-0 gap-5">
    <header className="px-1"><h2 className="text-xl font-medium tracking-tight">Payment tools</h2><p className="mt-1.5 text-sm text-muted-foreground">Review unpaid payments, receiving changes and replacements.</p></header>
    {(overview.error || review.error || error) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/20 bg-red-50/40 px-5 py-4 text-sm text-destructive"><p className="min-w-0 flex-1">{error || review.error || overview.error}</p>{(overview.error || review.error) && <button type="button" className="font-medium underline underline-offset-4" disabled={!!busy} onClick={refresh}>Try again</button>}</div>}
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(16rem,0.85fr)_minmax(0,2fr)]">
      <aside className="min-w-0 overflow-hidden rounded-3xl border bg-white" aria-label="Choose a payment">
        <div className="flex items-center justify-between gap-3 px-5 py-4"><h3 className="text-sm font-medium">{paymentId ? "Your payments" : "Choose a payment"}</h3>{paymentId && <button type="button" className="flex min-h-9 items-center gap-1 rounded-full px-2 text-xs font-medium text-primary lg:hidden" disabled={selectionLocked} aria-expanded={choosing || !paymentId} aria-controls="payment-tools-chooser" onClick={() => setChoosing(value => !value)}>{choosing || !paymentId ? "Hide" : "Change"}<ChevronDown size={14} /></button>}{overview.data && <span className="hidden text-xs tabular-nums text-muted-foreground lg:block">{payments.length}</span>}</div>
        <div id="payment-tools-chooser" className={!choosing && paymentId ? "hidden lg:block" : ""}>
          {!overview.loading && payments.length > 0 && <label className="mx-4 mb-3 flex items-center gap-2 rounded-xl bg-muted px-3"><Search size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" /><input aria-label="Find a payment" className="min-h-11 min-w-0 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" placeholder="Find a payee or reference" value={search} disabled={selectionLocked} onChange={event => setSearch(event.target.value)} /></label>}
          {overview.loading ? <ToolsLoading /> : overview.error && !overview.data ? <ToolsEmpty title="Payments unavailable" description="Retry to load your company's records." /> : !payments.length ? <ToolsEmpty title="No unpaid payments" description="New payment drafts will appear here." /> : !matches.length ? <ToolsEmpty title="No matching payments" description="Try another payee or reference." /> : <div className="dashboard-nav-scroll max-h-[28rem] overflow-y-auto overscroll-contain border-t p-2">
            {matches.map(item => <button key={item.payment.id} type="button" disabled={selectionLocked} onClick={() => choosePayment(item.payment.id)} aria-pressed={item.payment.id === paymentId}
              className={"mb-1 grid w-full gap-2 rounded-2xl p-3 text-left transition-colors disabled:cursor-not-allowed " + (item.payment.id === paymentId ? "bg-secondary/70 ring-1 ring-inset ring-primary/15" : "hover:bg-muted")}>
              <span className="flex min-w-0 items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-medium">{paymentLabel(item.payment)}</span>{item.payment.id === paymentId && <ChevronRight size={15} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />}</span>
              <span className="block truncate text-xs text-muted-foreground">{item.recipientName}</span>
              <span className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm tabular-nums">{usd(item.payment.amount)}</span><Status value={item.payment.status} /></span>
            </button>)}
          </div>}
        </div>
        {selectionLocked && <p className="border-t px-5 py-3 text-xs leading-5 text-muted-foreground">Finish or close the current review to choose another payment.</p>}
      </aside>

      <div className="grid min-w-0 gap-4">
        {!paymentId ? <section className="rounded-3xl border bg-white px-6 py-14 text-center"><span className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-secondary text-primary"><FileText size={23} aria-hidden="true" /></span><h3 className="text-lg font-medium">Start with a payment</h3><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Choose a payee or reference to see the next step and its payment history.</p><button type="button" className="mt-6 min-h-10 rounded-full border px-4 text-sm font-medium hover:bg-muted" onClick={openQueue}>Open payment queue</button></section>
          : review.loading ? <div className="rounded-3xl border bg-white"><ToolsLoading /></div>
          : !current ? <section className="rounded-3xl border bg-white"><ToolsEmpty title="Payment unavailable" description="Refresh the records or choose another payment." /></section>
          : <section className="min-w-0 overflow-hidden rounded-3xl border bg-white">
            <div className="border-b p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs capitalize text-muted-foreground">{current.payment.kind.replaceAll("_", " ")}</p><h3 className="mt-2 break-words text-xl font-medium tracking-tight">{paymentLabel(current.payment)}</h3><p className="mt-1.5 break-words text-sm text-muted-foreground">{current.recipientName}</p></div><Status value={current.payment.status} /></div>
              <div className="mt-6 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-xs text-muted-foreground">Payment amount</p><div className="flex items-center gap-2.5"><TokenLogo symbol="USDC" size={24} /><p className="break-all text-3xl font-medium tracking-tight tabular-nums">{usd(current.payment.amount)}<span className="ml-2 text-xs font-normal text-muted-foreground">USDC</span></p></div></div><div className="text-sm sm:text-right"><p className="text-xs text-muted-foreground">Maximum payment cost</p><p className="mt-2 tabular-nums">{usd(current.payment.max_fee)} USDC</p></div></div>
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              {!task && !cancellation && <div className="rounded-2xl bg-muted/70 p-5"><div className="flex items-start gap-3"><span className="mt-0.5 text-primary" aria-hidden="true">{nextIcon}</span><div className="min-w-0"><h4 className="text-sm font-medium">{nextTitle}</h4><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{nextDescription}</p></div></div><Action className="mt-4" disabled={actionLocked} busy={busy === "cancel"} onClick={nextAction}>{nextLabel}<ChevronRight size={15} aria-hidden="true" /></Action></div>}

              {task === "cancel" && <form className="grid gap-4 rounded-2xl border border-destructive/20 bg-red-50/30 p-5" onSubmit={event => { event.preventDefault(); if (canCancel && !actionLocked) void cancel(); }}>
                <div><h4 ref={taskHeading} tabIndex={-1} className="text-base font-medium outline-none">Cancel this payment?</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">Cancel {usd(current.payment.amount)} to {current.recipientName}. Its history stays available, and any replacement requires a new approval.</p></div>
                <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" required disabled={!!busy} className="mt-1.5 size-4 shrink-0 accent-primary" /><span>I want to cancel this unpaid payment.</span></label>
                <div className="flex flex-wrap justify-end gap-2 border-t pt-4"><button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium hover:bg-white" disabled={!!busy} onClick={() => setTask(null)}>Keep payment</button><Action className="bg-destructive text-white hover:bg-destructive/90" busy={busy === "cancel"} disabled={actionLocked || !canCancel}>{busy === "cancel" ? "Preparing cancellation..." : "Cancel payment"}</Action></div>
              </form>}

              {cancellation && <div className="rounded-2xl border border-primary/20 bg-secondary/40 p-5"><div className="flex items-start gap-3"><Wallet size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" /><div><h4 ref={taskHeading} tabIndex={-1} className="text-base font-medium outline-none">Confirm cancellation in your wallet</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">Reserved funds stay protected until the original treasury confirms cancellation on {cancellation.treasuryNetwork}.</p></div></div><details className="mt-4 rounded-xl border bg-white p-4"><summary className="cursor-pointer text-xs font-medium">Exact cancellation action</summary><pre className="mt-3 max-h-52 overflow-auto text-xs">{JSON.stringify(cancellation.walletActions, null, 2)}</pre></details><div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium hover:bg-white" disabled={!!busy} onClick={() => setCancellation(null)}>Close review</button><Action busy={busy === "sign-cancel"} disabled={actionLocked || cancellation.paymentId !== paymentId} onClick={() => void confirmCancellation()}>{busy === "sign-cancel" ? "Confirming cancellation..." : "Confirm in NEAR wallet"}</Action></div></div>}

              {task === "replace" && <form className="grid gap-4 rounded-2xl border bg-muted/40 p-5" onSubmit={event => { event.preventDefault(); if (!actionLocked) void replacement(); }}><div><h4 ref={taskHeading} tabIndex={-1} className="text-base font-medium outline-none">Prepare a replacement</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">The new draft keeps {usd(current.payment.amount)} unpaid and uses the current receiving profile. Earlier costs reduce its remaining cost budget.</p></div><Field label="Why does this payment need replacing?"><textarea className={control} required minLength={3} maxLength={1000} rows={3} value={reason} disabled={!!busy} onChange={event => setReason(event.target.value)} placeholder="For example, the recipient confirmed a different wallet" /></Field><p className="text-xs leading-5 text-muted-foreground">The original record stays in history. This creates a draft, not another transfer.</p><div className="flex flex-wrap justify-end gap-2 border-t pt-4"><button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium hover:bg-white" disabled={!!busy} onClick={() => setTask(null)}>Close without saving</button><Action busy={busy === "replace"} disabled={actionLocked || !canReplace}>{busy === "replace" ? "Creating draft..." : "Create replacement draft"}</Action></div></form>}

              <details className="rounded-2xl border px-4 py-4"><summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium"><span>Receiving details</span><span className={"text-xs font-normal " + (current.profileChanged ? "text-amber-800" : "text-muted-foreground")}>{current.profileChanged ? "Changed" : "Unchanged"}</span></summary><div className="mt-4 grid gap-4"><PaymentReceivingProfile profile={current.recordedProfile} tokens={assets.data?.tokens ?? []} title={current.profileChanged ? "Recorded for this payment" : "Recorded receiving profile"} />{current.profileChanged && <PaymentReceivingProfile profile={current.currentProfile} tokens={assets.data?.tokens ?? []} title="Current receiving profile" />}</div>{current.profileChanged && <p className="mt-4 text-xs leading-5 text-muted-foreground">A recipient change does not redirect an approved payment.</p>}</details>

              <details className="rounded-2xl border px-4 py-4"><summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium"><span className="inline-flex items-center gap-2"><History size={15} aria-hidden="true" />Payment history</span><span className="text-xs font-normal text-muted-foreground">{current.history.length} {current.history.length === 1 ? "record" : "records"}</span></summary><div className="mt-4 divide-y">{current.history.map(entry => <div key={entry.id} className="py-4 first:pt-0 last:pb-0"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{paymentLabel(entry)}</p><Status value={entry.status} /></div><div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{usd(entry.amount)} USDC</span><span>Receiving profile v{entry.recipient_version}</span></div><details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Record identifier</summary><Address value={entry.id} /></details></div>)}</div>{current.replacements.length > 0 && <div className="mt-4 space-y-3 border-t pt-4">{current.replacements.map(entry => <p key={entry.old_payment_id} className="text-xs leading-5 text-muted-foreground">{entry.reason}</p>)}</div>}</details>

              {current.payment.hold_reason && <details className="rounded-2xl border px-4 py-4 text-sm"><summary className="cursor-pointer font-medium">Why this payment is held</summary><p className="mt-3 text-xs leading-6 text-muted-foreground">{current.payment.hold_reason}</p></details>}
              {!task && !cancellation && <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><button type="button" className="min-h-10 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={actionLocked} onClick={openQueue}>All payment records</button>{canCancel && <button type="button" className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-destructive hover:bg-red-50 disabled:opacity-50" disabled={actionLocked} onClick={() => setTask("cancel")}><X size={14} aria-hidden="true" />Cancel payment</button>}{current.payment.status === "cancelled" && canReplace && allowed("payments:approve") && <button type="button" className="min-h-10 text-xs font-medium text-muted-foreground disabled:opacity-50" disabled={actionLocked} onClick={() => void cancel()}>Check cancellation on NEAR</button>}</div>}
            </div>
          </section>}
      </div>
    </div>
  </div>;
}

function PaymentReceivingProfile({ profile, tokens, title }: { profile: RecipientSnapshot; tokens: Token[]; title: string }) {
  const asset = tokens.find(token => token.assetId === profile.primary_asset || profile.primary_asset === "USDC" && token.symbol === "USDC" && token.blockchain === profile.primary_network);
  return <section className="min-w-0 rounded-xl bg-muted/50 p-4"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h5 className="text-xs font-medium">{title}</h5><Status value={profile.preference_status ?? "pending_confirmation"} /></div><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs text-muted-foreground">Primary destination</p><AssetIdentity symbol={asset?.symbol || (profile.primary_asset === "USDC" ? "USDC" : "Selected asset")} network={profile.primary_network} /><div className="mt-3"><Address value={profile.primary_address} network={profile.primary_network} /></div>{profile.primary_memo != null && <p className="mt-2 text-xs">XRP tag: {profile.primary_memo} (encoded in address)</p>}</div><div><p className="mb-2 text-xs text-muted-foreground">USDC backup</p>{profile.backup_address && profile.backup_network ? <><AssetIdentity symbol="USDC" network={profile.backup_network} /><div className="mt-3"><Address value={profile.backup_address} network={profile.backup_network} /></div><p className="mt-2 text-xs text-muted-foreground">{profile.fallback_consent ? "Recipient consent confirmed" : "Fallback not consented"}</p></> : <p className="text-sm">No backup destination</p>}</div></div><details className="mt-4 border-t pt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Asset identifier and profile version</summary><div className="mt-3 space-y-2"><p>Profile version {profile.version}</p><p className="break-all font-mono">{profile.primary_asset}</p></div></details></section>;
}

function ToolsEmpty({ title, description }: { title: string; description: string }) {
  return <div className="px-5 py-10 text-center"><h3 className="text-sm font-medium">{title}</h3><p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-muted-foreground">{description}</p></div>;
}

function ToolsLoading() {
  return <div role="status" aria-label="Loading payment records" className="space-y-5 p-5">{[0, 1, 2].map(index => <div key={index} className="space-y-2"><div className="h-4 w-32 animate-pulse rounded bg-muted" /><div className="h-3 w-44 max-w-full animate-pulse rounded bg-muted" /></div>)}<span className="sr-only">Loading payment records...</span></div>;
}

function ManagementWorkspace({ mode = "all", initialRunId = "", initialBillId = "", initialPaymentId = "" }: Props) {
  const { base, revision, refresh, notify, navigate, organization } = useWorkspace();
  const overview = useResource<Overview>(`${base}/payment-management`, revision);
  const [runId, setRunId] = useState(initialRunId);
  const [paymentId, setPaymentId] = useState(initialPaymentId);
  const [billIds, setBillIds] = useState<string[]>(initialBillId ? [initialBillId] : []);
  const [batch, setBatch] = useState<BillReview | null>(null);
  const [showBillReview, setShowBillReview] = useState(!!initialBillId);
  const [cancellation, setCancellation] = useState<{ paymentId: string; walletActions: NearWalletAction[]; treasuryNetwork: string } | null>(null);
  const payrollAssets = useResource<{ tokens: Token[] }>(runId ? "/assets" : null, revision);
  const runReview = useResource<RunReview>(runId ? `${base}/payment-management/payroll/${runId}/review` : null, revision);
  const paymentReview = useResource<PaymentReview>(paymentId ? `${base}/payment-management/payments/${paymentId}` : null, revision);
  const { busy, error, run } = useAction();
  const allowed = (permission: string) => organization.permissions?.includes(permission) === true;
  const invalidate = () => { setBatch(null); refresh(); };
  const cancel = () => run("cancel", async () => {
    if (!paymentId) return;
    const result = await api<{ payment: { status: string }; walletActions: NearWalletAction[]; treasuryNetwork: string | null; cancellationConfirmed: boolean }>(`${base}/payment-management/payments/${paymentId}/cancel`, {});
    if (result.walletActions.length && result.treasuryNetwork) setCancellation({ paymentId, walletActions: result.walletActions, treasuryNetwork: result.treasuryNetwork });
    else { notify(result.cancellationConfirmed ? "Cancellation confirmed. The original obligation remains in history." : "Refresh cancellation status before replacing this payment."); invalidate(); }
  });
  const reviewed = runReview.data;
  useEffect(() => { if (reviewed?.run.id) document.getElementById("payroll-review")?.scrollIntoView({ block: "start" }); }, [reviewed?.run.id]);
  const current = paymentReview.data;
  const canCancel = canCancelManagedPayment(current, allowed("payments:approve"));
  const canApproveRun = reviewed?.run.status !== "cancelled" && reviewed?.items.every((item) => item.payment.status === "paid" || ["draft", "approved_unfunded", "approved"].includes(item.payment.status) && !item.profileChanged && item.currentProfile.preference_status === "confirmed" && !item.currentProfile.archived);
  const canApproveBatch = batch?.bills.every((bill) => !bill.activeClearingRound && !bill.vendorCommitment?.problems.length && bill.status !== "disputed" && (!bill.requires_acceptance || bill.milestone_accepted_at) && ["draft", "approved_unfunded", "approved"].includes(bill.payment.status) && !bill.profileChanged && bill.currentProfile.preference_status === "confirmed" && !bill.currentProfile.archived);
  return <div className="grid gap-6">
    {(error || overview.error || runReview.error || paymentReview.error) && <p role="alert" className="rounded-lg border border-destructive/20 bg-card p-4 text-sm text-destructive">{error || overview.error || runReview.error || paymentReview.error}</p>}
    {(mode === "all" || mode === "payroll" || !!runId) && <Panel title="Review pay run" tone="white" description="Check net pay and receiving details before approving this exact version.">
      <div className="max-w-md"><Field label="Selected pay run"><select className={control} value={runId} disabled={!!busy || overview.loading} onChange={event => setRunId(event.target.value)}><option value="">Choose a pay run</option>{overview.data?.runs.map(item => <option key={item.id} value={item.id}>{item.reference}</option>)}</select></Field></div>
      {runId && runReview.loading ? <Empty>Loading exact payroll terms...</Empty> : reviewed ? <div className="mt-6 grid gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-lg font-medium">{reviewed.run.reference}</h3><p className="mt-2 text-xs text-muted-foreground">{reviewed.run.period_start} - {reviewed.run.period_end} · {reviewed.items.length} recipients</p><div className="mt-3"><Status value={reviewed.run.status} /></div></div><div className="sm:text-right"><p className="text-2xl font-semibold tabular-nums">{usd(reviewed.total)}</p><p className="mt-1 text-xs text-muted-foreground">Net USDC · costs up to {usd(reviewed.maxFees)}</p></div></div>
        <section className="rounded-xl border bg-muted/30 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">Approval readiness</h3><Status value={canApproveRun ? "ready_for_review" : "needs_attention"} /></div>{!canApproveRun && <p role="status" className="mt-3 text-sm text-amber-900">Resolve the recipient or payment blockers below before approving this version.</p>}<div className="mt-4 grid gap-4 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Available operating cash</p><p className="mt-1 font-medium tabular-nums">{usd(reviewed.funding.available)}</p></div><div><p className="text-xs text-muted-foreground">Additional reservation</p><p className="mt-1 font-medium tabular-nums">{usd(reviewed.funding.unreserved)}</p></div><div><p className="text-xs text-muted-foreground">Funding shortfall</p><p className="mt-1 font-medium tabular-nums">{usd(reviewed.funding.shortfall)}</p></div></div>{(!reviewed.funding.treasuryConfigured || BigInt(reviewed.funding.shortfall) > 0n) && <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">{!reviewed.funding.treasuryConfigured ? "Set up the company treasury before execution." : "Approval can record the obligation. Confirmed funds are still needed to pay it."}</p><button type="button" className="text-xs text-primary" onClick={() => navigate("treasury")}>Open treasury</button></div>}<details className="mt-4 border-t pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Reservation and catalog details</summary><div className="mt-3 space-y-2 leading-5"><p>Already reserved: {usd(reviewed.funding.alreadyReserved)}. Awaiting reconciliation: {usd(reviewed.funding.awaitingReconciliation)}. Protected for these payments: {usd(reviewed.funding.protectedFunding)}. Other client earmarks remain excluded.</p><p>Asset catalog: {reviewed.routingCatalog.status}. Checked {new Date(reviewed.routingCatalog.checkedAt).toLocaleString()}; cached for at most {reviewed.routingCatalog.maximumCacheAgeSeconds}s. Receiving-chain delivery remains unquoted.</p></div></details></section>
        <div className="grid gap-4">{reviewed.items.map(item => <article key={`${item.id}:${item.terms.version}:${item.payment.id}:${item.payment.updated_at}`} className="min-w-0 rounded-xl border bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{item.recipientName}</h3><div className="mt-2"><Status value={item.payment.status} /></div></div><div className="text-right"><p className="text-lg font-semibold tabular-nums">{usd(item.amount)}</p><p className="mt-1 text-xs text-muted-foreground">Cost ceiling {usd(item.maxFee)}</p></div></div>
          <dl className="mt-5 grid grid-cols-3 gap-3 rounded-xl bg-muted/50 p-3 text-xs"><div><dt className="text-muted-foreground">Base net pay</dt><dd className="mt-1 font-medium tabular-nums">{usd(item.terms.baseAmount)}</dd></div><div><dt className="text-muted-foreground">Supplied bonus</dt><dd className="mt-1 font-medium tabular-nums">{usd(item.terms.bonusAmount)}</dd></div><div><dt className="text-muted-foreground">Net correction</dt><dd className="mt-1 font-medium tabular-nums">{usd(item.terms.adjustmentAmount)}</dd></div></dl>
          {item.terms.note && <p className="mt-3 text-xs leading-5 text-muted-foreground">Adjustment note: {item.terms.note}</p>}
          {(item.profileChanged || item.currentProfile.preference_status !== "confirmed" || item.currentProfile.archived || !["draft", "approved_unfunded", "approved", "paid"].includes(item.payment.status)) && <div className="mt-4 grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{item.profileChanged && <><p>Receiving details changed since this obligation was recorded. Approved terms stay immutable.</p>{item.payment.status === "draft" && !item.payment.approved_at && allowed("payments:prepare") ? <div><Action busy={busy === `${item.id}:profile`} disabled={!!busy} onClick={() => void run(`${item.id}:profile`, async () => { await api(`${base}/payments/${item.payment.id}/revalidate`, {}); invalidate(); })}>Refresh draft receiving details</Action></div> : <button type="button" className="justify-self-start text-primary" disabled={!!busy} onClick={() => setPaymentId(item.payment.id)}>{allowed("payments:prepare") || allowed("payments:approve") ? "View cancellation and replacement" : "View obligation history"}</button>}</>}{item.currentProfile.preference_status !== "confirmed" && <p>Recipient confirmation is still required.</p>}{!!item.currentProfile.archived && <p>This recipient is archived.</p>}{!["draft", "approved_unfunded", "approved", "paid"].includes(item.payment.status) && <p>Resolve this payment's {item.payment.status.replaceAll("_", " ")} status before approving the run.</p>}</div>}
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">Primary route</span><Status value={item.routeReadiness.primary.status} /><span className="ml-2 text-muted-foreground">USDC backup</span><Status value={item.routeReadiness.backup.status} /></div>{item.routeReadiness.exceptions.length > 0 && <ul className="mt-3 space-y-1 text-xs leading-5 text-amber-900">{item.routeReadiness.exceptions.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <details open={item.profileChanged} className="mt-4 border-t pt-4"><summary className="cursor-pointer text-sm font-medium">{item.profileChanged ? "Compare receiving details" : "Receiving details and route checks"}</summary><div className="mt-4 grid gap-4"><div className={`grid gap-3 ${item.profileChanged ? "xl:grid-cols-2" : ""}`}><PaymentReceivingProfile profile={item.recordedProfile} tokens={payrollAssets.data?.tokens ?? []} title="Recorded receiving details" />{item.profileChanged && <PaymentReceivingProfile profile={item.currentProfile} tokens={payrollAssets.data?.tokens ?? []} title="Current receiving details" />}</div><RoutingReview value={item.routeReadiness} /></div></details>
          {item.canAdjust && allowed("payments:prepare") && <details className="mt-4 border-t pt-4"><summary className="cursor-pointer text-sm font-medium text-primary">Edit base pay, bonus or correction</summary><form aria-busy={busy === `${item.id}:terms`} className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void run(`${item.id}:terms`, async () => { await api(`${base}/payment-management/payroll/${runId}/items/${item.id}`, { expectedPaymentId: item.payment.id, expectedTermsVersion: item.terms.version, baseAmount: moneyInput(values.get("base")), bonusAmount: moneyInput(values.get("bonus")), adjustmentAmount: moneyInput(values.get("adjustment"), true), maxFee: moneyInput(values.get("fee")), note: values.get("note") }, "PATCH"); notify("Draft net amounts saved. Review the new total and recipient details before approval."); invalidate(); }); }}><Field label="Base net pay (USDC)"><input name="base" className={control} required inputMode="decimal" disabled={!!busy} defaultValue={usdcInput(item.terms.baseAmount)} /></Field><Field label="Supplied bonus (USDC)"><input name="bonus" className={control} required inputMode="decimal" disabled={!!busy} defaultValue={usdcInput(item.terms.bonusAmount)} /></Field><Field label="Other net correction (+/- USDC)"><input name="adjustment" className={control} required inputMode="decimal" disabled={!!busy} defaultValue={signedInput(item.terms.adjustmentAmount)} /></Field><Field label="Maximum payment cost (USDC)"><input name="fee" className={control} required inputMode="decimal" disabled={!!busy} defaultValue={usdcInput(item.maxFee)} /></Field><div className="sm:col-span-2 "><Field label="Bonus or net-adjustment explanation"><textarea name="note" className={control} maxLength={1000} disabled={!!busy} defaultValue={item.terms.note} rows={2} /></Field></div><div className="sm:col-span-2 "><Action disabled={!!busy} busy={busy === `${item.id}:terms`}>Save draft adjustment</Action></div></form></details>}
          <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t pt-4"><details className="min-w-0 flex-1 text-xs text-muted-foreground"><summary className="cursor-pointer">Obligation history ({item.history.length})</summary><div className="mt-3 grid gap-3">{item.history.map(entry => <div key={entry.id}><p>{usd(entry.amount)} · {entry.status} · recipient version {entry.recipientVersion}</p><p className="mt-1 break-all font-mono">{entry.id}</p></div>)}</div></details><button type="button" className="text-xs text-primary" disabled={!!busy} onClick={() => setPaymentId(item.payment.id)}>Manage obligation</button></div>
        </article>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-5"><p className="max-w-xl text-xs leading-5 text-muted-foreground">{canApproveRun ? "Approval records these exact amounts and recipient versions. Execution and wallet authorization follow separately." : "Approval is blocked until the issues above are resolved."}</p>{allowed("payments:approve") && <Action disabled={!!busy || !canApproveRun} busy={busy === "approve-run"} onClick={() => void run("approve-run", async () => { await api(`${base}/payment-management/payroll/${runId}/approve`, { reviewToken: reviewed.reviewToken }); notify("The exact pay-run amounts and recipient versions were approved."); invalidate(); })}>Approve reviewed pay run</Action>}</div><p className="text-xs text-muted-foreground">Base pay, bonuses and corrections are company-provided net amounts. Razor does not calculate statutory payroll taxes.</p>
      </div> : runId && !runReview.error ? <Empty>The selected run is unavailable. Choose a pay run to continue.</Empty> : null}
    </Panel>}
    {(mode === "all" || mode === "bills" || showBillReview) && <Panel title="Review and approve invoices together" description="Every selected invoice must pass the same approval rules. A changed amount, recipient version, dispute or acceptance requirement invalidates the batch.">{overview.loading ? <Empty>Loading invoices...</Empty> : <div className="grid gap-2">{overview.data?.bills.map((bill) => <label key={bill.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"><input type="checkbox" checked={billIds.includes(bill.id)} disabled={!!busy} onChange={(event) => { setBatch(null); setBillIds(event.target.checked ? [...billIds, bill.id] : billIds.filter((id) => id !== bill.id)); }} /><span className="flex-1">{bill.reference}</span><Status value={bill.status} /></label>)}</div>}<Action className="mt-4" disabled={!!busy || !billIds.length} busy={busy === "preview-bills"} onClick={() => void run("preview-bills", async () => { setBatch(await api<BillReview>(`${base}/payment-management/bills/preview`, { billIds })); })}>Review selected invoices</Action>
      {batch && <div className="mt-5 grid gap-4">{batch.duplicateWarnings.length > 0 && <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">{batch.duplicateWarnings.map((warning, index) => <p key={`${warning.invoiceIds.join(":")}:${index}`}>{warning.message} References: {warning.references.join(", ")}.</p>)}</div>}<FundingReview value={batch.funding} openTreasury={() => navigate("treasury")} /><p className="text-xs text-muted-foreground">Asset catalog: {batch.routingCatalog.status}. Checked {new Date(batch.routingCatalog.checkedAt).toLocaleString()}; payable quotes are checked later.</p>{batch.bills.map((bill) => <article key={bill.id} className="grid gap-3 rounded-lg border p-4"><div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{bill.reference} · {bill.recipientName}</p><p>{usd(bill.payment.amount)} net · costs up to {usd(bill.payment.max_fee)}</p></div><p className="text-sm text-muted-foreground">{bill.title}</p><PurchaseMatchReview value={bill.vendorCommitment} /><Profile value={bill.recordedProfile} title="Payment recipient snapshot" /><RoutingReview value={bill.routeReadiness}/>{bill.activeClearingRound && <p role="status" className="text-sm">This invoice is held by clearing round {bill.activeClearingRound.id}. <button type="button" className="text-primary" onClick={()=>navigate("clearing")}>Review its clearing commitment</button></p>}{bill.profileChanged && <p className="text-sm">Recipient details changed. Refresh the draft or cancel and replace its approved obligation first.</p>}<p className="text-xs text-muted-foreground">{bill.requires_acceptance ? bill.milestone_accepted_at ? "Milestone acceptance recorded" : "Milestone acceptance still required" : "No separate milestone acceptance required"}</p>{bill.acceptanceEvidence && <p className="text-xs text-muted-foreground">Acceptance evidence: {bill.acceptanceEvidence}</p>}<button className="justify-self-start text-sm text-primary" onClick={() => setPaymentId(bill.payment.id)}>Manage invoice payment</button></article>)}<p className="font-medium">Total {usd(batch.total)} net · maximum routing costs {usd(batch.maxFees)}</p>{allowed("payments:approve") && <Action disabled={!!busy || !canApproveBatch} busy={busy === "approve-bills"} onClick={() => void run("approve-bills", async () => { await api(`${base}/payment-management/bills/approve`, { billIds: batch.bills.map((bill) => bill.id), reviewToken: batch.reviewToken }); notify("All reviewed invoices were approved."); invalidate(); })}>Approve reviewed invoice batch</Action>}</div>}
    </Panel>}
    {(mode === "all" || mode === "payments") && <Panel title="Manage an existing obligation" description="Close delivery attempts in Reconciliation before cancelling a payment. A replacement preserves the unpaid liability and remaining cost budget."><Field label="Payment"><select className={control} value={paymentId} onChange={(event) => setPaymentId(event.target.value)}><option value="">Choose an unpaid obligation</option>{overview.data?.payments.map((item) => <option key={item.payment.id} value={item.payment.id}>{paymentLabel(item.payment)} · {item.payment.status}</option>)}</select></Field></Panel>}
    {paymentId && paymentReview.loading ? <Empty>Loading obligation history...</Empty> : current && <Panel title={allowed("payments:prepare") || allowed("payments:approve") ? "Cancellation and explicit replacement" : "Obligation history"} description="The original payment remains immutable. A new draft needs a fresh approval and cannot replace paid, partial, unknown or active delivery."><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">{paymentLabel(current.payment)} · {current.recipientName}</p><p className="mt-1 text-sm">{usd(current.payment.amount)} entitlement · {usd(current.payment.max_fee)} cost ceiling</p></div><Status value={current.payment.status} /></div><div className="grid gap-3 md:grid-cols-2"><Profile value={current.recordedProfile} title="Original obligation snapshot" /><Profile value={current.currentProfile} title="Current recipient details" /></div>{current.activeClearingRound && <p role="status" className="mt-4 text-sm">This obligation is locked by clearing round {current.activeClearingRound.id}. <button type="button" className="text-primary" onClick={()=>navigate("clearing")}>Open business clearing</button></p>}<div className="mt-4 flex flex-wrap items-center gap-3">{canCancel && <Action disabled={!!busy} busy={busy === "cancel"} onClick={() => void cancel()}>Prepare cancellation</Action>}{allowed("payments:approve") && current.payment.status === "cancelled" && <Action disabled={!!busy} busy={busy === "cancel"} onClick={() => void cancel()}>Check cancellation on NEAR</Action>}{current.billId && <button className="text-sm text-primary" onClick={() => { setBillIds([current.billId!]); setBatch(null); setShowBillReview(true); }}>Review its invoice</button>}{current.payrollRunId && <button className="text-sm text-primary" onClick={() => setRunId(current.payrollRunId!)}>Review its pay run</button>}<button className="text-sm text-primary" onClick={() => navigate("payments")}>Open payment queue</button></div>
      {current.canReplace && allowed("payments:prepare") && <form className="mt-5 grid gap-3 rounded-lg bg-muted p-4" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("replace", async () => { const result = await api<{ payment: { id: string } }>(`${base}/payment-management/payments/${current.payment.id}/replace`, { reason: values.get("reason") }); setPaymentId(result.payment.id); notify("Replacement saved as a new draft. Fresh approval is required."); invalidate(); }); }}><Field label="Reason for replacement"><textarea name="reason" className={control} required minLength={3} maxLength={1000} rows={2} placeholder="Why the original unpaid obligation needs a fresh recipient snapshot" /></Field><p className="text-xs text-muted-foreground">The entitlement stays the same. Previously consumed costs reduce the replacement's remaining fee ceiling.</p><div><Action disabled={!!busy} busy={busy === "replace"}>Prepare replacement draft</Action></div></form>}
      <details className="mt-5 text-xs"><summary className="cursor-pointer text-muted-foreground">Immutable payment history ({current.history.length})</summary><div className="mt-2 grid gap-2">{current.history.map((entry) => <p key={entry.id} className="break-all">{entry.id} · {usd(entry.amount)} · {entry.status} · recipient version {entry.recipient_version}</p>)}{current.replacements.map((entry) => <p key={entry.old_payment_id}>{entry.reason}</p>)}</div></details>
    </Panel>}
    {cancellation && allowed("payments:approve") && <Panel title="Confirm cancellation in the original NEAR treasury" description="Local reservations will be released only after the treasury confirms cancellation." action={<button className="text-sm text-primary" disabled={!!busy} onClick={() => setCancellation(null)}>Close review</button>}><p className="mb-3 text-sm">Network: {cancellation.treasuryNetwork}</p><details className="text-xs"><summary className="cursor-pointer">Review cancellation wallet action</summary><pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-3">{JSON.stringify(cancellation.walletActions, null, 2)}</pre></details><Action className="mt-4" disabled={!!busy} busy={busy === "sign-cancel"} onClick={() => void run("sign-cancel", async () => { const captured = cancellation; try { await signNearActions(captured.walletActions, captured.treasuryNetwork); const result = await api<{ cancellationConfirmed: boolean }>(`${base}/payment-management/payments/${captured.paymentId}/cancel`, {}); notify(result.cancellationConfirmed ? "NEAR cancellation confirmed. A replacement may now be prepared." : "Cancellation is not final yet. Check its status before replacing the obligation."); invalidate(); } finally { setCancellation(null); } })}>{busy === "sign-cancel" ? "Confirming cancellation..." : "Confirm cancellation in NEAR wallet"}</Action></Panel>}
  </div>;
}
