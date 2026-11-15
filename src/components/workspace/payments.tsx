"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { WORKSPACE_NAVIGATION_EVENT } from "@/lib/workspace-access";
import { proportion } from "@/lib/payment-activity";
import { api, RequestError } from "@/lib/api";
import { microUsd, usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActions } from "@/lib/near-actions";
import { paymentLabel } from "@/lib/payment-label";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Status } from "./shared";
import type { Payment } from "./types";
import { PaymentApproval } from "./payment-approval";
import { openInvoice } from "./invoice-navigation";
import { TaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./task-drawer";
import { PageMetrics, focusWorkspaceForm } from "./page-metrics";
import { PartialSettlementPanel, partialReviewId } from "./partial-settlement";
import { PaymentFundingTask } from "./payment-funding";
import { PaymentRecoveryPanel } from "./payment-recovery";
import { SettlementProof } from "./settlement-proof";

interface WalletAction { receiverId: string; actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[] }
interface Attempt { id: string; route: string; state: string; destination_address: string; destination_memo?: string | null; destination_network: string; destination_asset: string; expected_output: string; amount_in: string; destination_symbol?: string | null; destination_decimals?: number | null; source_tx_hash: string | null; destination_tx_hash: string | null; quote: string; created_at?: string }
interface Preview { signerAccounts?: string[]; payment: Payment; attempt: Attempt; network: string; stage: "prepare" | "approve" | "execute" | "scheduled" | "waiting"; walletActions: WalletAction[]; approvalActions: WalletAction[]; approvalAccounts: string[]; message: string; approvals: { policy_version: string; required_approvals: number; approval_amount: string; payment_collected: number; attempt_collected: number; payment_approvals: string[]; attempt_approvals: string[]; payment_terms_hash: string; attempt_terms_hash: string | null; can_execute: boolean } | null }
const paymentTime = (value: string, timeZone: string) => new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
type Task = "overview" | "approval" | "funding" | "route" | "history" | "recovery" | "partial" | "proof";
const quietButton = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border px-4 text-sm transition-colors hover:bg-muted disabled:opacity-40";

export function Payments() {
  const { base, revision, refresh, recipients, recipientsLoading, recipientsError, notify, navigate, organization } = useWorkspace();
  const [page, setPage] = useState(1);
  const [statusGroup, setStatusGroup] = useState<"open" | "completed" | "all">("open");
  const { data, loading, error: loadError } = useResource<{ payments: Payment[]; page: number; pageSize: number; total: number; hasMore: boolean }>(`${base}/payments?page=${page}&pageSize=50&statusGroup=${statusGroup}`, revision);
  const summary = useResource<{openPrincipal:string;openCount:number;paidCount:number;fundingGap:string}>(`${base}/payments/summary`, revision);
  const { busy, error, run, setError } = useAction();
  const canExecute = organization.permissions?.includes("payments:execute") ?? organization.role === "Owner";
  const canApprove = organization.permissions?.includes("payments:approve") ?? organization.role === "Owner";
  const canPrepare = organization.permissions?.includes("payments:prepare") ?? false;
  const canCreate = canPrepare && !!organization.permissions?.includes("recipients:read");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [detailId, setDetailId] = useState("");
  const [task, setTask] = useState<Task>("overview");
  const [proofId, setProofId] = useState("");
  const selection = useRef({ base, id: detailId, task, generation: 0 });
  const alive = useRef(true);
  selection.current = { ...selection.current, base, id: detailId, task };
  const detail = useResource<{ payment: Payment; attempts: Attempt[] }>(detailId ? `${base}/payments/${detailId}` : null, revision);
  const payment = detail.data?.payment;
  const attempts = detail.data?.attempts ?? [];
  const prepared = attempts.find(attempt => attempt.state === "prepared");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const id = params.get("company") === organization.id && params.get("section") === "payments" ? params.get("payment") ?? "" : "";
      if (selection.current.id !== id) { selection.current.generation++; selection.current.id = id; setPreview(null); setTask("overview"); setProofId(""); setError(""); }
      setDetailId(id);
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, readLocation);
    return () => { window.removeEventListener("popstate", readLocation); window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, readLocation); };
  }, [organization.id, setError]);
  const openDetail = (id: string) => {
    selection.current.generation++; selection.current.id = id;
    setDetailId(id); setPreview(null); setTask("overview"); setProofId(""); setError("");
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("payment", id); else url.searchParams.delete("payment");
    window.history.replaceState(null, "", url.pathname + url.search);
    document.getElementById("payment-queue")?.scrollIntoView({ block: "start" });
  };
  const changeTask = (next: Task) => { selection.current.generation++; selection.current.task = next; setTask(next); setError(""); };
  const guard = () => { const current = { ...selection.current }; return () => alive.current && selection.current.base === current.base && selection.current.id === current.id && selection.current.generation === current.generation; };
  async function quote(useBackup = false) {
    if (!payment) return;
    const current = guard();
    const result = await api<Omit<Preview, "payment">>(`${base}/payments/${payment.id}/quote`, useBackup ? { useBackup: true } : {});
    refresh();
    if (current()) { setPreview({ ...result, payment }); changeTask("route"); }
  }
  async function resume(attempt: Attempt) {
    if (!payment) return;
    const current = guard();
    const result = await api<Omit<Preview, "payment">>(`${base}/attempts/${attempt.id}/resume`, {});
    if (current()) { setPreview({ ...result, payment }); changeTask("route"); }
  }
  async function routeAction() {
    if (!preview) return;
    const reviewed = preview, current = guard();
    const fresh = await api<Omit<Preview, "payment">>(`${base}/attempts/${reviewed.attempt.id}/${reviewed.stage === "approve" ? "approve" : "resume"}`, {});
    if (!current()) return;
    const update = () => setPreview({ ...fresh, payment: reviewed.payment });
    if (fresh.stage !== reviewed.stage) { update(); return; }
    const actions = fresh.stage === "approve" ? fresh.approvalActions : fresh.walletActions;
    const reviewedActions = reviewed.stage === "approve" ? reviewed.approvalActions : reviewed.walletActions;
    if (!actions.length) { update(); return; }
    if (JSON.stringify(actions) !== JSON.stringify(reviewedActions) || fresh.attempt.quote !== reviewed.attempt.quote || fresh.attempt.destination_address !== reviewed.attempt.destination_address || fresh.attempt.destination_memo !== reviewed.attempt.destination_memo) { update(); throw new RequestError("Route instructions changed. Review them again before signing.", 409, "ROUTE_REVIEW_CHANGED"); }
    if (fresh.stage === "execute" && !fresh.approvals?.can_execute) { update(); throw new RequestError("The route needs renewed approvals or has not reached its scheduled time.", 409, "APPROVAL_NOT_READY"); }
    const txHash = await withTaskDrawerWallet(() => signNearActions(actions, fresh.network, fresh.stage === "approve" ? fresh.approvalAccounts : fresh.signerAccounts));
    if (fresh.stage === "execute" && txHash) await api(`${base}/attempts/${reviewed.attempt.id}/submitted`, { txHash });
    await api(`${base}/payments/${reviewed.payment.id}/reconcile`, {});
    refresh();
    if (!current()) return;
    if (fresh.stage === "execute") { setPreview(null); changeTask("overview"); return; }
    const result = await api<Omit<Preview, "payment">>(`${base}/attempts/${reviewed.attempt.id}/resume`, {});
    if (current()) setPreview({ ...result, payment: reviewed.payment });
  }
  const metrics = [
    { label: "Open", value: summary.data ? usd(summary.data.openPrincipal) : summary.error ? "Unavailable" : null, asset: "USDC", progress: summary.data ? { value: proportion(summary.data.openCount, summary.data.openCount + summary.data.paidCount), label: "Open payments", detail: String(summary.data.openCount) } : undefined },
    { label: "Completed", value: summary.data?.paidCount ?? (summary.error ? "Unavailable" : null), progress: summary.data ? { value: proportion(summary.data.paidCount, summary.data.openCount + summary.data.paidCount), label: "Completed payments", detail: String(summary.data.paidCount) } : undefined },
    { label: "Funding gap", value: summary.data ? usd(summary.data.fundingGap) : summary.error ? "Unavailable" : null, asset: "USDC" },
  ];
  const canFund = payment && canPrepare && !payment.activeClearingRound && !["draft", "paid", "cancelled", "partially_paid"].includes(payment.status) && !payment.partial_delivery_observed;
  const canQuote = payment && canExecute && !payment.activeClearingRound && !payment.partial_delivery_observed && !attempts.some(attempt => ["prepared", "submitted", "processing", "unknown", "recovery_pending", "reported_delivered"].includes(attempt.state)) && ["approved", "reserved", "ready", "held", "refunded"].includes(payment.status);
  const canReviewApproval = payment && canApprove && !payment.activeClearingRound && ["draft", "approved_unfunded"].includes(payment.status);
  const reviewApproval = () => {
    if (!payment) return;
    const metadata = JSON.parse(payment.metadata ?? "{}");
    if (payment.status === "draft" && metadata.runId) {
      navigate("payroll");
      const url = new URL(window.location.href); url.searchParams.set("reviewRun", metadata.runId);
      window.history.replaceState(null, "", url); window.dispatchEvent(new Event(WORKSPACE_NAVIGATION_EVENT));
    } else if (payment.status === "draft" && metadata.billId) { navigate("bills"); openInvoice(metadata.billId); }
    else changeTask("approval");
  };
  const hasMoreActions = !!payment && (canPrepare && !payment.activeClearingRound && payment.status === "draft" || canQuote && !prepared || !["draft", "cancelled"].includes(payment.status));
  const recipientName = (item: Payment) => item.recipientName ?? recipients.find(recipient => recipient.id === item.recipient_id)?.name ?? "Recorded payee";
  return <div id="payment-queue" className="grid min-w-0 scroll-mt-5 gap-6">
    {!detailId ? <>
      <div className="hidden sm:block"><PageMetrics items={metrics}/></div>
      <dl className="grid grid-cols-3 divide-x sm:hidden">{metrics.map(item => <div key={item.label} className="min-w-0 px-3 first:pl-0 last:pr-0"><dt className="text-xs text-muted-foreground">{item.label}</dt><dd className="mt-2 break-words text-lg font-medium tabular-nums tracking-tight">{item.value ?? "..."}</dd></div>)}</dl>
      {summary.error && <p role="alert" className="text-sm text-destructive">{summary.error}</p>}
      <section className="workspace-panel workspace-panel-white min-w-0 p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-4"><h2 className="text-lg font-medium">All payments</h2>{canCreate && <Action type="button" onClick={() => focusWorkspaceForm("payment-compose")}><Plus size={15}/>New payment</Action>}</div>
        <div role="group" aria-label="Filter payments" className="mb-5 flex w-fit gap-1 rounded-full bg-muted p-1">{(["open", "completed", "all"] as const).map(value => <button key={value} type="button" aria-pressed={statusGroup === value} onClick={() => { setStatusGroup(value); setPage(1); }} className={`min-h-9 rounded-full px-4 text-xs font-medium capitalize ${statusGroup === value ? "bg-foreground text-white" : "text-muted-foreground hover:text-foreground"}`}>{value}</button>)}</div>
        {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
        {loading ? <Empty>Loading payments...</Empty> : !data?.payments.length ? <Empty>{statusGroup === "open" ? "No open payments." : statusGroup === "completed" ? "No completed payments yet." : "No payments yet."}</Empty> : <div className="divide-y">{data.payments.map(item => <article key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-5 first:pt-1 sm:grid-cols-[minmax(0,1fr)_auto_150px_auto]">
          <div className="min-w-0"><p className="truncate text-sm font-medium">{recipientName(item)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{paymentLabel(item)}</p></div>
          <p className="max-w-40 break-words text-right text-sm font-semibold tabular-nums">{usd(item.amount)}</p>
          <div className="justify-self-start sm:ml-4"><Status value={item.status}/></div>
          <button type="button" className="justify-self-end text-sm font-medium text-primary" onClick={() => openDetail(item.id)} aria-label={`Review ${paymentLabel(item)} for ${recipientName(item)}`}>Review<ChevronRight className="ml-1 inline" size={15}/></button>
        </article>)}</div>}
        {data && data.total > data.pageSize && <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4 text-xs"><span className="text-muted-foreground">{(data.page - 1) * data.pageSize + 1}-{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span><div className="flex gap-4"><button disabled={page <= 1 || loading} className="text-primary disabled:opacity-40" onClick={() => setPage(value => value - 1)}>Previous</button><button disabled={!data.hasMore || loading} className="text-primary disabled:opacity-40" onClick={() => setPage(value => value + 1)}>Next</button></div></div>}
      </section>
    </> : <>
      <button type="button" className="inline-flex min-h-10 items-center gap-2 justify-self-start text-sm text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={!!busy} onClick={() => { if (document.getElementById("payment-selected-content")?.querySelector('[aria-busy="true"]')) return; if (task === "overview") openDetail(""); else changeTask("overview"); }}><ArrowLeft size={16}/>{task === "overview" ? "All payments" : "Payment details"}</button>
      {detail.error && <p role="alert" className="text-sm text-destructive">{detail.error}</p>}
      {detail.loading ? <Empty>Loading payment...</Empty> : payment && <section id="payment-selected-content" aria-busy={!!busy} className="workspace-panel workspace-panel-white min-w-0 p-5 sm:p-7">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b pb-5"><div className="min-w-0"><p className="text-xs text-muted-foreground">{paymentLabel(payment)}</p><h2 className="mt-1 break-words text-xl font-medium tracking-tight">{recipientName(payment)}</h2><div className="mt-3"><Status value={payment.status}/></div></div>{task !== "approval" && <div className="max-w-full text-right"><p className="break-words text-2xl font-medium tabular-nums tracking-tight">{usd(task === "route" && preview ? preview.payment.amount : payment.amount)}</p><p className="mt-1 text-xs text-muted-foreground">USDC entitlement</p></div>}</header>
        {task === "overview" && <div className="grid gap-5">
          <dl className="grid grid-cols-2 gap-5 text-sm sm:grid-cols-4">{[["Cost limit", usd(payment.max_fee)], ...(payment.scheduled_for ? [["Scheduled", paymentTime(payment.scheduled_for, organization.timezone)]] : []), ...(BigInt(payment.delivered_amount) > 0n && payment.delivered_amount !== payment.amount ? [["Delivered", usd(payment.delivered_amount)]] : []), ...(BigInt(payment.reserved_amount ?? "0") > 0n ? [["Reserved", usd(payment.reserved_amount!)]] : [])].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1.5 font-medium tabular-nums">{value}</dd></div>)}</dl>
          {payment.hold_reason && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{payment.hold_reason}</p>}
          {payment.activeClearingRound ? <Action className="justify-self-start" onClick={() => navigate("clearing")}>Review clearing round</Action> : <div className="flex flex-wrap gap-3">
            {canReviewApproval && <Action disabled={!!busy} onClick={reviewApproval}>{payment.status === "draft" ? "Review approval" : "Reserve funds"}</Action>}
            {prepared && (canApprove || canExecute) && <Action disabled={!!busy} busy={busy === "resume"} onClick={() => void run("resume", () => resume(prepared))}>Resume route</Action>}
            {canQuote && !prepared && <Action disabled={!!busy} busy={busy === "quote"} onClick={() => void run("quote", () => quote())}>Review route</Action>}
            {canFund && <button type="button" disabled={!!busy} className={quietButton} onClick={() => changeTask("funding")}>Fund payment</button>}
          </div>}
          {(attempts.length > 0 || !!payment.partial_delivery_observed || payment.status === "partially_paid" || partialReviewId(payment) !== payment.id) && <div className="grid gap-1 border-t pt-3 sm:grid-cols-2">
            {attempts.length > 0 && <button type="button" className="flex min-h-12 items-center justify-between gap-3 text-left text-sm" disabled={!!busy} onClick={() => changeTask("history")}>Transfer history<span className="flex items-center gap-3 text-muted-foreground">{attempts.length}<ChevronRight size={15}/></span></button>}
            {attempts.length > 0 && !["paid", "cancelled"].includes(payment.status) && <button type="button" className="flex min-h-12 items-center justify-between gap-3 text-left text-sm" disabled={!!busy} onClick={() => changeTask("recovery")}>Delivery and recovery<ChevronRight size={15} className="text-muted-foreground"/></button>}
            {(!!payment.partial_delivery_observed || payment.status === "partially_paid" || partialReviewId(payment) !== payment.id || attempts.some(attempt => attempt.state === "reported_partial")) && <button type="button" className="flex min-h-12 items-center justify-between gap-3 text-left text-sm" disabled={!!busy} onClick={() => changeTask("partial")}>Partial delivery<ChevronRight size={15} className="text-muted-foreground"/></button>}
          </div>}
          <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">{hasMoreActions ? "More actions" : "Payment details"}</summary><div className="mt-4 flex flex-wrap gap-3">
            {canPrepare && !payment.activeClearingRound && payment.status === "draft" && <button type="button" disabled={!!busy} className={quietButton} onClick={() => void run("revalidate", async () => { await api(`${base}/payments/${payment.id}/revalidate`, {}); refresh(); })}>Refresh payee details</button>}
            {canQuote && !prepared && <button type="button" disabled={!!busy} className={quietButton} onClick={() => void run("backup", () => quote(true))}>Review USDC backup</button>}
            {!["draft", "cancelled"].includes(payment.status) && <button type="button" disabled={!!busy} className={quietButton} onClick={() => void run("reconcile", async () => { await api(`${base}/payments/${payment.id}/reconcile`, {}); refresh(); })}><RefreshCw size={14}/>Check status</button>}
            <div className="w-full pt-2 text-xs text-muted-foreground">Payment ID <Address value={payment.id} label="payment ID"/></div>
          </div></details>
        </div>}
        {task === "approval" && <PaymentApproval key={payment.id} id={payment.id} close={() => changeTask("overview")}/>}
        {task === "funding" && <PaymentFundingTask key={payment.id} paymentId={payment.id} close={() => changeTask("overview")}/>}
        {task === "route" && preview && <RouteReview timeZone={organization.timezone} preview={preview} canApprove={canApprove} canExecute={canExecute} busy={busy} act={() => void run("route-action", routeAction)} refresh={() => void run("refresh-route", async () => { const current = guard(); const result = await api<Omit<Preview, "payment">>(`${base}/attempts/${preview.attempt.id}/resume`, {}); if (current()) setPreview({ ...result, payment: preview.payment }); })}/>}
        {task === "recovery" && <PaymentRecoveryPanel key={payment.id} paymentId={payment.id} focused/>}
        {task === "partial" && <PartialSettlementPanel key={partialReviewId(payment)} paymentId={partialReviewId(payment)} focused/>}
        {task === "proof" && <SettlementProof key={proofId} attemptId={proofId} focused/>}
        {task === "history" && <div className="grid gap-5"><h3 className="text-lg font-medium">Transfer history</h3>{attempts.map((attempt, index) => <section key={attempt.id} className="border-b pb-5 last:border-0"><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">Transfer {index + 1}</p><Status value={attempt.state}/></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><AssetIdentity symbol={attempt.destination_symbol ?? "Receiving asset"} network={attempt.destination_network} assetId={attempt.destination_asset}/><p className="text-sm font-medium tabular-nums">{attempt.destination_decimals != null ? formatUnits(attempt.expected_output, attempt.destination_decimals) : `${attempt.expected_output} base units`}</p></div><div className="mt-3"><Address value={attempt.destination_address} network={attempt.destination_network}/></div><div className="mt-4 flex flex-wrap gap-3">{attempt.state === "prepared" && (canApprove || canExecute) && <Action disabled={!!busy} onClick={() => void run("resume", () => resume(attempt))}>Review route</Action>}<button type="button" className={quietButton} disabled={!!busy} onClick={() => { setProofId(attempt.id); changeTask("proof"); }}>Payment proof</button></div><details className="mt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Transfer details</summary><dl className="mt-3 grid gap-3"><div><dt className="text-muted-foreground">Attempt</dt><dd className="mt-1"><Address value={attempt.id} label="attempt ID"/></dd></div>{attempt.source_tx_hash && <div><dt className="text-muted-foreground">Source transaction</dt><dd className="mt-1"><Address value={attempt.source_tx_hash} label="transaction hash"/></dd></div>}{attempt.destination_tx_hash && <div><dt className="text-muted-foreground">Destination transaction</dt><dd className="mt-1"><Address value={attempt.destination_tx_hash} label="transaction hash"/></dd></div>}</dl>{attempt.state === "reported_delivered" && <p className="mt-3 text-muted-foreground">Delivery is attested by the company reporter.</p>}<div className="mt-3 flex flex-wrap gap-4 text-primary"><a href={`/api${base}/reconciliation/attempts/${attempt.id}/evidence`} target="_blank" rel="noreferrer">View evidence</a><a href={`/api${base}/reconciliation/attempts/${attempt.id}/evidence?download=1`} download>Download receipt</a></div></details></section>)}</div>}
        {error && <p role="alert" className="mt-5 text-sm text-destructive">{error}</p>}
      </section>}
    </>}
    {canCreate && <TaskDrawer id="payment-create-flow" title="New payment"><form id="payment-compose" aria-busy={!!busy} className="grid gap-5" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); void run("create", async () => { let amount: string, maxFee: string; try { amount = microUsd(String(values.get("amount"))); maxFee = microUsd(String(values.get("fee")), true); } catch (cause) { throw new RequestError((cause as Error).message, 400, "INVALID_AMOUNT"); } await api(`${base}/payments`, { recipientId: values.get("recipient"), reference: values.get("reference"), amount, maxFee, kind: "payment" }); form.reset(); closeTaskDrawer("payment-create-flow", true); notify("Payment draft saved."); refresh(); }); }}>
      {recipientsLoading ? <Empty>Loading payees...</Empty> : recipientsError ? <p role="alert" className="text-sm text-destructive">Payees could not be loaded. Refresh to try again.</p> : !recipients.length ? <div className="grid gap-4"><p className="text-sm">Add a payee to create your first payment.</p>{organization.permissions?.includes("recipients:manage") && <Action type="button" className="justify-self-start" onClick={() => { closeTaskDrawer("payment-create-flow"); navigate("recipients"); focusWorkspaceForm("payee-compose"); }}>Add payee</Action>}</div> : <>
        <Field label="Payee"><select name="recipient" className={control} required defaultValue=""><option value="" disabled>Choose a payee</option>{recipients.map(recipient => <option key={recipient.id} value={recipient.id} disabled={!!recipient.preference_status && recipient.preference_status !== "confirmed"}>{recipient.name}{recipient.preference_status && recipient.preference_status !== "confirmed" ? " (unconfirmed)" : ""}</option>)}</select></Field>
        <Field label="Reference"><input name="reference" className={control} required maxLength={120} placeholder="Project or payment reference"/></Field>
        <div className="grid grid-cols-2 gap-4"><Field label="Net pay (USDC)"><input name="amount" className={control} required inputMode="decimal" placeholder="500.00"/></Field><Field label="Cost limit (USDC)"><input name="fee" className={control} required inputMode="decimal" defaultValue="1.00"/></Field></div>
        <div className="flex items-center justify-between gap-4 border-t pt-5"><button type="button" className="text-sm text-muted-foreground" disabled={!!busy} onClick={() => closeTaskDrawer("payment-create-flow")}>Cancel</button><Action busy={busy === "create"} disabled={!!busy || !recipients.some(recipient => !recipient.preference_status || recipient.preference_status === "confirmed")}>Save draft</Action></div>
      </>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form></TaskDrawer>}
  </div>;
}

function RouteReview({ preview, canApprove, canExecute, busy, act, refresh, timeZone }: { timeZone: string; preview: Preview; canApprove: boolean; canExecute: boolean; busy: string | null; act: () => void; refresh: () => void }) {
  const quote = JSON.parse(preview.attempt.quote);
  const deadline = quote.kind === "direct" ? quote.deadline : quote.quote?.deadline;
  const label = preview.stage === "prepare" ? "Prepare on NEAR" : preview.stage === "approve" ? "Add wallet approval" : "Send payment";
  const allowed = preview.stage === "approve" ? canApprove && !!preview.approvalActions?.length : canExecute && ["prepare", "execute"].includes(preview.stage);
  const sourceCost = BigInt(preview.attempt.amount_in) - BigInt(preview.payment.amount);
  return <div className="grid max-w-3xl gap-5">
    <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-medium">Receiving route</h3>{preview.attempt.route === "backup" && <Status value="USDC backup"/>}</div>
    <div className="grid gap-3 rounded-2xl bg-muted/50 p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><AssetIdentity symbol={preview.attempt.destination_symbol ?? "Receiving asset"} network={preview.attempt.destination_network} assetId={preview.attempt.destination_asset}/><p className="text-lg font-medium tabular-nums">{preview.attempt.destination_decimals != null ? formatUnits(preview.attempt.expected_output, preview.attempt.destination_decimals) : `${preview.attempt.expected_output} base units`}</p></div><Address value={preview.attempt.destination_address} network={preview.attempt.destination_network} full/>{preview.attempt.destination_memo && <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">Memo / tag</span><Address value={preview.attempt.destination_memo} label="receiving memo" full/></div>}</div>
    <dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Source total</dt><dd className="text-right tabular-nums">{usd(preview.attempt.amount_in)} USDC</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Route cost / limit</dt><dd className="text-right tabular-nums">{usd(sourceCost)} / {usd(preview.payment.max_fee)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Expires</dt><dd className="text-right">{deadline ? paymentTime(deadline, timeZone) : "Unavailable"}</dd></div>{preview.approvals && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Approvals</dt><dd className="text-right">Payment {preview.approvals.payment_collected}/{preview.approvals.required_approvals}<span className="mx-1 text-muted-foreground">·</span>Route {preview.approvals.attempt_collected}/{preview.approvals.required_approvals}</dd></div>}{preview.payment.scheduled_for && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Not before</dt><dd className="text-right">{paymentTime(preview.payment.scheduled_for, timeZone)}</dd></div>}</dl>
    <div className="border-t pt-5"><div className="flex flex-wrap items-center gap-3">{allowed && <Action disabled={!!busy} busy={busy === "route-action"} onClick={act}>{label}</Action>}{(canApprove || canExecute) && <button type="button" disabled={!!busy} className={quietButton} onClick={refresh}><RefreshCw size={14}/>Refresh</button>}</div>{["waiting", "scheduled"].includes(preview.stage) && <p className="mt-3 text-sm text-muted-foreground">{preview.stage === "scheduled" ? "Ready for the scheduled time." : preview.message}</p>}{canApprove && preview.stage === "approve" && !preview.approvalAccounts.length && <p className="mt-3 text-sm text-amber-900">Link an authorized NEAR wallet to approve.</p>}{canApprove && preview.stage === "approve" && preview.approvalAccounts.length > 0 && !preview.approvalActions.length && <p className="mt-3 text-sm text-muted-foreground">Waiting for another authorized wallet.</p>}<p className="mt-3 text-xs text-muted-foreground">{preview.stage === "execute" ? "Wallet gas is separate." : "This step does not send the payment. Wallet gas is separate."}</p></div>
    <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Authorization details</summary><div className="mt-4 grid gap-4"><p>Source: USDC on NEAR {preview.network} · {quote.kind === "direct" ? "Direct transfer" : "NEAR Intents"}</p>{preview.approvals && <><p>Policy {preview.approvals.policy_version} · {usd(preview.approvals.approval_amount)} approved ceiling</p><p className="break-all">Eligible approvers: {preview.approvalAccounts.join(", ") || "None"}</p><p className="break-all">Route approvals: {preview.approvals.attempt_approvals.join(", ") || "None"}</p><p className="break-all">Payment binding: {preview.approvals.payment_terms_hash}</p><p className="break-all">Route binding: {preview.approvals.attempt_terms_hash}</p></>}<p className="break-all">Attempt: {preview.attempt.id}</p><pre className="max-h-64 overflow-auto rounded-xl bg-muted p-3">{JSON.stringify({ walletActions: preview.walletActions, approvalActions: preview.approvalActions, quote }, null, 2)}</pre></div></details>
  </div>;
}
