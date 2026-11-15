"use client";

import { proportion } from "@/lib/payment-activity";
import { CapsuleMeter } from "./dashboard-visuals";

import { ContractUpgradeDisclosure } from "@/components/contract-upgrade-disclosure";
import type { ContractUpgradePolicy } from "@/lib/contract-upgrade-policy";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { focusWorkspaceForm } from "./page-metrics";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./task-drawer";
import dynamic from "next/dynamic";
import { WORKSPACE_NAVIGATION_EVENT } from "@/lib/workspace-access";
import { api, RequestError } from "@/lib/api";
import { usd } from "@/lib/format";
import { networkIdentity } from "@/lib/asset-identity";
import { isDirectFunding } from "@/lib/direct-funding";
import { destinationGuidance } from "@/lib/destination-guidance";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Status } from "./shared";
import type { Token, Treasury as TreasuryData } from "./types";
import { FundingPagination, type FundingPageInfo } from "./funding-pagination";
import { FundingCreditReview } from "./funding-credit-review";
import { TreasuryCreation } from "./treasury-creation";
import { TreasuryStorage } from "./treasury-storage";
import { AssetPicker } from "@/components/assets/asset-picker";
import { TokenLogo, AssetIdentity } from "@/components/assets/asset-identity";
import { nativeUsdcSuggestions } from "@/lib/native-usdc";

const FundingWalletAction = dynamic(() => import("@/components/auth/funding-wallet").then((module) => module.FundingWalletAction), { ssr: false });

