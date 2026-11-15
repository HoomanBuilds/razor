"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { paymentLabel } from "@/lib/payment-label";
import { focusWorkspaceForm } from "./page-metrics";
import { withTaskDrawerWallet } from "./task-drawer";
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

export function PartialSettlementPanel({ paymentId, focused = false }: { paymentId: string; focused?: boolean }) {
  return <PartialSettlementContent key={paymentId} paymentId={paymentId} focused={focused}/>;
}
function PartialSettlementContent({ paymentId, focused }: { paymentId: string; focused: boolean }) {
  const { base, revision, refresh, notify, navigate, organization } = useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const resource = useResource<Review>(canRead ? `${base}/partial-settlements/payments/${paymentId}` : null, revision), { busy, error, run } = useAction();
  const [wallet, setWallet] = useState<PartialWalletReview | null>(null), [task, setTask] = useState<"summary" | "attest" | "remainder" | "approve">("summary"), [acknowledged, setAcknowledged] = useState(false);
  const active = useRef(true), walletTerms = useRef("");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [base]);
  useEffect(() => { setWallet(null); setAcknowledged(false); }, [resource.data?.attempt?.id, resource.data?.reviewToken]);
  const data = resource.data, canPrepare = organization.permissions?.includes("payments:prepare"), canApprove = organization.permissions?.includes("payments:approve");
  function terms(value: Review) { return JSON.stringify({ attempt: value.attempt, payment: value.payment, settlement: value.settlement, reviewToken: value.reviewToken }); }
  async function preparePartial(values: FormData) {
    if (!data?.attempt) return;
    const prepared = await api<PartialWalletReview>(`${base}/partial-settlements/attempts/${data.attempt.id}/prepare`, { creditedUSDC: amount(values.get("credit")), receipt: values.get("receipt"), valuationNote: values.get("valuation"), routeClosed: values.has("closed"), reviewConfirmed: values.has("reviewed") });
    if (!active.current) return;
    if (!prepared.walletActions.length) { setWallet(null); refresh(); notify("Partial delivery is already reconciled."); return; }
    const current = await api<Review>(`${base}/partial-settlements/payments/${paymentId}`);
    if (!active.current || current.attempt?.id !== data.attempt.id) return;
    walletTerms.current = terms(current); setWallet(prepared); setAcknowledged(false);
  }
  async function signPartial() {
    if (!wallet) return;
    const current = await api<Review>(`${base}/partial-settlements/payments/${paymentId}`);
    if (!active.current) return;
    if (terms(current) !== walletTerms.current) { setWallet(null); setAcknowledged(false); throw new RequestError("Delivery details changed. Review the current partial payment.", 409, "PARTIAL_REVIEW_STALE"); }
    try { await withTaskDrawerWallet(() => signNearActions(wallet.walletActions, wallet.network)); await api(`${base}/payments/${paymentId}/reconcile`, {}); notify("Partial attestation submitted. Confirming the final NEAR state."); refresh(); setTask("summary"); } finally { setWallet(null); setAcknowledged(false); }
  }
  async function createRemainder(values: FormData) {
    if (!data) return;
    await api(`${base}/partial-settlements/payments/${paymentId}/remainder`, { reviewToken: data.reviewToken, maxFee: amount(values.get("fee"), true) });
    if (active.current) { setTask("summary"); refresh(); notify("Remaining payment drafted for fresh approval."); }
  }
  async function approveRemainder() {
    if (!data) return;
    await api(`${base}/partial-settlements/payments/${paymentId}/approve`, { reviewToken: data.reviewToken });
    if (active.current) { setTask("summary"); setAcknowledged(false); refresh(); notify("Remaining payment approved. Review its route in Payments."); }
  }
  if (!canRead || !data || !data.settlement && data.attempt?.state !== "reported_partial") return null;
  const attempt = data.attempt;
  const output = (value: string) => attempt?.destination_decimals != null ? `${formatUnits(value, attempt.destination_decimals)} ${attempt.destination_symbol || attempt.destination_asset}` : `${value} destination base units`;
  const profile = data.remainder ? JSON.parse(data.remainder.recipient_snapshot) as {primary_address:string;primary_network:string} : null;
  if (focused) {
    const locked = !!busy || resource.refreshing || !!resource.error;
    const title = wallet ? "Review partial delivery" : task === "attest" ? "Record partial delivery" : task === "remainder" ? "Draft remaining payment" : task === "approve" ? "Approve remaining payment" : "Partial delivery";
    return <section aria-busy={!!busy} className="grid gap-5">
      {task !== "summary" && <button type="button" className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground" disabled={!!busy} onClick={() => { if (wallet) setWallet(null); else setTask("summary"); setAcknowledged(false); }}><ChevronLeft size={16}/>{wallet ? "Edit details" : "Partial delivery"}</button>}
      <h3 className="text-xl font-medium">{title}</h3>
      {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}
      {task === "summary" && !wallet && <>
        <div className="rounded-2xl bg-muted/50 p-5"><p className="text-sm text-muted-foreground">{data.settlement ? "Unpaid remainder" : "Observed delivery"}</p><p className="mt-2 text-3xl font-medium tabular-nums">{data.settlement ? usd(data.remaining!) : attempt?.observed_output ? output(attempt.observed_output) : "Awaiting receipt"}</p>{data.settlement ? <dl className="mt-5 grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Original payment</dt><dd>{usd(data.payment.amount)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Credited entitlement</dt><dd>{usd(data.settlement.credited_usdc)}</dd></div></dl> : <p className="mt-3 text-sm text-muted-foreground">Quoted {attempt ? output(attempt.expected_output) : "Unknown"}</p>}</div>
        <div className="flex flex-wrap items-center gap-3">
          {!data.settlement && canApprove && <Action disabled={locked} onClick={() => setTask("attest")}>Review delivery</Action>}
          {data.settlement && !data.remainder && canPrepare && <Action disabled={locked || !data.currentRecipientConfirmed} onClick={() => setTask("remainder")}>Draft remainder</Action>}
          {data.remainder && canApprove && data.remainder.status === "draft" && <Action disabled={locked} onClick={() => { setAcknowledged(false); setTask("approve"); }}>Review remaining payment</Action>}
          {data.remainder && <button type="button" className="text-sm text-primary" onClick={() => { navigate("payments", data.remainder!.id); focusWorkspaceForm("payment-queue"); }}>Open remaining payment</button>}
        </div>
        {data.remainder && <div className="flex justify-between gap-3 text-sm"><span>{paymentLabel(data.remainder)}</span><Status value={data.remainder.status}/></div>}
        {!data.currentRecipientConfirmed && data.settlement && !data.remainder && <p role="status" className="text-sm text-muted-foreground">Confirm the recipient's receiving details first.</p>}
        {data.settlement && <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Settlement details</summary><dl className="mt-4 grid gap-3"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Actual source spent</dt><dd>{usd(data.settlement.source_spent_usdc)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Current recipient version</dt><dd>{data.currentRecipientVersion}</dd></div></dl></details>}
      </>}
      {task === "attest" && !wallet && !data.settlement && <form key={`${data.attempt?.id}:${data.reviewToken}`} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("prepare-partial", () => preparePartial(values)); }}>
        <div className="flex flex-wrap justify-between gap-3 rounded-2xl bg-muted/50 p-4 text-sm"><span className="text-muted-foreground">Observed output</span><strong className="font-medium">{attempt?.observed_output ? output(attempt.observed_output) : "Unconfirmed"}</strong></div>
        <Field label="Entitlement credited (USDC)"><input name="credit" required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" className={control}/></Field>
        <Field label="Delivery and route closure evidence"><textarea name="receipt" required minLength={3} maxLength={1000} rows={3} className={control}/></Field>
        <Field label="Basis for the USDC valuation"><textarea name="valuation" required minLength={3} maxLength={400} rows={2} className={control}/></Field>
        <label className="flex items-start gap-3 text-sm"><input name="closed" type="checkbox" required className="mt-1"/>I verified this route cannot deliver further funds.</label>
        <label className="flex items-start gap-3 text-sm"><input name="reviewed" type="checkbox" required className="mt-1"/>I attest the actual asset received and its agreed USDC credit.</label>
        <div className="flex justify-end border-t pt-5"><Action disabled={locked} busy={busy === "prepare-partial"}>Review attestation</Action></div>
      </form>}
      {wallet && <div className="grid gap-5"><div className="rounded-2xl bg-muted/50 p-5"><p className="text-xs text-muted-foreground">Reporter attestation</p><p className="mt-2 text-2xl font-medium">{output(wallet.actualOutput)}</p></div><dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">USDC credit</dt><dd>{usd(wallet.creditedUSDC)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Still unpaid</dt><dd>{usd(wallet.remainingUSDC)}</dd></div></dl><details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Exact NEAR attestation</summary><pre className="mt-4 max-h-64 overflow-auto text-xs">{JSON.stringify(wallet.walletActions, null, 2)}</pre></details><label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={event => setAcknowledged(event.target.checked)} className="mt-1"/>I confirm this credit. The unpaid remainder needs a new approval.</label><div className="flex justify-end border-t pt-5"><Action disabled={locked || !acknowledged} busy={busy === "sign-partial"} onClick={() => void run("sign-partial", signPartial)}>Confirm in wallet</Action></div></div>}
      {task === "remainder" && data.settlement && !data.remainder && <form key={data.reviewToken} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("remainder", () => createRemainder(values)); }}><div className="rounded-2xl bg-muted/50 p-5"><p className="text-sm text-muted-foreground">Unpaid principal</p><p className="mt-2 text-3xl font-medium">{usd(data.remaining!)} USDC</p></div><Field label="New cost ceiling (USDC)"><input name="fee" required className={control} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" defaultValue="1"/></Field><div className="flex justify-end border-t pt-5"><Action disabled={locked || !data.currentRecipientConfirmed} busy={busy === "remainder"}>Create draft</Action></div></form>}
      {task === "approve" && data.remainder && <div key={data.reviewToken} className="grid gap-5"><div className="rounded-2xl bg-muted/50 p-5"><p className="text-sm text-muted-foreground">{paymentLabel(data.remainder)}</p><p className="mt-2 text-3xl font-medium tabular-nums">{usd(data.remainder.amount)} USDC</p><p className="mt-3 text-sm text-muted-foreground">Cost ceiling {usd(data.remainder.max_fee)}</p></div>{profile && <div className="grid gap-3"><AssetIdentity symbol="Receiving asset" network={profile.primary_network}/><Address value={profile.primary_address} network={profile.primary_network}/><p className="text-xs text-muted-foreground">Receiving profile v{data.remainder.recipient_version}</p></div>}<label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={event => setAcknowledged(event.target.checked)} className="mt-1"/>Approve this remainder, cost ceiling and receiving profile.</label><div className="flex justify-end border-t pt-5"><Action disabled={locked || !acknowledged || !canApprove || data.remainder.status !== "draft"} busy={busy === "approve-remainder"} onClick={() => void run("approve-remainder", approveRemainder)}>Approve remainder</Action></div></div>}
    </section>;
  }
  return <section className="mt-4 grid gap-4 rounded-lg border p-4"><div><h3 className="text-sm font-semibold">Partial delivery and remaining entitlement</h3><p className="mt-2 text-xs text-muted-foreground">The original payment cannot retry in full. Destination tokens and credited USDC entitlement are different amounts unless the destination is verified native USDC.</p></div>
    {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}
    {attempt?.observed_output && <p className="text-sm">Observed destination output: {output(attempt.observed_output)}. Original quoted output: {output(attempt.expected_output)}.</p>}
    {!data.settlement && canApprove && <form className="grid gap-3" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run("prepare-partial",async()=>{await preparePartial(values);});}}>
      <Field label="Agreed USDC entitlement credited"><input name="credit" required inputMode="decimal" className={control} placeholder="Amount of the original entitlement satisfied"/></Field>
      <Field label="Delivery and terminal route closure evidence"><textarea name="receipt" required minLength={3} maxLength={1000} className={control} placeholder="Verified destination transaction and evidence no further funds can arrive"/></Field>
      <Field label="Basis for the agreed USDC credit"><textarea name="valuation" required minLength={3} maxLength={400} className={control} placeholder="Record the agreed value of the actual received asset. Native USDC credits must equal the USDC received."/></Field>
      <label className="flex items-start gap-2 text-xs"><input name="closed" type="checkbox" required/><span>I verified this route is terminal and cannot deliver further funds.</span></label>
      <label className="flex items-start gap-2 text-xs"><input name="reviewed" type="checkbox" required/><span>I reviewed the actual received asset and agreed USDC credit. The NEAR treasury trusts the owner or appointed reporter attestation.</span></label>
      <div><Action disabled={!!busy} busy={busy==="prepare-partial"}>Review terminal partial attestation</Action></div>
    </form>}
    {wallet && canApprove && <div className="grid gap-3 rounded-lg bg-muted p-4"><p className="text-sm">Attest {output(wallet.actualOutput)}, credit {usd(wallet.creditedUSDC)} of entitlement, and leave {usd(wallet.remainingUSDC)} unpaid.</p><p className="text-xs">All source spending stays recorded. This action authorizes no remainder payout.</p><details className="text-xs"><summary className="cursor-pointer">Review exact NEAR attestation</summary><pre className="mt-2 max-h-64 overflow-auto">{JSON.stringify(wallet.walletActions,null,2)}</pre></details><div className="flex gap-3"><Action disabled={!!busy} busy={busy==="sign-partial"} onClick={()=>void run("sign-partial",async()=>{await signPartial();})}>Confirm in reporter's NEAR wallet</Action><Action disabled={!!busy} onClick={()=>setWallet(null)}>Close review</Action></div></div>}
    {data.settlement && <><div className="grid gap-3 text-sm sm:grid-cols-3"><p>Original entitlement<br/><strong>{usd(data.payment.amount)}</strong></p><p>Credited entitlement<br/><strong>{usd(data.settlement.credited_usdc)}</strong></p><p>Unpaid remainder<br/><strong>{usd(data.remaining!)}</strong></p></div><p className="text-xs">Actual source spent: {usd(data.settlement.source_spent_usdc)}. The remaining amount requires a fresh draft, current recipient preferences and new approval.</p>
      {!data.remainder && canPrepare && <form className="grid gap-3 sm:grid-cols-2" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run("remainder",async()=>{await createRemainder(values);});}}><Field label="New maximum routing cost (USDC)"><input name="fee" required className={control} inputMode="decimal" defaultValue="1"/></Field><p className="self-center text-xs">Current recipient profile version {data.currentRecipientVersion}; {data.currentRecipientConfirmed?"confirmed":"confirmation required"}.</p><div><Action disabled={!!busy||!data.currentRecipientConfirmed} busy={busy==="remainder"}>Create only the unpaid remainder</Action></div></form>}
      {data.remainder && <div className="grid gap-3"><div className="flex flex-wrap gap-3 text-sm"><span>Fresh draft: {usd(data.remainder.amount)}</span><span>New routing ceiling: {usd(data.remainder.max_fee)}</span><Status value={data.remainder.status}/></div>{profile && <Address value={profile.primary_address} network={profile.primary_network}/>}<p className="text-xs">Recipient snapshot version {data.remainder.recipient_version}. The new approval covers this exact remainder, fee ceiling and receiving profile.</p>{canApprove&&data.remainder.status==="draft"&&<Action disabled={!!busy} busy={busy==="approve-remainder"} onClick={()=>void run("approve-remainder",async()=>{await approveRemainder();})}>Approve this exact remaining obligation</Action>}<button type="button" className="justify-self-start text-sm text-primary" onClick={()=>navigate("payments")}>Open payment funding and execution</button></div>}
    </>}
  </section>;
}
