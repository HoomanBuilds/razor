"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { AssetPicker } from "@/components/assets/asset-picker";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { api, RequestError } from "@/lib/api";
import { dateLabel, usd } from "@/lib/format";
import { destinationGuidance } from "@/lib/destination-guidance";
import { formatUnits } from "@/lib/money";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { paymentLabel } from "@/lib/payment-label";
import { usesEvmAddress } from "@/lib/recipient-destination";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Status } from "./shared";
import { FundingCreditReview } from "./funding-credit-review";
import { withTaskDrawerWallet } from "./task-drawer";
import type { Payment, Token, Treasury } from "./types";

const FundingWalletAction = dynamic(() => import("@/components/auth/funding-wallet").then(module => module.FundingWalletAction), { ssr: false });
interface Funding { originToken?: Token | null; id: string; origin_asset: string; origin_network: string; origin_symbol: string; origin_decimals: number; amount_in: string; expected_output: string; credited_amount: string; deposit_address: string; deposit_memo: string | null; quote: string; status: string; source_tx_hash: string | null; destination_tx_hash: string | null }
interface Attempt { id: string; state: string; route: string; quote: string; amount_in: string; expected_output: string; destination_network: string; destination_address: string; destination_memo?: string | null; destination_symbol: string; destination_decimals: number; source_tx_hash: string | null; destination_tx_hash: string | null }
interface Task { payment: Payment; treasury: Treasury; stage: string; message: string; paused: boolean; reviewToken: string; funding: Funding[]; attempts: Attempt[]; fundingCredit: string; cashCommitted: string; linkedCashHeld: string; clientCashHeld: string; required: string; shortfall: string; excess: string; canQuote: boolean; canReserve: boolean; depositAllowed: boolean }
interface Route { attempt: Attempt; network: string; stage: string; walletActions: NearWalletAction[]; approvalActions: NearWalletAction[]; approvalAccounts: string[]; signerAccounts: string[]; message: string; approvals: { required_approvals: number; payment_collected: number; attempt_collected: number; can_execute: boolean } | null }
function deadline(value: string) { try { const quote = JSON.parse(value); return quote.quote?.deadline ?? quote.quoteRequest?.deadline ?? null; } catch { return null; } }
const stageLabels: Record<string, string> = { needs_funding: "Funding needed", deposit: "Deposit ready", reconcile_funding: "Check incoming funds", reserve_funds: "Ready to reserve", ready_for_payout: "Ready to pay", needs_approval: "Approval needed", needs_treasury: "Connect treasury", terms_changed: "Payment terms changed", reconcile_payout: "Check original payout", payout_approvals: "Payout approval", cost_review: "Cost review needed", preparing_funding: "Preparing quote", refresh_treasury: "Update treasury balance", testnet_funding: "Mainnet funding unavailable" };

