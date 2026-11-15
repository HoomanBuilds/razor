"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { withTaskDrawerWallet } from "./task-drawer";
import { api, RequestError } from "@/lib/api";
import { microUsd, usd, usdcInput } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./shared";

interface Recovery { available: true; network: string; treasuryAccount: string; chainState: string; ownerAccounts: string[]; reporterAccounts: string[]; refundAccounts: string[]; sourceRecoveryAccounts: string[]; requiresPlatformRecovery: boolean; refundReporter: string | null; executorAccounts: string[]; providerStatus: string | null; reportedRefundAmount: string | null; canRecoverSource: boolean; canReport: boolean; canReportDelivery: boolean; canReportRefund: boolean; canConfirmRefund: boolean; canClose: boolean; hasObservedDelivery: boolean; message: string; attempt: { id: string; state: string; amount_in: string; destination_network: string; destination_address: string; source_tx_hash: string | null; destination_tx_hash: string | null } }
interface Prepared { walletActions: NearWalletAction[]; sourceOutcome?: string; eligibleSigners?: string[]; evidenceCommitment?: string }
interface Review { kind: "source" | "settlement" | "refund" | "close"; attemptId: string; path: string; body: object; prepared: Prepared; signer: string }
const allowedAccounts = (data: Recovery, kind: Review["kind"]) => kind === "source" ? data.sourceRecoveryAccounts : kind === "close" ? data.executorAccounts : kind === "refund" ? data.refundAccounts : data.reporterAccounts;
const actionAllowed = (data: Recovery, kind: Review["kind"]) => kind === "source" ? data.canRecoverSource : kind === "close" ? data.canClose : kind === "refund" ? data.canConfirmRefund : data.canReport;

