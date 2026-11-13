"use client";

import { useEffect, useState } from "react";
import { api, RequestError } from "@/lib/api";
import { microUsd, usd, usdcInput } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./shared";

interface Recovery { available: true; network: string; treasuryAccount: string; chainState: string; ownerAccounts: string[]; reporterAccounts: string[]; executorAccounts: string[]; providerStatus: string | null; reportedRefundAmount: string | null; canRecoverSource: boolean; canReport: boolean; canReportDelivery: boolean; canReportRefund: boolean; canConfirmRefund: boolean; canClose: boolean; hasObservedDelivery: boolean; message: string; attempt: { id: string; state: string; amount_in: string; destination_network: string; destination_address: string; source_tx_hash: string | null; destination_tx_hash: string | null } }
interface Prepared { walletActions: NearWalletAction[]; sourceOutcome?: string; evidenceCommitment?: string }
interface Review { kind: "source" | "settlement" | "refund" | "close"; attemptId: string; path: string; body: object; prepared: Prepared; signer: string }
const allowedAccounts = (data: Recovery, kind: Review["kind"]) => kind === "source" ? data.ownerAccounts : kind === "close" ? data.executorAccounts : data.reporterAccounts;
const actionAllowed = (data: Recovery, kind: Review["kind"]) => kind === "source" ? data.canRecoverSource : kind === "close" ? data.canClose : kind === "refund" ? data.canConfirmRefund : data.canReport;

