"use client";

import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { FundingLeg } from "@/server/payments/types";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Field } from "./shared";

interface ReceiptView { funding: FundingLeg; provenance: string; receipts: { id: string; amount: string; transaction_hash: string; receipt_id: string; verified_at: string }[] }

export function FundingCreditReview({ fundingId, status, sourceContext, onUpdated }: { fundingId: string; status: string; sourceContext?: string; onUpdated: (funding: FundingLeg) => void }) {
  const { base, revision, refresh, organization, notify } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read"), canPrepare = !!organization.permissions?.includes("payments:prepare");
  const { data, error: loadError } = useResource<ReceiptView>(canRead ? `${base}/reconciliation/funding/${fundingId}` : null, revision);
  const { busy, error, run } = useAction();
  const verified = data?.provenance === "final_near_token_receipt";
  const canVerify = canRead && canPrepare && !verified && ["reported_delivered", "confirmed"].includes(status);
  const canClose = canPrepare && status === "pending_deposit" && !data?.funding.source_tx_hash && (!sourceContext || sourceContext === "company");
  return <section className="grid gap-4 border-t pt-4">
    {verified && <div role="status" className="rounded-lg bg-muted p-4 text-sm"><p>Final native-USDC treasury receipt verified: {usd(data.funding.credited_amount)}.</p><p className="mt-2 text-xs text-muted-foreground">If spendable cash has not updated, the treasury owner can register or refresh the token balance above. A source hash alone never creates company credit.</p><details className="mt-3 text-xs"><summary className="cursor-pointer">Verified receipt details</summary>{data.receipts.map(receipt => <p key={receipt.id} className="mt-2 break-all">{usd(receipt.amount)} USDC · {receipt.transaction_hash} · receipt {receipt.receipt_id}</p>)}</details></div>}
    {canVerify && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("verify-credit", async () => { const result = await api<ReceiptView>(`${base}/reconciliation/funding/${fundingId}/verify`, { ...(values.get("hash") ? { transactionHash: values.get("hash") } : {}), ...(values.get("sender") ? { senderAccountId: values.get("sender") } : {}), ...(values.get("receipt") ? { receiptId: values.get("receipt") } : {}) }); onUpdated(result.funding); refresh(); notify("Final NEAR receipt verified. Refresh the treasury token balance if its recorded cash still needs updating."); }); }}>
      <p className="sm:col-span-2 text-sm">The routing service reports arrival. Verify the final native-USDC receipt before treating this funding leg as confirmed.</p>
      <Field label="NEAR destination transaction (optional)" hint="Leave blank for automatic lookup when the provider returns one destination transaction."><input name="hash" className={control} minLength={32} maxLength={64} defaultValue={data?.funding.destination_tx_hash ?? ""}/></Field>
      <Field label="NEAR transaction signer (optional)" hint="Use the signer in the NEAR explorer if automatic lookup is unavailable."><input name="sender" className={control} minLength={2} maxLength={64}/></Field>
      <details className="sm:col-span-2"><summary className="cursor-pointer text-sm">Advanced receipt selection</summary><div className="mt-3"><Field label="Exact NEAR receipt ID (optional)"><input name="receipt" className={control} minLength={32} maxLength={64}/></Field></div></details>
      <div className="sm:col-span-2"><Action busy={busy === "verify-credit"} disabled={!!busy}>Verify final treasury credit</Action></div>
    </form>}
    {canClose && <div><button type="button" className="text-sm text-primary disabled:opacity-50" disabled={!!busy} onClick={() => void run("close-unsent", async () => { if (!window.confirm("Only close an expired quote if you checked your wallet or exchange and never submitted its source transfer. Keep uncertain transfers in reconciliation.")) return; const result = await api<{funding:FundingLeg}>(`${base}/source-funding/${fundingId}/close-unsent`, { noTransferConfirmed: true }); onUpdated(result.funding); refresh(); notify("The expired never-sent quote is closed. Its history remains available."); })}>Close expired quote I never sent</button><p className="mt-2 text-xs text-muted-foreground">A claimed, submitted or uncertain deposit cannot be cleared by this action.</p></div>}
    {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error || loadError}</p>}
  </section>;
}
