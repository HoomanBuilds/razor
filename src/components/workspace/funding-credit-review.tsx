"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { isDirectFunding } from "@/lib/direct-funding";
import { usd } from "@/lib/format";
import type { FundingLeg } from "@/server/payments/types";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Field } from "./shared";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer } from "./task-drawer";

interface ReceiptView { funding: FundingLeg; provenance: string; receipts: { id: string; amount: string; transaction_hash: string; receipt_id: string; verified_at: string }[] }

export function FundingCreditReview({ fundingId, reference, status, sourceContext, onUpdated }: { fundingId: string; reference: string; status: string; sourceContext?: string; onUpdated: (funding: FundingLeg) => void }) {
  const { base, revision, refresh, organization, notify } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read"), canPrepare = !!organization.permissions?.includes("payments:prepare");
  const { data, error: loadError } = useResource<ReceiptView>(canRead ? `${base}/reconciliation/funding/${fundingId}` : null, revision);
  const { busy, error, run } = useAction();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (status !== "pending_deposit") return; const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, [status]);
  const verified = data?.provenance === "final_near_token_receipt";
  let quote: { quote?: { deadline?: string }; quoteRequest?: { deadline?: string } } | null = null;
  try { if (data?.funding) quote = JSON.parse(data.funding.quote); } catch {}
  const direct = isDirectFunding(quote), deadline = Date.parse(quote?.quote?.deadline ?? quote?.quoteRequest?.deadline ?? "");
  const canVerify = canRead && canPrepare && !verified && (["reported_delivered", "confirmed"].includes(status) || direct && !!data?.funding.source_tx_hash && !["refunded_verified", "refunded_attested"].includes(status));
  const canClose = canPrepare && status === "pending_deposit" && Number.isFinite(deadline) && deadline <= now && !!data && !data.funding.source_tx_hash && (!sourceContext || sourceContext === "company");
  const closeId = `close-funding-${fundingId}`;
  return <section aria-busy={!!busy} className="grid gap-4 border-t pt-5">
    {verified && <div className="grid gap-3"><div role="status" className="flex items-center justify-between gap-4 text-sm"><span className="text-emerald-700">Treasury credit verified</span><span className="font-medium tabular-nums">{usd(data.funding.credited_amount)}</span></div><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Receipts</summary><div className="mt-4 divide-y">{data.receipts.map(receipt => <div key={receipt.id} className="grid gap-3 py-4"><div className="flex justify-between gap-3"><span className="text-sm font-medium text-foreground">{usd(receipt.amount)} USDC</span><span>{new Date(receipt.verified_at).toLocaleDateString()}</span></div><div><p className="mb-1">Transaction</p><Address value={receipt.transaction_hash} label="transaction hash" /></div><div><p className="mb-1">Receipt ID</p><Address value={receipt.receipt_id} label="receipt ID" /></div></div>)}</div></details></div>}
    {data?.provenance === "final_near_unused_token_return" && <p role="status" className="text-sm">Returned to source. No treasury credit.</p>}
    {canVerify && <form key={fundingId} className="grid gap-4" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("verify-credit", async () => { const result = await api<ReceiptView>(`${base}/reconciliation/funding/${fundingId}/verify`, { ...(values.get("hash") ? { transactionHash: values.get("hash") } : {}), ...(values.get("sender") ? { senderAccountId: values.get("sender") } : {}), ...(values.get("receipt") ? { receiptId: values.get("receipt") } : {}) }); onUpdated(result.funding); refresh(); notify("Treasury receipt verified."); }); }}>
      <details onInvalidCapture={event => { event.currentTarget.open = true; }}><summary className="cursor-pointer text-sm text-muted-foreground">Transaction details (optional)</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="NEAR transaction hash"><input name="hash" className={control} minLength={32} maxLength={64} defaultValue={data?.funding.destination_tx_hash ?? data?.funding.source_tx_hash ?? ""}/></Field><Field label="NEAR transaction signer"><input name="sender" className={control} minLength={2} maxLength={64}/></Field><div className="sm:col-span-2"><Field label="Receipt ID"><input name="receipt" className={control} minLength={32} maxLength={64}/></Field></div></div></details>
      <div><Action busy={busy === "verify-credit"} disabled={!!busy}>Verify treasury credit</Action></div>
    </form>}
    {canClose && <button type="button" className="justify-self-start text-sm text-muted-foreground hover:text-destructive disabled:opacity-50" disabled={!!busy} onClick={() => openTaskDrawer(closeId)}>Close expired quote</button>}
    <TaskDrawer id={closeId} title="Close unsent quote" description={reference}><form key={`${fundingId}:${data?.funding.quote}`} aria-busy={!!busy} className="grid gap-5" onSubmit={event => { event.preventDefault(); if (!canClose) return; void run("close-unsent", async () => { const result = await api<{ funding: FundingLeg }>(`${base}/source-funding/${fundingId}/close-unsent`, { noTransferConfirmed: true }); closeTaskDrawer(closeId, true); onUpdated(result.funding); refresh(); notify("Unsent quote closed."); }); }}><label className="flex items-start gap-3 text-sm"><input type="checkbox" required className="mt-1"/>I checked my wallet and never sent this transfer.</label><div className="flex justify-end"><Action busy={busy === "close-unsent"} disabled={!canClose || !!busy}>Close quote</Action></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</form></TaskDrawer>
    {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error || loadError}</p>}
  </section>;
}