interface Funding { id: string; reference: string; origin_asset: string; amount_in: string; expected_output: string; deposit_address: string; deposit_memo: string | null; quote: string; status: string; source_tx_hash: string | null; credited_amount: string; payment_id: string | null; source_context?: "company" | "obligation" | "funding_request" | "unknown" }
function fundingLabel(funding: Funding) {
  return ["funding_request", "obligation"].includes(funding.source_context ?? "") && /^request:[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(funding.reference) ? funding.payment_id ? "Payment funding" : "Funding request" : funding.reference;
}

function units(value: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new RequestError("Enter a valid source amount.", 400, "INVALID_AMOUNT");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new RequestError(`This asset supports up to ${decimals} decimal places.`, 400, "INVALID_AMOUNT");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")).toString();
}
function tokenAmount(value: string, decimals: number): string {
  const amount = BigInt(value);
  const whole = amount / 10n ** BigInt(decimals);
  const fraction = (amount % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export function Treasury() {
  const { base, revision, refresh, session, organization } = useWorkspace();
  const canRead = organization.permissions?.includes("company:read") ?? false;
  const canPrepare = organization.permissions?.includes("payments:prepare") ?? false;
  const canManage = organization.permissions?.includes("company:manage") ?? false;
  const { data: treasury, error: loadError } = useResource<TreasuryData>(`${base}/treasury`, revision);
  const { data: assets } = useResource<{ tokens: Token[]; routingCatalogAvailable?: boolean }>(`${base}/funding-assets`, revision);
  const [fundingPage, setFundingPage] = useState(1), [fundingScope, setFundingScope] = useState("all");
  const { data: funding, error: fundingError, loading: fundingLoading, refreshing: fundingRefreshing } = useResource<{ funding: Funding[] } & FundingPageInfo>(canRead ? `${base}/funding?page=${fundingPage}&pageSize=25&scope=${fundingScope}` : null, revision);
  const { busy, error, run, setError } = useAction();
  const [source, setSource] = useState("");
  const [deposit, setDeposit] = useState<Funding | null>(null);
  const incomingRequest = useRef(0), linkedDepositId = useRef("");
  const clearFundingLink = () => { const location = new URL(window.location.href); if (location.searchParams.has("funding")) { location.searchParams.delete("funding"); window.history.replaceState(null, "", location); } };
  useEffect(() => {
    let active = true;
    const read = () => {
      const location = new URL(window.location.href), id = location.searchParams.get("funding"), request = ++incomingRequest.current;
      if (!id || location.searchParams.get("company") !== organization.id || location.searchParams.get("section") !== "treasury") return;
      setError("");
      void api<{ funding: Funding }>(`${base}/reconciliation/funding/${encodeURIComponent(id)}`).then(result => {
        const current = new URL(window.location.href);
        if (!active || request !== incomingRequest.current || current.searchParams.get("company") !== organization.id || current.searchParams.get("section") !== "treasury" || current.searchParams.get("funding") !== id) return;
        linkedDepositId.current = id;
        setDeposit({ ...result.funding, source_context: result.funding.source_context ?? "unknown" });
        requestAnimationFrame(() => { const location = new URL(window.location.href); if (!active || request !== incomingRequest.current || location.searchParams.get("company") !== organization.id || location.searchParams.get("section") !== "treasury" || location.searchParams.get("funding") !== id) return; focusWorkspaceForm("treasury-funding-history"); openTaskDrawer("treasury-deposit-flow"); });
      }).catch(cause => { const current = new URL(window.location.href); if (active && request === incomingRequest.current && current.searchParams.get("company") === organization.id && current.searchParams.get("section") === "treasury" && current.searchParams.get("funding") === id) setError(cause instanceof Error ? cause.message : "Funding could not be loaded."); });
    };
    read(); window.addEventListener(WORKSPACE_NAVIGATION_EVENT, read); window.addEventListener("popstate", read);
    return () => { active = false; incomingRequest.current++; window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, read); window.removeEventListener("popstate", read); };
  }, [base, organization.id, setError]);
  useEffect(() => {
    const dialog = document.getElementById("treasury-deposit-flow");
    const close = () => { if (dialog?.dataset.walletSuspended !== "true" && new URLSearchParams(window.location.search).get("funding") === deposit?.id) clearFundingLink(); };
    dialog?.addEventListener("close", close); return () => dialog?.removeEventListener("close", close);
  }, [deposit?.id]);
  useEffect(() => { if (deposit && linkedDepositId.current !== deposit.id) { closeTaskDrawer("treasury-funding-flow", true); openTaskDrawer("treasury-deposit-flow"); } }, [deposit?.id]);
  const tokens = assets?.tokens ?? [], selected = tokens.find(token => token.assetId === source);
  const open = (id: string) => { setError(""); openTaskDrawer(id); };
  const updateDeposit = (value: Funding) => setDeposit(current => current?.id === value.id ? { ...value, source_context: value.source_context ?? current.source_context } : current);
  return <div className="grid min-w-0 gap-6">
    {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-end gap-3">{treasury?.config && <button type="button" aria-label="Sync balance" className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground disabled:opacity-50" disabled={!!busy} onClick={() => void run("sync", async () => { await api(`${base}/treasury/sync`, {}); refresh(); })}><RefreshCw size={16} className={busy === "sync" ? "animate-spin" : ""}/></button>}<button type="button" className="min-h-10 px-2 text-sm text-primary" onClick={() => open("treasury-manage-flow")}>{canManage ? "Manage" : "Details"}</button>{!treasury?.config && canManage ? <Action type="button" onClick={() => open("treasury-activation-flow")}>Activate treasury</Action> : canPrepare && <Action type="button" onClick={() => { setError(""); focusWorkspaceForm("treasury-funding"); }}><Plus size={15}/>Add funds</Action>}</div>
    <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="dashboard-finance-card p-6 sm:p-7"><div className="flex items-center justify-between gap-4"><p className="text-sm text-white/85">Available to spend</p><TokenLogo symbol="USDC" network="near" size={30}/></div><p className="mt-6 break-words text-[44px] font-normal leading-tight tracking-[-.05em] tabular-nums">{treasury ? usd(treasury.available) : loadError ? "Unavailable" : "..."}</p><div className="mt-6"><CapsuleMeter value={treasury ? proportion(treasury.available, treasury.balance) : 0} label={treasury ? `${usd(treasury.available)} available of ${usd(treasury.balance)} confirmed` : "Treasury balance loading"}/></div></div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-1"><div className="rounded-2xl bg-muted p-5"><p className="text-xs text-muted-foreground">Confirmed balance</p><p className="mt-3 break-words text-xl font-normal tracking-tight tabular-nums sm:text-3xl">{treasury ? usd(treasury.balance) : loadError ? "Unavailable" : "..."}</p></div><button type="button" className="rounded-2xl bg-muted p-5 text-left transition-colors hover:bg-secondary" onClick={() => open("treasury-reservations")}><p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">Reserved <ChevronRight size={14}/></p><p className="mt-3 break-words text-xl font-normal tracking-tight tabular-nums sm:text-3xl">{treasury ? usd(treasury.totalReserved ?? treasury.reserved) : loadError ? "Unavailable" : "..."}</p></button></div>
    </section>
    {canRead && <section id="treasury-funding-history" className="scroll-mt-8 rounded-3xl border bg-white p-5 sm:p-7"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">Funding history</h2><select aria-label="Funding history scope" className={`${control} !w-auto`} value={fundingScope} onChange={event => { setFundingScope(event.target.value); setFundingPage(1); }}><option value="all">All funding</option><option value="unresolved">Unresolved</option></select></div>{fundingError && <p role="alert" className="mb-3 text-sm text-destructive">{fundingError}</p>}{fundingLoading ? <Empty>Loading funding...</Empty> : fundingError && !funding ? null : !funding?.funding.length ? <Empty>No funding records.</Empty> : <div className="divide-y">{funding.funding.map(leg => { const token = tokens.find(asset => asset.assetId === leg.origin_asset); return <article key={leg.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:gap-x-6"><div className="min-w-0"><p className="break-words text-sm font-medium">{fundingLabel(leg)}</p><div className="mt-2">{token ? <AssetIdentity symbol={token.symbol} network={token.blockchain} size={18}/> : <span className="text-xs text-muted-foreground">Saved asset</span>}</div></div><div className="text-right"><p className="font-medium tabular-nums">{usd(leg.credited_amount !== "0" ? leg.credited_amount : leg.expected_output)}</p><p className="mt-1 text-xs text-muted-foreground">{leg.credited_amount !== "0" ? "Credited USDC" : "Expected USDC"}</p></div><div className="justify-self-start"><Status value={leg.status}/></div><button type="button" className="min-h-9 justify-self-end text-sm text-primary" aria-label={`Review funding ${leg.reference}`} onClick={() => { setError(""); clearFundingLink(); linkedDepositId.current = ""; setDeposit(leg); openTaskDrawer("treasury-deposit-flow"); }}>Review</button></article>; })}</div>}{funding && (funding.hasMore || funding.page > 1) && <FundingPagination data={funding} loading={fundingRefreshing} onPageChange={setFundingPage}/>}</section>}
    <TaskDrawer id="treasury-reservations" title="Reserved funds"><dl className="divide-y">{[["Payments", treasury?.paymentReserved ?? treasury?.reserved], ["Claimable distributions", treasury?.distributionReserved], ["Claims pending", treasury?.distributionPending], ["Client earmarks", treasury?.clientReserved], ["Linked payment funding", treasury?.linkedFundingReserved]].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 py-4 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{treasury ? usd(value ?? "0") : "..."}</dd></div>)}</dl></TaskDrawer>
    {!treasury?.config && canManage && <TaskDrawer id="treasury-activation-flow" title="Activate treasury" busySelector='[data-wallet-action-busy="true"]'><TreasuryCreation/></TaskDrawer>}
    <TaskDrawer id="treasury-manage-flow" title={canManage ? "Manage treasury" : "Treasury details"}><div aria-busy={!!busy} className="grid gap-5">{treasury?.config && <><div><p className="mb-2 text-xs text-muted-foreground">Contract on NEAR {treasury.config.network}</p><Address value={treasury.config.near_account_id} network={treasury.config.network}/>{treasury.config.architecture === "shared_v1" && <p className="mt-3 text-xs text-amber-900">Use Add funds. Plain transfers to this shared contract will not credit your company.</p>}</div><details className="border-t pt-5 text-sm"><summary className="cursor-pointer">Contract upgrade authority</summary><div className="mt-3"><ContractUpgradeDisclosure policy={treasury.upgradePolicy}/></div></details></>}<TreasuryStorage key={organization.id}/>{canManage && treasury?.config && <details className="border-t pt-5 text-sm"><summary className="cursor-pointer">Token registration</summary><div className="mt-4"><Action className="bg-muted text-foreground hover:bg-secondary" busy={busy === "setup"} disabled={!!busy} onClick={() => void run("setup", async () => { const result = await api<{ walletActions: NearWalletAction[] }>(`${base}/treasury/setup`, {}); await withTaskDrawerWallet(() => signNearActions(result.walletActions, treasury.config!.network)); await api(`${base}/treasury/sync`, {}); refresh(); })}>Refresh USDC registration</Action></div></details>}
      {!treasury?.config && canManage && <details className="border-t pt-5 text-sm" onInvalidCapture={event => { event.currentTarget.open = true; }}><summary className="cursor-pointer">Connect an existing treasury</summary><form className="mt-5 grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("configure", async () => { await api(`${base}/treasury/configure`, { nearAccountId: values.get("account"), tokenContract: values.get("token"), network: values.get("network") }); refresh(); }); }}><Field label="Treasury account"><input className={control} name="account" required placeholder="company.razor.near"/></Field><Field label="USDC token contract"><input className={control} name="token" required/></Field><Field label="NEAR network"><select className={control} name="network"><option value="mainnet">Mainnet</option><option value="testnet">Testnet</option></select></Field><div><Action busy={busy === "configure"}>Verify ownership</Action></div></form></details>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div></TaskDrawer>
    {canPrepare && <TaskDrawer id="treasury-funding-flow" title="Add funds"><div className="grid gap-5">{assets?.routingCatalogAvailable === false && <p role="status" className="text-sm text-amber-900">Only direct USDC on NEAR is available right now.</p>}{!treasury?.config && <div className="rounded-xl bg-secondary p-4 text-sm"><p>Activate your treasury first.</p>{canManage && <button type="button" className="mt-3 text-primary" onClick={() => { closeTaskDrawer("treasury-funding-flow"); open("treasury-activation-flow"); }}>Activate treasury</button>}</div>}
      <form id="treasury-funding" aria-busy={busy === "fund"} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("fund", async () => { if (!selected) throw new RequestError("Choose a supported source asset.", 400, "ASSET_REQUIRED"); const result = await api<Funding>(`${base}/funding`, { originAsset: source, amount: units(String(values.get("amount")), selected.decimals), reference: values.get("reference"), refundAddress: values.get("refund") }); clearFundingLink(); linkedDepositId.current = ""; setDeposit({ ...result, source_context: "company" }); refresh(); }); }}>
        <Field as="div" label="Asset and network"><AssetPicker compact label="Asset and network" tokens={tokens} required value={source} onValueChange={setSource} disabled={!!busy}/></Field>{nativeUsdcSuggestions(tokens).length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">USDC options may reduce conversion costs</summary><div className="mt-3 flex flex-wrap gap-2">{nativeUsdcSuggestions(tokens).map(asset => <button key={asset.assetId} type="button" disabled={!!busy} aria-pressed={source === asset.assetId} onClick={() => setSource(asset.assetId)} className="rounded-full border px-3 py-2 aria-pressed:border-primary aria-pressed:bg-secondary"><AssetIdentity symbol="USDC" network={asset.blockchain} size={18}/></button>)}</div></details>}
        <div className="grid gap-5 sm:grid-cols-2"><Field label={`Amount${selected ? ` (${selected.symbol})` : ""}`}><input className={control} name="amount" required inputMode="decimal" placeholder="0.00"/></Field><Field label="Reference"><input className={control} name="reference" required maxLength={120} placeholder="Payroll top-up"/></Field></div>
        <Field label={selected ? `Refund wallet on ${networkIdentity(selected.blockchain).name}` : "Refund wallet"} hint={selected && ["miden", "qtc", "quantus", "prl", "pearl", "stellar", "ton", "xrp"].includes(selected.blockchain) ? destinationGuidance(selected.blockchain) : undefined}><input key={selected?.blockchain} name="refund" className={control} required list="funding-wallets" autoComplete="off" spellCheck={false} placeholder="Wallet address"/><datalist id="funding-wallets">{session.wallets.map(wallet => <option key={wallet.id} value={wallet.address}>{wallet.label ?? wallet.family}</option>)}</datalist></Field>
        <div className="flex justify-end border-t pt-5"><Action busy={busy === "fund"} disabled={!treasury?.config || treasury.config.network !== "mainnet" || !assets || !!busy}>Review deposit</Action></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </form></div></TaskDrawer>}
    <TaskDrawer id="treasury-deposit-flow" title="Funding" description={deposit ? fundingLabel(deposit) : undefined}>{deposit && <div id="treasury-deposit-review" aria-busy={busy === deposit.id} className="grid gap-5"><FundingInstructions key={deposit.id} upgradePolicy={treasury?.upgradePolicy} funding={deposit} canPrepare={canPrepare} beforeSend={async () => { await api(`${base}/source-funding/${deposit.id}/deposit-claim`, {}); setDeposit(current => current?.id === deposit.id ? { ...current, status: "source_unknown" } : current); }} tokens={tokens} onSubmitted={async sourceTxHash => { const result = await api<{ funding: Funding }>(`${base}/funding/${deposit.id}/reconcile`, { sourceTxHash }); updateDeposit(result.funding); refresh(); }} onReconcile={() => void run(deposit.id, async () => { const result = await api<{ funding: Funding }>(`${base}/funding/${deposit.id}/reconcile`, {}); updateDeposit(result.funding); refresh(); })} busy={busy === deposit.id}/><FundingCreditReview key={deposit.id} fundingId={deposit.id} reference={deposit.reference} status={deposit.status} sourceContext={deposit.source_context} onUpdated={updateDeposit}/>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>}</TaskDrawer>
  </div>;
}

