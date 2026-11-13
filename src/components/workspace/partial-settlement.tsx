"use client";

import { useState } from "react";
import { api, RequestError } from "@/lib/api";
import { microUsd, usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import type { partialReview } from "@/server/partial-settlement/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Field, Status } from "./shared";

type Review = ReturnType<typeof partialReview>;
interface PartialWalletReview { walletActions: NearWalletAction[]; network: string; creditedUSDC: string; actualOutput: string; remainingUSDC: string }
export function partialReviewId(payment: { id: string; status: string; metadata?: string }) {
  if (["held", "recovery_pending", "partially_paid"].includes(payment.status)) return payment.id;
  try { const value = JSON.parse(payment.metadata || "{}").partialOf; return typeof value === "string" ? value : payment.id; } catch { return payment.id; }
}
function amount(value: FormDataEntryValue | null, zero = false) {
  try { return microUsd(String(value), zero); } catch (error) { throw new RequestError((error as Error).message, 422, "INVALID_AMOUNT"); }
}

export function PartialSettlementPanel({ paymentId }: { paymentId: string }) {
  const { base, revision, refresh, notify, navigate, organization } = useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const resource = useResource<Review>(canRead ? `${base}/partial-settlements/payments/${paymentId}` : null, revision), { busy, error, run } = useAction();
  const [wallet, setWallet] = useState<PartialWalletReview | null>(null);
  const data = resource.data, canPrepare = organization.permissions?.includes("payments:prepare"), canApprove = organization.permissions?.includes("payments:approve");
  if (!canRead || !data || !data.settlement && data.attempt?.state !== "reported_partial") return null;
  const attempt = data.attempt;
  const output = (value: string) => attempt?.destination_decimals != null ? `${formatUnits(value, attempt.destination_decimals)} ${attempt.destination_symbol || attempt.destination_asset}` : `${value} destination base units`;
  const profile = data.remainder ? JSON.parse(data.remainder.recipient_snapshot) as {primary_address:string;primary_network:string} : null;
  return <section className="mt-4 grid gap-4 rounded-lg border p-4"><div><h3 className="text-sm font-semibold">Partial delivery and remaining entitlement</h3><p className="mt-2 text-xs text-muted-foreground">The original payment cannot retry in full. Destination tokens and credited USDC entitlement are different amounts unless the destination is verified native USDC.</p></div>
    {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}
    {attempt?.observed_output && <p className="text-sm">Observed destination output: {output(attempt.observed_output)}. Original quoted output: {output(attempt.expected_output)}.</p>}
    {!data.settlement && canApprove && <form className="grid gap-3" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run("prepare-partial",async()=>{const prepared=await api<PartialWalletReview>(`${base}/partial-settlements/attempts/${attempt!.id}/prepare`,{creditedUSDC:amount(values.get("credit")),receipt:values.get("receipt"),valuationNote:values.get("valuation"),routeClosed:values.has("closed"),reviewConfirmed:values.has("reviewed")});if(!prepared.walletActions.length){setWallet(null);refresh();notify("This partial settlement is already reconciled. Review its current remaining entitlement.");return;}setWallet(prepared);});}}>
      <Field label="Agreed USDC entitlement credited"><input name="credit" required inputMode="decimal" className={control} placeholder="Amount of the original entitlement satisfied"/></Field>
      <Field label="Delivery and terminal route closure evidence"><textarea name="receipt" required minLength={3} maxLength={1000} className={control} placeholder="Verified destination transaction and evidence no further funds can arrive"/></Field>
      <Field label="Basis for the agreed USDC credit"><textarea name="valuation" required minLength={3} maxLength={400} className={control} placeholder="Record the agreed value of the actual received asset. Native USDC credits must equal the USDC received."/></Field>
      <label className="flex items-start gap-2 text-xs"><input name="closed" type="checkbox" required/><span>I verified this route is terminal and cannot deliver further funds.</span></label>
      <label className="flex items-start gap-2 text-xs"><input name="reviewed" type="checkbox" required/><span>I reviewed the actual received asset and agreed USDC credit. The NEAR treasury trusts the owner or appointed reporter attestation.</span></label>
      <div><Action disabled={!!busy} busy={busy==="prepare-partial"}>Review terminal partial attestation</Action></div>
    </form>}
    {wallet && canApprove && <div className="grid gap-3 rounded-lg bg-muted p-4"><p className="text-sm">Attest {output(wallet.actualOutput)}, credit {usd(wallet.creditedUSDC)} of entitlement, and leave {usd(wallet.remainingUSDC)} unpaid.</p><p className="text-xs">All source spending stays recorded. This action authorizes no remainder payout.</p><details className="text-xs"><summary className="cursor-pointer">Review exact NEAR attestation</summary><pre className="mt-2 max-h-64 overflow-auto">{JSON.stringify(wallet.walletActions,null,2)}</pre></details><div className="flex gap-3"><Action disabled={!!busy} busy={busy==="sign-partial"} onClick={()=>void run("sign-partial",async()=>{try{await signNearActions(wallet.walletActions,wallet.network);await api(`${base}/payments/${paymentId}/reconcile`,{});notify("Partial attestation submitted. Only final NEAR state records the credit and permits a new remainder.");refresh();}finally{setWallet(null);}})}>Confirm in reporter's NEAR wallet</Action><Action disabled={!!busy} onClick={()=>setWallet(null)}>Close review</Action></div></div>}
    {data.settlement && <><div className="grid gap-3 text-sm sm:grid-cols-3"><p>Original entitlement<br/><strong>{usd(data.payment.amount)}</strong></p><p>Credited entitlement<br/><strong>{usd(data.settlement.credited_usdc)}</strong></p><p>Unpaid remainder<br/><strong>{usd(data.remaining!)}</strong></p></div><p className="text-xs">Actual source spent: {usd(data.settlement.source_spent_usdc)}. The remaining amount requires a fresh draft, current recipient preferences and new approval.</p>
      {!data.remainder && canPrepare && <form className="grid gap-3 sm:grid-cols-2" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run("remainder",async()=>{await api(`${base}/partial-settlements/payments/${paymentId}/remainder`,{reviewToken:data.reviewToken,maxFee:amount(values.get("fee"),true)});notify("Only the unpaid remainder was drafted using the current recipient profile. It still requires fresh approval.");refresh();});}}><Field label="New maximum routing cost (USDC)"><input name="fee" required className={control} inputMode="decimal" defaultValue="1"/></Field><p className="self-center text-xs">Current recipient profile version {data.currentRecipientVersion}; {data.currentRecipientConfirmed?"confirmed":"confirmation required"}.</p><div><Action disabled={!!busy||!data.currentRecipientConfirmed} busy={busy==="remainder"}>Create only the unpaid remainder</Action></div></form>}
      {data.remainder && <div className="grid gap-3"><div className="flex flex-wrap gap-3 text-sm"><span>Fresh draft: {usd(data.remainder.amount)}</span><span>New routing ceiling: {usd(data.remainder.max_fee)}</span><Status value={data.remainder.status}/></div>{profile && <Address value={profile.primary_address} network={profile.primary_network}/>}<p className="text-xs">Recipient snapshot version {data.remainder.recipient_version}. The new approval covers this exact remainder, fee ceiling and receiving profile.</p>{canApprove&&data.remainder.status==="draft"&&<Action disabled={!!busy} busy={busy==="approve-remainder"} onClick={()=>void run("approve-remainder",async()=>{await api(`${base}/partial-settlements/payments/${paymentId}/approve`,{reviewToken:data.reviewToken});notify("The exact remainder received fresh approval. Fund and authorize its route from Payments.");refresh();})}>Approve this exact remaining obligation</Action>}<button type="button" className="justify-self-start text-sm text-primary" onClick={()=>navigate("payments")}>Open payment funding and execution</button></div>}
    </>}
  </section>;
}