export function PaymentRecoveryPanel({ paymentId, focused = false }: { paymentId: string; focused?: boolean }) {
  return <RecoveryContent key={paymentId} paymentId={paymentId} focused={focused}/>;
}
function RecoveryContent({ paymentId, focused }: { paymentId: string; focused: boolean }) {
  const { base, revision, refresh, organization, notify } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read");
  const endpoint = `${base}/payments/${paymentId}/recovery`;
  const { data: response, loading, refreshing, error: loadError } = useResource<Recovery | {available:false}>(canRead ? endpoint : null, revision);
  const data = response?.available ? response : null;
  const { busy, error, run } = useAction();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [base]);
  const [task, setTask] = useState<Review["kind"] | null>(null);
  const [signer, setSigner] = useState(""), [review, setReview] = useState<Review | null>(null), [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setReview(null); setSigner(""); setAcknowledged(false); }, [paymentId, base]);
  useEffect(() => { setReview(null); setAcknowledged(false); }, [data?.attempt.id, data?.chainState, data?.providerStatus]);
  const accounts = data ? [...new Set([...data.sourceRecoveryAccounts, ...data.refundAccounts, ...data.reporterAccounts, ...data.executorAccounts])] : [];
  const selectedSigner = signer || (accounts.length === 1 ? accounts[0] : "");
  async function prepare(kind: Review["kind"], path: string, body: object) {
    const recoverySigner = data && focused && allowedAccounts(data, kind).length === 1 ? allowedAccounts(data, kind)[0] : selectedSigner;
    if (!data || !allowedAccounts(data, kind).includes(recoverySigner)) throw new RequestError("Choose the verified NEAR account authorized for this recovery action.", 403, "SIGNER_ACCOUNT_REQUIRED");
    const prepared = await api<Prepared>(path, body);
    if (!active.current) return;
    if (prepared.eligibleSigners && !prepared.eligibleSigners.includes(recoverySigner)) throw new RequestError("This verified outcome requires the platform recovery reporter. Select that authorized signer or leave it pending for operator review.", 409, "PLATFORM_RECOVERY_REQUIRED");
    if (!prepared.walletActions.length) { setReview(null); refresh(); notify("This recovery step is already resolved. Review the refreshed payment status."); return; }
    setReview({ kind, path, body, prepared, signer: recoverySigner, attemptId: data.attempt.id }); setAcknowledged(false);
  }
  async function confirm() {
    if (!review || !acknowledged) return;
    const fresh = await api<Recovery | {available:false}>(endpoint);
    if (!fresh.available || fresh.attempt.id !== review.attemptId || !actionAllowed(fresh, review.kind) || !allowedAccounts(fresh, review.kind).includes(review.signer)) throw new RequestError("This recovery state or signer changed. Refresh and review the current original attempt.", 409, "RECOVERY_REVIEW_CHANGED");
    const prepared = await api<Prepared>(review.path, review.body);
    if (JSON.stringify(prepared.walletActions) !== JSON.stringify(review.prepared.walletActions)) { setReview({ ...review, prepared }); setAcknowledged(false); throw new RequestError("Recovery instructions changed. Review the current wallet calls before signing.", 409, "RECOVERY_REVIEW_CHANGED"); }
    if (prepared.eligibleSigners && !prepared.eligibleSigners.includes(review.signer)) throw new RequestError("The recovery authority changed. Review its current signer.", 409, "RECOVERY_REVIEW_CHANGED");
    if (!active.current) return;
    await withTaskDrawerWallet(() => signNearActions(prepared.walletActions, fresh.network, [review.signer]));
    setReview(null); setAcknowledged(false); setTask(null);
    try { await api(`${base}/payments/${paymentId}/reconcile`, {}); }
    finally { refresh(); }
    notify("NEAR recovery authorization processed. Review its reconciled status before preparing another route.");
  }
  if (!canRead || response && !response.available) return null;
  if (focused) {
    const locked = !!busy || refreshing || !!loadError;
    const options = data ? [
      { kind: "source" as const, title: "Verify source transfer", label: "Final NEAR receipt", enabled: data.canRecoverSource },
      { kind: "settlement" as const, title: "Report delivery outcome", label: "Reporter attestation", enabled: data.canReport },
      { kind: "refund" as const, title: "Confirm returned USDC", label: data.reportedRefundAmount ? usd(data.reportedRefundAmount) : "Awaiting refund", enabled: data.canConfirmRefund && data.providerStatus === "REFUNDED" && data.reportedRefundAmount !== null },
      { kind: "close" as const, title: "Close unsent payout", label: "Original route only", enabled: data.canClose },
    ].filter(option => option.enabled) : [];
    const choice = options.find(option => option.kind === task), currentAccounts = data && task ? allowedAccounts(data, task) : [];
    const pick = (kind: Review["kind"] | null) => { setTask(kind); setReview(null); setAcknowledged(false); setSigner(""); };
    const eligibleSigner = currentAccounts.includes(selectedSigner) ? selectedSigner : currentAccounts.length === 1 ? currentAccounts[0] : "";
    const formSigner = <Field label="Authorized NEAR wallet"><select className={control} value={eligibleSigner} onChange={event => { setSigner(event.target.value); setReview(null); setAcknowledged(false); }} disabled={locked} required><option value="">Choose wallet</option>{currentAccounts.map(account => <option key={account}>{account}</option>)}</select></Field>;
    return <section aria-busy={!!busy} className="grid gap-5">
      {loading && <Empty>Loading recovery...</Empty>}
      {data && <>
        {task && <button type="button" disabled={!!busy} className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground" onClick={() => review ? (setReview(null), setAcknowledged(false)) : pick(null)}><ChevronLeft size={16}/>{review ? "Edit recovery" : "Recovery"}</button>}
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xl font-medium">{review ? "Authorize recovery" : choice?.title || "Payment recovery"}</h3><Status value={data.attempt.state}/></div>
        <div className="grid gap-3 rounded-2xl bg-muted/50 p-5"><div className="flex justify-between gap-4 text-sm"><span className="text-muted-foreground">Original source</span><strong className="font-medium tabular-nums">{usd(data.attempt.amount_in)} USDC</strong></div><div><p className="mb-2 text-xs text-muted-foreground">Receiving address · {data.attempt.destination_network}</p><Address value={data.attempt.destination_address} network={data.attempt.destination_network}/></div></div>
        {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error || loadError}</p>}
        {!task && <>
          {!!options.length && <div className="divide-y rounded-2xl border px-4">{options.map(option => <button key={option.kind} type="button" disabled={locked} onClick={() => { pick(option.kind); const signers = allowedAccounts(data, option.kind); if (signers.length === 1) setSigner(signers[0]); }} className="flex w-full items-center justify-between gap-4 py-4 text-left"><div><p className="text-sm font-medium">{option.title}</p><p className="mt-1 text-xs text-muted-foreground">{option.label}</p></div><ChevronRight size={16}/></button>)}</div>}
          {!options.length && <p role="status" className="text-sm text-muted-foreground">{data.requiresPlatformRecovery && data.chainState === "refund_pending" ? "Awaiting verified refund allocation." : "Awaiting conclusive delivery evidence."}</p>}
          <div><Action disabled={locked} busy={busy === "check"} onClick={() => void run("check", async () => { try { await api(`${base}/payments/${paymentId}/reconcile`, {}); } finally { refresh(); } })}>Check status</Action></div>
          <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Recovery details</summary><div className="mt-4 grid gap-4"><div className="flex justify-between gap-4"><span>NEAR state</span><Status value={data.chainState}/></div><div className="flex justify-between gap-4"><span>Provider status</span><span>{data.providerStatus || "Unconfirmed"}</span></div><Field as="div" label="Company recovery treasury"><Address value={data.treasuryAccount} network={data.network}/></Field><Field as="div" label="Original attempt"><Address value={data.attempt.id} label="attempt ID"/></Field></div></details>
        </>}
        {task && !review && choice && <form key={`${data.attempt.id}:${task}:${data.providerStatus}:${data.chainState}`} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run(task, () => task === "source" ? prepare("source", `${base}/reconciliation/attempts/${data.attempt.id}/source`, { transactionHash: values.get("hash"), senderAccountId: values.get("sender") }) : task === "settlement" ? prepare("settlement", `${base}/attempts/${data.attempt.id}/settlement`, { outcome: values.get("outcome"), receipt: values.get("evidence") }) : task === "refund" ? prepare("refund", `${base}/attempts/${data.attempt.id}/refund`, { refundAmount: microUsd(String(values.get("amount")), true), receipt: values.get("evidence") }) : prepare("close", `${base}/attempts/${data.attempt.id}/close`, {})); }}>
          {formSigner}
          {!currentAccounts.length && <p role="status" className="text-sm text-muted-foreground">An authorized recovery wallet must be linked.</p>}
          {task === "source" && <><Field label="Original NEAR transaction hash"><input name="hash" className={control} required minLength={32} maxLength={64} defaultValue={data.attempt.source_tx_hash ?? ""}/></Field><Field label="Original transaction signer"><input name="sender" className={control} required minLength={2} maxLength={64}/></Field></>}
          {task === "settlement" && <><Field label="Outcome"><select name="outcome" className={control} required><option value="uncertain">Uncertain, keep funds held</option>{data.canReportDelivery && <option value="delivered">Delivered in full</option>}{data.canReportRefund && ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(data.providerStatus ?? "") && <option value="refund_pending">Route closed, refund pending</option>}</select></Field><Field label="Private delivery or closure evidence"><textarea name="evidence" className={control} required maxLength={2000} rows={3} defaultValue={data.attempt.destination_tx_hash ?? ""}/></Field><p className="text-xs text-muted-foreground">Reporter attestation. Only its commitment is published.</p></>}
          {task === "refund" && <><Field label="Returned USDC" hint={`Provider report: ${usd(data.reportedRefundAmount!)}`}><input name="amount" className={control} required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" defaultValue={usdcInput(data.reportedRefundAmount!)}/></Field><Field label={data.requiresPlatformRecovery ? "NEAR refund transaction hash" : "Private refund and closure evidence"}><textarea name="evidence" className={control} required maxLength={2000} rows={3}/></Field></>}
          {task === "close" && <p className="text-sm text-muted-foreground">Close this original route without sending another payment.</p>}
          <div className="flex justify-end border-t pt-5"><Action busy={busy === task} disabled={locked || !eligibleSigner}>Review recovery</Action></div>
        </form>}
        {task && !choice && !review && <p role="status" className="text-sm text-muted-foreground">Recovery changed. Return to its current actions.</p>}
        {review && review.attemptId === data.attempt.id && <div className="grid gap-5">
          <dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Signer</dt><dd className="break-all text-right">{review.signer}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Network</dt><dd>NEAR {data.network}</dd></div>{review.prepared.sourceOutcome && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Verified source</dt><dd>{review.prepared.sourceOutcome}</dd></div>}</dl>
          <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Exact wallet calls</summary><pre className="mt-4 max-h-64 overflow-auto text-xs">{JSON.stringify(review.prepared.walletActions, null, 2)}</pre></details>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={locked}/><span>{review.kind === "refund" ? "I confirm the returned amount and that this original route cannot still deliver." : review.kind === "source" ? "I reviewed the final source receipt and authorized signer." : review.kind === "close" ? "I verified this original payout was never sent." : "I attest this outcome using the reviewed delivery or closure evidence."}</span></label>
          <div className="flex justify-end border-t pt-5"><Action busy={busy === "confirm"} disabled={locked || !acknowledged} onClick={() => void run("confirm", confirm)}>Confirm in wallet</Action></div>
        </div>}
      </>}
      {!data && loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
    </section>;
  }
  return <Panel title="Original payout recovery" description="Resolve this exact attempt before preparing a replacement or backup. A timer, missing hash or provider failure does not prove the original cannot deliver.">
    {loading && <Empty>Checking the original NEAR attempt and authorized recovery wallets...</Empty>}
    {data && <div className="grid gap-5">
      <div className="rounded-lg bg-muted p-4 text-sm"><div className="flex flex-wrap gap-3"><Status value={data.attempt.state}/><Status value={data.chainState}/></div><p className="mt-3">{data.message}</p><p className="mt-2 text-xs">Original source budget: {usd(data.attempt.amount_in)} USDC. Provider: {data.providerStatus ?? "No conclusive report"}.</p><p className="mt-2 break-all text-xs">Attempt {data.attempt.id}</p></div>
      <div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs text-muted-foreground">Original receiving address</p><Address value={data.attempt.destination_address} network={data.attempt.destination_network}/></div><div><p className="mb-2 text-xs text-muted-foreground">Company recovery treasury</p><Address value={data.treasuryAccount} network={data.network}/></div></div>
      {accounts.length > 0 && <Field label="Verified NEAR signer for this recovery"><select className={control} value={selectedSigner} onChange={event => { setSigner(event.target.value); setReview(null); setAcknowledged(false); }} disabled={!!busy}><option value="">Choose an authorized account</option>{accounts.map(account => <option key={account} value={account}>{account}</option>)}</select></Field>}
      {!accounts.length && <p className="text-sm text-muted-foreground">An authorized owner, reporter or executor must link its NEAR wallet before signing recovery. Read-only monitoring remains available.</p>}
      <div><Action disabled={!!busy} busy={busy === "check"} onClick={() => void run("check", async () => { try { await api(`${base}/payments/${paymentId}/reconcile`, {}); } finally { refresh(); } })}>Check original payout status</Action></div>
      {data.canRecoverSource && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("source", () => prepare("source", `${base}/reconciliation/attempts/${data.attempt.id}/source`, { transactionHash: values.get("hash"), senderAccountId: values.get("sender") })); }}><p className="sm:col-span-2 text-sm">Recover a missing source callback from the exact final NEAR transaction and token-transfer receipt. The owner can confirm a successful transfer. Restoring shared-wallet credit after a failed transfer requires the platform recovery reporter; no second source transfer is sent.</p><Field label="Original NEAR source transaction"><input name="hash" className={control} required minLength={32} maxLength={64} defaultValue={data.attempt.source_tx_hash ?? ""}/></Field><Field label="Original transaction signer"><input name="sender" className={control} required minLength={2} maxLength={64}/></Field><div className="sm:col-span-2"><Action busy={busy === "source"} disabled={!!busy || !data.sourceRecoveryAccounts.includes(selectedSigner)}>Inspect final source receipt</Action></div></form>}
      {data.canReport && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("settlement", () => prepare("settlement", `${base}/attempts/${data.attempt.id}/settlement`, { outcome: values.get("outcome"), receipt: values.get("evidence") })); }}><Field label="Authoritative route outcome"><select name="outcome" className={control} required><option value="uncertain">Still uncertain, keep the payment held</option>{data.canReportDelivery && <option value="delivered">Complete delivery reported with its exact output</option>}{data.canReportRefund && ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(data.providerStatus ?? "") && <option value="refund_pending">Original route closed without delivery, refund pending</option>}</select></Field><Field label="Private receipt or closure evidence" hint="Only a commitment goes into the NEAR report. The private text stays in the company's retained evidence."><textarea name="evidence" className={control} required maxLength={2000} rows={3} defaultValue={data.attempt.destination_tx_hash ?? ""}/></Field><div className="sm:col-span-2"><Action busy={busy === "settlement"} disabled={!!busy || !data.reporterAccounts.includes(selectedSigner)}>Review reporter attestation</Action></div><p className="sm:col-span-2 text-xs text-muted-foreground">External-chain delivery and route closure are owner or reporter attestations. A reported refund alone does not release funds or enable backup.</p></form>}
      {data.canConfirmRefund && data.providerStatus === "REFUNDED" && data.reportedRefundAmount !== null && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("refund", () => prepare("refund", `${base}/attempts/${data.attempt.id}/refund`, { refundAmount: microUsd(String(values.get("amount")), true), receipt: values.get("evidence") })); }}><Field label="Exact returned source USDC" hint={`The routing service reports ${usd(data.reportedRefundAmount)}. The NEAR callback must also confirm recovered availability.`}><input name="amount" className={control} required inputMode="decimal" defaultValue={usdcInput(data.reportedRefundAmount)}/></Field><Field label={data.requiresPlatformRecovery ? "Provider-reported NEAR refund transaction hash" : "Private refund receipt and closure evidence"}><textarea name="evidence" className={control} required maxLength={2000} rows={3}/></Field><div className="sm:col-span-2"><Action busy={busy === "refund"} disabled={!!busy || !data.refundAccounts.includes(selectedSigner)}>Review recovered USDC confirmation</Action></div></form>}
      {data.requiresPlatformRecovery && data.chainState === "refund_pending" && !data.canConfirmRefund && <p className="text-sm text-muted-foreground">Shared-wallet refund allocation awaits the platform recovery reporter after final receipt verification. Company balances remain held until attribution is confirmed.</p>}
      {data.canConfirmRefund && data.providerStatus !== "REFUNDED" && <p className="text-sm text-muted-foreground">Wait for the original route's completed refund report and exact returned quantity. Keep checking this attempt; no replacement is enabled by an estimated refund.</p>}
      {data.canClose && <div><Action disabled={!!busy || !data.executorAccounts.includes(selectedSigner)} busy={busy === "close"} onClick={() => void run("close", () => prepare("close", `${base}/attempts/${data.attempt.id}/close`, {}))}>Review closing the unsent payout route</Action></div>}
      {review && review.attemptId === data.attempt.id && <section className="grid gap-4 rounded-lg border border-primary/30 bg-secondary p-4"><h3 className="font-semibold">Review exact NEAR recovery</h3><p className="text-sm">Signer {review.signer} on NEAR {data.network}. {review.prepared.sourceOutcome ? `Verified source outcome: ${review.prepared.sourceOutcome}.` : "This action updates the original attempt's authoritative recovery state."}</p><p className="text-xs text-muted-foreground">Wallet gas and any attached yoctoNEAR are shown in the exact calls below. Recovery never requests a second source payment.</p><details><summary className="cursor-pointer text-sm">Exact wallet calls</summary><pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-card p-3 text-xs">{JSON.stringify(review.prepared.walletActions, null, 2)}</pre></details><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={!!busy}/><span>I reviewed the original attempt, final evidence, exact amounts and authorized signer. Any refund closure is an explicit attestation that the original route cannot still deliver.</span></label><div className="flex flex-wrap gap-4"><Action busy={busy === "confirm"} disabled={!!busy || !acknowledged} onClick={() => void run("confirm", confirm)}>Authorize this recovery in NEAR wallet</Action><button type="button" className="text-sm text-primary" disabled={!!busy} onClick={() => { setReview(null); setAcknowledged(false); }}>Cancel review</button></div></section>}
    </div>}
    {(error || loadError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || loadError}</p>}
  </Panel>;
}