export function PaymentFundingTask({ paymentId, close }: { paymentId: string; close: () => void }) {
  return <PaymentFundingContent key={paymentId} paymentId={paymentId} close={close}/>;
}
function PaymentFundingContent({ paymentId, close }: { paymentId: string; close: () => void }) {
  const { base, revision, refresh, session, organization, navigate } = useWorkspace();
  const resource = useResource<Task>(`${base}/payment-funding/${paymentId}`, revision), task = resource.data;
  const { data: assets } = useResource<{ tokens: Token[]; routingCatalogAvailable?: boolean }>(`${base}/funding-assets`, revision);
  const { busy, error, run, setError } = useAction();
  const [source, setSource] = useState(""), [walletId, setWalletId] = useState(""), [refundAddress, setRefundAddress] = useState("");
  const [view, setView] = useState<"summary" | "quote" | "deposit" | "verify" | "track" | "close" | "route">("summary");
  const [fundingId, setFundingId] = useState(""), [route, setRoute] = useState<Route | null>(null), [acknowledged, setAcknowledged] = useState(false);
  const quoteKey = useRef<{ terms: string; key: string } | null>(null), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [base]);
  const selected = assets?.tokens.find(token => token.assetId === source);
  const wallets = session.wallets.filter(wallet => selected?.blockchain === "near" ? wallet.family === "near" && wallet.network === "mainnet" : selected?.blockchain === "sol" ? wallet.family === "solana" : selected?.blockchain && usesEvmAddress(selected.blockchain) && wallet.family === "evm" && wallet.address.startsWith("0x"));
  const wallet = wallets.find(value => value.id === walletId);
  const canPrepare = organization.permissions?.includes("payments:prepare") ?? false, canExecute = organization.permissions?.includes("payments:execute") ?? false, canApprove = organization.permissions?.includes("payments:approve") ?? false;
  const taskUrl = `${base}/payment-funding/${paymentId}`;
  const reconcile = async (id?: string, sourceTxHash?: string) => { try { await api(`${taskUrl}/reconcile`, { fundingId: id, sourceTxHash }); } finally { if (active.current) refresh(); } };
  function show(next: typeof view) { setError(""); setAcknowledged(false); setView(next); }
  const acceptRoute = (value: Route) => { if (active.current) { setRoute(value); setAcknowledged(false); setView("route"); } };
  const resumeRoute = async (attemptId: string) => acceptRoute(await api<Route>(`${base}/attempts/${attemptId}/resume`, {}));
  async function routeAction() {
    if (!route || !acknowledged) return;
    const fresh = await api<Route>(`${base}/attempts/${route.attempt.id}/${route.stage === "approve" ? "approve" : "resume"}`, {});
    if (!active.current) return;
    const reviewedActions = route.stage === "approve" ? route.approvalActions : route.walletActions;
    const actions = fresh.stage === "approve" ? fresh.approvalActions : fresh.walletActions;
    if (fresh.stage !== route.stage || JSON.stringify(actions) !== JSON.stringify(reviewedActions) || JSON.stringify(fresh.attempt) !== JSON.stringify(route.attempt)) { acceptRoute(fresh); throw new RequestError("Payout details changed. Review them again.", 409, "ROUTE_REVIEW_CHANGED"); }
    if (!actions.length || !["prepare", "approve", "execute"].includes(fresh.stage)) return;
    if (fresh.stage === "execute" && !fresh.approvals?.can_execute) throw new RequestError("Refresh the route's approvals before execution", 409, "APPROVAL_NOT_READY");
    const txHash = await withTaskDrawerWallet(() => signNearActions(actions, fresh.network, fresh.stage === "approve" ? fresh.approvalAccounts : fresh.signerAccounts));
    if (fresh.stage === "execute" && txHash) await api(`${base}/attempts/${fresh.attempt.id}/submitted`, { txHash });
    await reconcile();
    if (!active.current) return;
    if (fresh.stage === "execute") { setRoute(null); show("summary"); } else await resumeRoute(fresh.attempt.id);
  }
  if (resource.loading) return <Empty>Loading payment funding...</Empty>;
  if (!task) return <div className="grid gap-4"><p role="alert">{resource.error || "Payment unavailable."}</p><button type="button" onClick={close}>Back to payment</button></div>;
  const outstanding = task.attempts.find(attempt => attempt.state === "prepared"), leg = task.funding.find(value => value.id === fundingId), token = leg?.originToken ?? assets?.tokens.find(value => value.assetId === leg?.origin_asset);
  const locked = !!busy || resource.refreshing || !!resource.error;
  const quoteDeadline = leg ? deadline(leg.quote) : null;
  const canClose = !!leg && leg.status === "pending_deposit" && !leg.source_tx_hash && quoteDeadline && Date.parse(quoteDeadline) <= Date.now() && canPrepare;
  const name = task.payment.recipientName || paymentLabel(task.payment);
  const back = () => view === "summary" ? close() : show(["verify", "track", "close"].includes(view) ? "deposit" : "summary");
  return <section aria-busy={!!busy} className="grid gap-6">
    <div className="flex items-center justify-between gap-4"><button type="button" disabled={!!busy} onClick={back} className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ChevronLeft size={16}/>{view === "summary" ? "Payment" : ["verify", "track", "close"].includes(view) ? "Deposit" : "Funding"}</button><span className="text-xs text-muted-foreground">{paymentLabel(task.payment)}</span></div>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm text-muted-foreground">{name}</p><h3 className="mt-1 text-2xl font-medium tracking-tight">{view === "quote" ? "Choose funding" : view === "route" ? "Review payout" : view === "verify" ? "Verify credit" : view === "track" ? "Track transfer" : view === "close" ? "Close unsent quote" : leg && view === "deposit" ? "Payment deposit" : "Fund payment"}</h3></div><Status value={task.paused ? "paused" : task.stage}/></div>
    {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}
    {view === "summary" && <>
      <div className="rounded-2xl bg-muted/50 p-5 sm:p-6"><p className="text-sm text-muted-foreground">{BigInt(task.shortfall) > 0n ? "Still to fund" : "Payment amount"}</p><p className="mt-2 text-3xl font-medium tabular-nums">{usd(BigInt(task.shortfall) > 0n ? task.shortfall : task.payment.amount)} <span className="text-sm text-muted-foreground">USDC</span></p><p className="mt-3 text-sm">{stageLabels[task.stage] || task.stage.replaceAll("_", " ")}</p>{task.payment.scheduled_for && <p className="mt-2 text-xs text-muted-foreground">Scheduled {dateLabel(task.payment.scheduled_for)}</p>}</div>
      <div className="flex flex-wrap items-center gap-3">
        {task.canQuote && <Action disabled={locked} onClick={() => show("quote")}>Add funds</Action>}
        {task.stage === "needs_treasury" && <Action onClick={() => navigate("treasury")}>Connect treasury</Action>}
        {task.canReserve && <Action disabled={locked} busy={busy === "reserve"} onClick={() => void run("reserve", async () => { await api(`${taskUrl}/reserve`, {}); refresh(); })}>Reserve {usd(task.required)}</Action>}
        {canExecute && task.stage === "ready_for_payout" && <><Action disabled={locked || task.paused} busy={busy === "route"} onClick={() => void run("route", async () => { acceptRoute(await api<Route>(`${base}/payments/${paymentId}/quote`, {})); refresh(); })}>Review payout</Action><button type="button" className="text-sm text-primary" disabled={locked || task.paused} onClick={() => void run("backup", async () => { acceptRoute(await api<Route>(`${base}/payments/${paymentId}/quote`, { useBackup: true })); refresh(); })}>Use USDC backup</button></>}
        {outstanding && (canApprove || canExecute) && <Action disabled={locked} busy={busy === "resume"} onClick={() => void run("resume", () => resumeRoute(outstanding.id))}>Continue payout approval</Action>}
        {task.stage === "reconcile_payout" && <Action disabled={locked} onClick={close}>Review original payout</Action>}
        {canPrepare && <button type="button" className="inline-flex items-center gap-2 text-sm text-muted-foreground" disabled={locked} onClick={() => void run("reconcile", () => reconcile())}><RefreshCw size={14}/>{busy === "reconcile" ? "Checking..." : "Check status"}</button>}
      </div>
      {!!task.funding.length && <div className="divide-y rounded-2xl border px-4">{task.funding.map((item, index) => <button key={item.id} type="button" disabled={locked} onClick={() => { setFundingId(item.id); show("deposit"); }} className="flex w-full items-center justify-between gap-4 py-4 text-left"><div className="min-w-0"><p className="text-sm font-medium">Deposit {index + 1}</p><div className="mt-2"><AssetIdentity symbol={item.originToken?.symbol || item.origin_symbol} network={item.originToken?.blockchain || item.origin_network} assetId={item.origin_asset}/></div></div><div className="ml-auto grid justify-items-end gap-2"><span className="text-sm tabular-nums">{usd(item.status === "confirmed" ? item.credited_amount : item.expected_output)}</span><Status value={item.status}/></div><ChevronRight size={16} className="shrink-0 text-muted-foreground"/></button>)}</div>}
      <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Funding breakdown</summary><dl className="mt-4 grid gap-3">{[["Payment", task.payment.amount], ["Cost ceiling", task.payment.max_fee], ["Spent", task.payment.total_spent ?? "0"], ["Reserved", task.payment.reserved_amount ?? "0"], ["Available company cash", task.treasury.available], ["Confirmed incoming", task.fundingCredit], ["Committed cash", task.cashCommitted], ["Linked cash", task.linkedCashHeld], ["Client reserve", task.clientCashHeld], ["Source excess", task.excess]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{usd(value)}</dd></div>)}</dl>{canPrepare && task.treasury.config && <button type="button" className="mt-4 text-primary" disabled={locked} onClick={() => void run("refresh-balance", async () => { const result = await api<{ network: string; walletActions: NearWalletAction[] }>(`${taskUrl}/balance-refresh`, {}); await withTaskDrawerWallet(() => signNearActions(result.walletActions, result.network)); await reconcile(); })}>Refresh NEAR balance</button>}</details>
    </>}
    {view === "quote" && <form className="grid gap-5" onSubmit={event => { event.preventDefault(); void run("quote", async () => { if (!task.canQuote || !selected) throw new RequestError("Refresh funding before preparing a quote.", 409, "FUNDING_REVIEW_CHANGED"); const recovery = wallet?.address ?? refundAddress; const terms = JSON.stringify({ paymentId, source, walletId, recovery, review: task.reviewToken }); if (quoteKey.current?.terms !== terms) quoteKey.current = { terms, key: crypto.randomUUID() }; const result = await api<{funding: Funding}>(`${taskUrl}/quote`, { originAsset: source, refundAddress: recovery, walletId: wallet?.id, reviewToken: task.reviewToken, idempotencyKey: quoteKey.current.key }); if (active.current) { setFundingId(result.funding.id); show("deposit"); refresh(); } }); }}>
      <div className="flex items-center justify-between rounded-2xl bg-muted/50 p-4"><span className="text-sm text-muted-foreground">Funding needed</span><strong className="font-medium tabular-nums">{usd(task.shortfall)} USDC</strong></div>
      <Field as="div" label="Pay with"><AssetPicker compact label="Funding asset" tokens={assets?.tokens ?? []} value={source} onValueChange={value => { setSource(value); setWalletId(""); setRefundAddress(""); }} disabled={locked} required/></Field>
      <Field label="Source wallet"><select required className={control} disabled={locked} value={walletId} onChange={event => { setWalletId(event.target.value); setRefundAddress(""); }}><option value="">Choose wallet</option>{wallets.map(value => <option key={value.id} value={value.id}>{value.label || value.family}: {value.address}</option>)}<option value="manual">Other wallet or exchange</option></select></Field>
      {walletId === "manual" && <Field label="Refund address" hint={selected ? destinationGuidance(selected.blockchain) : undefined}><input required className={control} disabled={locked} value={refundAddress} onChange={event => setRefundAddress(event.target.value.trim())}/></Field>}
      {assets?.routingCatalogAvailable === false && <p role="status" className="text-sm text-muted-foreground">Only direct USDC on NEAR is available.</p>}
      <div className="flex justify-end border-t pt-5"><Action disabled={locked || !task.canQuote || !selected || (!wallet && !(walletId === "manual" && refundAddress))} busy={busy === "quote"}>Get quote</Action></div>
    </form>}
    {["deposit", "verify", "track", "close"].includes(view) && (leg ? <>
      <div className="grid gap-3 rounded-2xl bg-muted/50 p-5"><AssetIdentity symbol={token?.symbol || leg.origin_symbol} network={token?.blockchain || leg.origin_network} assetId={leg.origin_asset}/><div className="flex flex-wrap items-center justify-between gap-3"><strong className="text-2xl font-medium tabular-nums">{formatUnits(leg.amount_in, token?.decimals ?? leg.origin_decimals)} {token?.symbol || leg.origin_symbol}</strong><Status value={leg.status}/></div><p className="text-sm text-muted-foreground">{usd(leg.expected_output)} USDC expected</p></div>
      {view === "deposit" && <>
        {leg.status === "pending_deposit" && <><Field as="div" label="Deposit address"><Address value={leg.deposit_address} network={leg.origin_network} full/></Field>{leg.deposit_memo && <Field as="div" label="Required memo"><Address value={leg.deposit_memo} label="deposit memo" full/></Field>}{quoteDeadline && <p className="text-xs text-muted-foreground">Expires {new Date(quoteDeadline).toLocaleString()} · Source gas is separate</p>}</>}
        {token && ["pending_deposit", "source_unknown", "unknown", "processing", "recovery_pending"].includes(leg.status) && <FundingWalletAction key={leg.id} compact upgradePolicy={task.treasury.upgradePolicy} funding={leg} token={token} depositAllowed={task.depositAllowed && leg.status === "pending_deposit" && !locked} beforeSend={async () => { await api(`${taskUrl}/deposit-claim`, { fundingId: leg.id }); }} onBroadcast={async sourceTxHash => { await api(`${taskUrl}/reconcile`, { fundingId: leg.id, sourceTxHash }); }} onSubmitted={async sourceTxHash => { await reconcile(leg.id, sourceTxHash); }}/>}
        <div className="flex flex-wrap items-center gap-4">{canPrepare && <Action disabled={locked} busy={busy === leg.id} onClick={() => void run(leg.id, () => reconcile(leg.id))}>Check deposit</Action>}{["reported_delivered", "confirmed"].includes(leg.status) && <button type="button" className="text-sm text-primary" onClick={() => show("verify")}>Verify credit</button>}{canPrepare && !leg.source_tx_hash && !token && ["pending_deposit", "source_unknown", "unknown", "processing", "recovery_pending"].includes(leg.status) && <button type="button" className="text-sm text-primary" onClick={() => show("track")}>Track sent transfer</button>}{canClose && <button type="button" className="text-sm text-muted-foreground" disabled={locked} onClick={() => show("close")}>Close unsent quote</button>}</div>
        {/refund|unknown|failed/.test(leg.status) && <p role="status" className="text-sm text-amber-700">{leg.status.includes("refund") ? "Source refund needs review." : "Outcome unresolved. Another deposit is blocked."}</p>}
        <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Transfer details</summary><div className="mt-4 grid gap-4"><Field as="div" label="Funding ID"><Address value={leg.id} label="funding ID"/></Field>{leg.source_tx_hash && <Field as="div" label="Source transaction"><Address value={leg.source_tx_hash} label="transaction hash"/></Field>}{leg.destination_tx_hash && <Field as="div" label="NEAR transaction"><Address value={leg.destination_tx_hash} label="transaction hash"/><a className="mt-1 inline-block text-primary" href={`https://nearblocks.io/txns/${encodeURIComponent(leg.destination_tx_hash)}`} target="_blank" rel="noreferrer">View transaction</a></Field>}</div></details>
      </>}
      {view === "verify" && <FundingCreditReview key={leg.id} fundingId={leg.id} reference={paymentLabel(task.payment)} status={leg.status} sourceContext="obligation" onUpdated={() => refresh()}/>}
      {view === "track" && <form key={leg.id} className="grid gap-5" onSubmit={event => { event.preventDefault(); const hash = String(new FormData(event.currentTarget).get("sourceHash")); void run(`source:${leg.id}`, async () => { await reconcile(leg.id, hash); if (active.current) show("deposit"); }); }}><Field label="Source transaction hash"><input name="sourceHash" required className={control} maxLength={200}/></Field><div className="flex justify-end"><Action busy={busy === `source:${leg.id}`} disabled={locked}>Track transfer</Action></div></form>}
      {view === "close" && <form key={`${leg.id}:${leg.quote}`} className="grid gap-5" onSubmit={event => { event.preventDefault(); if (!canClose) return; void run(`close:${leg.id}`, async () => { await api(`${taskUrl}/close-unsent`, { fundingId: leg.id, noTransferConfirmed: true }); if (active.current) { show("summary"); refresh(); } }); }}><label className="flex items-start gap-3 text-sm"><input type="checkbox" required className="mt-1"/>I checked my wallet and never sent this transfer.</label><div className="flex justify-end"><Action disabled={locked || !canClose} busy={busy === `close:${leg.id}`}>Close quote</Action></div></form>}
    </> : <Empty>Refreshing deposit...</Empty>)}
    {view === "route" && route && <>
      <div className="grid gap-4 rounded-2xl bg-muted/50 p-5"><AssetIdentity symbol={route.attempt.destination_symbol || "Receiving asset"} network={route.attempt.destination_network}/><p className="text-2xl font-medium tabular-nums">{formatUnits(route.attempt.expected_output, route.attempt.destination_decimals ?? 6)} {route.attempt.destination_symbol}</p><Address value={route.attempt.destination_address} network={route.attempt.destination_network}/>{route.attempt.destination_memo && <Field as="div" label="Memo"><Address value={route.attempt.destination_memo} full/></Field>}</div>
      <dl className="grid gap-3 text-sm">{[["Source USDC", usd(route.attempt.amount_in)], ["Cost ceiling", usd(task.payment.max_fee)], ["Payment approvals", route.approvals ? `${route.approvals.payment_collected}/${route.approvals.required_approvals}` : "Pending"], ["Route approvals", route.approvals ? `${route.approvals.attempt_collected}/${route.approvals.required_approvals}` : "Pending"]].map(([label, value]) => <div className="flex justify-between gap-4" key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}{deadline(route.attempt.quote) && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Expires</dt><dd>{new Date(deadline(route.attempt.quote)).toLocaleString()}</dd></div>}</dl>
      <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Wallet details</summary><div className="mt-4 grid gap-3"><p>NEAR {route.network}</p><p className="break-all">{(route.stage === "approve" ? route.approvalAccounts : route.signerAccounts).join(", ") || "No eligible wallet"}</p><pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(route.stage === "approve" ? route.approvalActions : route.walletActions, null, 2)}</pre></div></details>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={locked} className="mt-1"/>I reviewed this payout's asset, address and exact amounts.</label>
      <div className="flex flex-wrap items-center justify-end gap-4"><button type="button" className="text-sm text-muted-foreground" disabled={locked} onClick={() => void run("route-status", () => resumeRoute(route.attempt.id))}>Refresh approvals</button>{((route.stage === "approve" && canApprove && route.approvalActions.length > 0) || (["prepare", "execute"].includes(route.stage) && canExecute)) && <Action disabled={locked || !acknowledged || task.paused} busy={busy === "payout"} onClick={() => void run("payout", routeAction)}>{route.stage === "prepare" ? "Prepare route" : route.stage === "approve" ? "Approve in wallet" : "Send payment"}</Action>}</div>
    </>}
  </section>;
}