function FundingInstructions({ funding, tokens, canPrepare, beforeSend, onSubmitted, onReconcile, busy, upgradePolicy }: { upgradePolicy?: ContractUpgradePolicy | null; funding: Funding; tokens: Token[]; canPrepare: boolean; beforeSend: () => Promise<void>; onSubmitted: (hash: string) => Promise<void>; onReconcile: () => void; busy: boolean }) {
  const token = tokens.find(asset => asset.assetId === funding.origin_asset);
  let quote: { quote?: { deadline?: string }; quoteRequest?: { deadline?: string; refundTo?: string } } | null = null;
  try { quote = JSON.parse(funding.quote); } catch {}
  const direct = isDirectFunding(quote), deadline = quote?.quote?.deadline ?? quote?.quoteRequest?.deadline;
  const allowed = canPrepare && !funding.payment_id && (!funding.source_context || funding.source_context === "company") && funding.status === "pending_deposit" && !funding.source_tx_hash;
  return <div className="grid gap-5">
    <div className="flex items-center justify-between gap-3"><Status value={funding.status}/>{deadline && <p className="text-xs text-muted-foreground">Expires {new Date(deadline).toLocaleString()}</p>}</div>
    <div className="grid grid-cols-2 gap-5 rounded-2xl bg-muted p-5"><div><p className="text-xs text-muted-foreground">Source amount</p><p className="mt-2 break-words text-xl font-medium tabular-nums">{token ? tokenAmount(funding.amount_in, token.decimals) : funding.amount_in}</p><div className="mt-2">{token ? <AssetIdentity symbol={token.symbol} network={token.blockchain} size={20}/> : <span className="text-xs text-muted-foreground">Base units</span>}</div></div><div><p className="text-xs text-muted-foreground">Expected credit</p><p className="mt-2 break-words text-xl font-medium tabular-nums">{usd(funding.expected_output)}</p><div className="mt-2"><AssetIdentity symbol="USDC" network="near" size={20}/></div></div></div>
    {funding.status === "pending_deposit" && <div className="flex justify-between gap-3 text-xs text-muted-foreground"><span>{direct ? "No conversion fee" : "Routing costs included in quote"}</span><span>Network gas extra</span></div>}
    {quote ? <div className="grid gap-4"><div><p className="mb-2 text-xs text-muted-foreground">{direct ? "Treasury contract" : `Deposit address${token ? ` on ${networkIdentity(token.blockchain).name}` : ""}`}</p><Address full value={funding.deposit_address} network={token?.blockchain} label={direct ? "treasury contract" : "deposit address"}/>{direct && <p className="mt-2 text-xs text-amber-900">Use the wallet action below. Plain transfers will not credit your company.</p>}</div>{funding.deposit_memo && <div className="rounded-xl bg-amber-50 p-4"><p className="mb-2 text-xs font-medium text-amber-900">Required memo</p><Address full value={funding.deposit_memo} label="deposit memo"/></div>}{quote.quoteRequest?.refundTo && <div><p className="mb-2 text-xs text-muted-foreground">Refund wallet</p><Address full value={quote.quoteRequest.refundTo} network={token?.blockchain}/></div>}</div> : <p role="alert" className="text-sm text-destructive">Deposit instructions unavailable.</p>}
    {token && quote && canPrepare && <FundingWalletAction compact upgradePolicy={upgradePolicy} key={funding.id} funding={funding} token={token} depositAllowed={allowed} beforeSend={beforeSend} onBroadcast={onSubmitted} onSubmitted={onSubmitted}/>}
    {(funding.source_context === "obligation" || funding.payment_id) && <p className="text-xs text-muted-foreground">Continue deposits from this payment in Payments.</p>}{funding.source_context === "funding_request" && <p className="text-xs text-muted-foreground">Continue deposits from the original funding link.</p>}
    <div className="flex items-center justify-between gap-4"><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Deposit details</summary><dl className="mt-4 grid gap-3"><div><dt>Reference</dt><dd className="mt-1 break-all">{funding.reference}</dd></div><div><dt>Asset ID</dt><dd className="mt-1 break-all">{funding.origin_asset}</dd></div><div><dt>Funding ID</dt><dd className="mt-1 break-all">{funding.id}</dd></div></dl></details><Action className="bg-muted text-foreground hover:bg-secondary" busy={busy} disabled={!canPrepare || busy} onClick={onReconcile}>Check status</Action></div>
  </div>;
}