export function PaymentRecoveryPanel({ paymentId }: { paymentId: string }) {
  const { base, revision, refresh, organization, notify } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read");
  const endpoint = `${base}/payments/${paymentId}/recovery`;
  const { data: response, loading, error: loadError } = useResource<Recovery | {available:false}>(canRead ? endpoint : null, revision);
  const data = response?.available ? response : null;
  const { busy, error, run } = useAction();
  const [signer, setSigner] = useState(""), [review, setReview] = useState<Review | null>(null), [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setReview(null); setSigner(""); setAcknowledged(false); }, [paymentId, base]);
  const accounts = data ? [...new Set([...data.ownerAccounts, ...data.reporterAccounts, ...data.executorAccounts])] : [];
  const selectedSigner = signer || (accounts.length === 1 ? accounts[0] : "");
  async function prepare(kind: Review["kind"], path: string, body: object) {
    if (!data || !allowedAccounts(data, kind).includes(selectedSigner)) throw new RequestError("Choose the verified NEAR account authorized for this recovery action.", 403, "SIGNER_ACCOUNT_REQUIRED");
    const prepared = await api<Prepared>(path, body);
    if (!prepared.walletActions.length) { setReview(null); refresh(); notify("This recovery step is already resolved. Review the refreshed payment status."); return; }
    setReview({ kind, path, body, prepared, signer: selectedSigner, attemptId: data.attempt.id }); setAcknowledged(false);
  }
  async function confirm() {
    if (!review || !acknowledged) return;
    const fresh = await api<Recovery | {available:false}>(endpoint);
    if (!fresh.available || fresh.attempt.id !== review.attemptId || !actionAllowed(fresh, review.kind) || !allowedAccounts(fresh, review.kind).includes(review.signer)) throw new RequestError("This recovery state or signer changed. Refresh and review the current original attempt.", 409, "RECOVERY_REVIEW_CHANGED");
    const prepared = await api<Prepared>(review.path, review.body);
    if (JSON.stringify(prepared.walletActions) !== JSON.stringify(review.prepared.walletActions)) { setReview({ ...review, prepared }); setAcknowledged(false); throw new RequestError("Recovery instructions changed. Review the current wallet calls before signing.", 409, "RECOVERY_REVIEW_CHANGED"); }
    await signNearActions(prepared.walletActions, fresh.network, [review.signer]);
    setReview(null); setAcknowledged(false);
    try { await api(`${base}/payments/${paymentId}/reconcile`, {}); }
    finally { refresh(); }
    notify("NEAR recovery authorization processed. Review its reconciled status before preparing another route.");
  }
  if (!canRead || response && !response.available) return null;
  return <Panel title="Original payout recovery" description="Resolve this exact attempt before preparing a replacement or backup. A timer, missing hash or provider failure does not prove the original cannot deliver.">
    {loading && <Empty>Checking the original NEAR attempt and authorized recovery wallets...</Empty>}
    {data && <div className="grid gap-5">
      <div className="rounded-lg bg-muted p-4 text-sm"><div className="flex flex-wrap gap-3"><Status value={data.attempt.state}/><Status value={data.chainState}/></div><p className="mt-3">{data.message}</p><p className="mt-2 text-xs">Original source budget: {usd(data.attempt.amount_in)} USDC. Provider: {data.providerStatus ?? "No conclusive report"}.</p><p className="mt-2 break-all text-xs">Attempt {data.attempt.id}</p></div>
      <div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs text-muted-foreground">Original receiving address</p><Address value={data.attempt.destination_address} network={data.attempt.destination_network}/></div><div><p className="mb-2 text-xs text-muted-foreground">Company recovery treasury</p><Address value={data.treasuryAccount} network={data.network}/></div></div>
      {accounts.length > 0 && <Field label="Verified NEAR signer for this recovery"><select className={control} value={selectedSigner} onChange={event => { setSigner(event.target.value); setReview(null); setAcknowledged(false); }} disabled={!!busy}><option value="">Choose an authorized account</option>{accounts.map(account => <option key={account} value={account}>{account}</option>)}</select></Field>}
      {!accounts.length && <p className="text-sm text-muted-foreground">An authorized owner, reporter or executor must link its NEAR wallet before signing recovery. Read-only monitoring remains available.</p>}
      <div><Action disabled={!!busy} busy={busy === "check"} onClick={() => void run("check", async () => { try { await api(`${base}/payments/${paymentId}/reconcile`, {}); } finally { refresh(); } })}>Check original payout status</Action></div>
      {data.canRecoverSource && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("source", () => prepare("source", `${base}/reconciliation/attempts/${data.attempt.id}/source`, { transactionHash: values.get("hash"), senderAccountId: values.get("sender") })); }}><p className="sm:col-span-2 text-sm">Recover a missing source callback from the exact final NEAR transaction and token-transfer receipt. The owner signs the verified outcome; no second source transfer is sent.</p><Field label="Original NEAR source transaction"><input name="hash" className={control} required minLength={32} maxLength={64} defaultValue={data.attempt.source_tx_hash ?? ""}/></Field><Field label="Original transaction signer"><input name="sender" className={control} required minLength={2} maxLength={64}/></Field><div className="sm:col-span-2"><Action busy={busy === "source"} disabled={!!busy || !data.ownerAccounts.includes(selectedSigner)}>Inspect final source receipt</Action></div></form>}
      {data.canReport && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("settlement", () => prepare("settlement", `${base}/attempts/${data.attempt.id}/settlement`, { outcome: values.get("outcome"), receipt: values.get("evidence") })); }}><Field label="Authoritative route outcome"><select name="outcome" className={control} required><option value="uncertain">Still uncertain, keep the payment held</option>{data.canReportDelivery && <option value="delivered">Complete delivery reported with its exact output</option>}{data.canReportRefund && ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(data.providerStatus ?? "") && <option value="refund_pending">Original route closed without delivery, refund pending</option>}</select></Field><Field label="Private receipt or closure evidence" hint="Only a commitment goes into the NEAR report. The private text stays in the company's retained evidence."><textarea name="evidence" className={control} required maxLength={2000} rows={3} defaultValue={data.attempt.destination_tx_hash ?? ""}/></Field><div className="sm:col-span-2"><Action busy={busy === "settlement"} disabled={!!busy || !data.reporterAccounts.includes(selectedSigner)}>Review reporter attestation</Action></div><p className="sm:col-span-2 text-xs text-muted-foreground">External-chain delivery and route closure are owner or reporter attestations. A reported refund alone does not release funds or enable backup.</p></form>}
      {data.canConfirmRefund && data.providerStatus === "REFUNDED" && data.reportedRefundAmount !== null && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("refund", () => prepare("refund", `${base}/attempts/${data.attempt.id}/refund`, { refundAmount: microUsd(String(values.get("amount")), true), receipt: values.get("evidence") })); }}><Field label="Exact returned source USDC" hint={`The routing service reports ${usd(data.reportedRefundAmount)}. The NEAR callback must also confirm recovered availability.`}><input name="amount" className={control} required inputMode="decimal" defaultValue={usdcInput(data.reportedRefundAmount)}/></Field><Field label="Private refund receipt and closure evidence"><textarea name="evidence" className={control} required maxLength={2000} rows={3}/></Field><div className="sm:col-span-2"><Action busy={busy === "refund"} disabled={!!busy || !data.reporterAccounts.includes(selectedSigner)}>Review recovered USDC confirmation</Action></div></form>}
      {data.canConfirmRefund && data.providerStatus !== "REFUNDED" && <p className="text-sm text-muted-foreground">Wait for the original route's completed refund report and exact returned quantity. Keep checking this attempt; no replacement is enabled by an estimated refund.</p>}
      {data.canClose && <div><Action disabled={!!busy || !data.executorAccounts.includes(selectedSigner)} busy={busy === "close"} onClick={() => void run("close", () => prepare("close", `${base}/attempts/${data.attempt.id}/close`, {}))}>Review closing the unsent payout route</Action></div>}
      {review && review.attemptId === data.attempt.id && <section className="grid gap-4 rounded-lg border border-primary/30 bg-secondary p-4"><h3 className="font-semibold">Review exact NEAR recovery</h3><p className="text-sm">Signer {review.signer} on NEAR {data.network}. {review.prepared.sourceOutcome ? `Verified source outcome: ${review.prepared.sourceOutcome}.` : "This action updates the original attempt's authoritative recovery state."}</p><p className="text-xs text-muted-foreground">Wallet gas and any attached yoctoNEAR are shown in the exact calls below. Recovery never requests a second source payment.</p><details><summary className="cursor-pointer text-sm">Exact wallet calls</summary><pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-card p-3 text-xs">{JSON.stringify(review.prepared.walletActions, null, 2)}</pre></details><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={!!busy}/><span>I reviewed the original attempt, final evidence, exact amounts and authorized signer. Any refund closure is an explicit attestation that the original route cannot still deliver.</span></label><div className="flex flex-wrap gap-4"><Action busy={busy === "confirm"} disabled={!!busy || !acknowledged} onClick={() => void run("confirm", confirm)}>Authorize this recovery in NEAR wallet</Action><button type="button" className="text-sm text-primary" disabled={!!busy} onClick={() => { setReview(null); setAcknowledged(false); }}>Cancel review</button></div></section>}
    </div>}
    {(error || loadError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || loadError}</p>}
  </Panel>;
}
