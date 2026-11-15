"use client";

import { appHref } from "@/lib/demo-scope";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useIdentity } from "../auth/identity-provider";
import { identityRequest, walletErrorMessage } from "../auth/wallets";
import { LinkRecipientIdentity } from "./portal-auth";
import { AssetPicker, NetworkPicker } from "@/components/assets/asset-picker";
import { AssetIdentity, NetworkIdentity } from "@/components/assets/asset-identity";
import { destinationGuidance } from "@/lib/destination-guidance";
import { usd } from "@/lib/format";
import { Action, Address, control, Empty, Field, Status } from "../workspace/shared";

interface Recipient {id:string;name:string;email:string|null;kind:string;primary_asset:string;primary_network:string;primary_address:string;primary_memo?:string|null;backup_network:string|null;backup_address:string|null;fallback_consent:number;preference_status:string;version:number;confirmed_at:string|null}
interface Portal {recipient:Recipient;organization:{id:string;name:string};backupNetworks:string[];backupAsset:string}
interface Asset {assetId:string;symbol:string;blockchain:string;decimals:number;contractAddress?:string|null}
interface Payment {id:string;kind:string;reference:string;amount:string;status:string;scheduled_for:string|null;created_at:string;destination_asset:string|null;destination_network:string|null;destination_address:string|null;destination_tx_hash:string|null;route_status:string|null}
const NETWORK_NAMES:Record<string,string>={eth:"Ethereum",base:"Base",arb:"Arbitrum",pol:"Polygon",sol:"Solana",near:"NEAR",op:"Optimism",avax:"Avalanche",bsc:"BNB Chain"};
const networkName=(network:string)=>NETWORK_NAMES[network] || network;

export function RecipientPortal({ token, recipientId, showHistory = true }: { token?: string; recipientId?: string; showHistory?: boolean }) {
  const endpoint = token ? `/recipient-portal/${encodeURIComponent(token)}` : `/recipient-workspace/profiles/${encodeURIComponent(recipientId || "")}`;
  return <PayoutPreferences key={endpoint} endpoint={endpoint} showHistory={showHistory}/>;
}
function PayoutPreferences({ endpoint, showHistory }: { endpoint: string; showHistory: boolean }) {
  const {refresh:refreshIdentity}=useIdentity(),activeEndpoint=useRef(endpoint);
  const [portal, setPortal] = useState<Portal | null>(null), [assets, setAssets] = useState<Asset[]>([]), [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false), [success, setSuccess] = useState(false);
  const [catalogWarning, setCatalogWarning] = useState<string | null>(null), [historyWarning, setHistoryWarning] = useState<string | null>(null);
  const [primaryAsset, setPrimaryAsset] = useState(""), [primaryNetwork, setPrimaryNetwork] = useState(""), [primaryAddress, setPrimaryAddress] = useState(""), [primaryMemo, setPrimaryMemo] = useState("");
  const [backupNetwork, setBackupNetwork] = useState(""), [backupAddress, setBackupAddress] = useState(""), [consent, setConsent] = useState(false), [reviewed, setReviewed] = useState(false);
  const [step, setStep] = useState<"summary" | "primary" | "backup" | "review">("primary"), [selectedPayment, setSelectedPayment] = useState("");
  const generation = useRef(0), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(null); setPortal(null); setSuccess(false); setReviewed(false);
    try {
      const [infoResult, catalogResult, historyResult] = await Promise.allSettled([identityRequest<Portal>(activeEndpoint.current), identityRequest<{ tokens: Asset[] }>("/assets"), showHistory ? identityRequest<{ payments: Payment[] }>(`${activeEndpoint.current}/payments`) : Promise.resolve({ payments: [] as Payment[] })]);
      if (!active.current || request !== generation.current) return;
      if (infoResult.status !== "fulfilled") throw infoResult.reason;
      const info = infoResult.value, recipient = info.recipient;
      setPortal(info); setAssets(catalogResult.status === "fulfilled" ? catalogResult.value.tokens : []); setPayments(historyResult.status === "fulfilled" ? historyResult.value.payments : []);
      setCatalogWarning(catalogResult.status === "fulfilled" ? null : "Asset list unavailable. Your saved route can still be reviewed.");
      setHistoryWarning(historyResult.status === "fulfilled" ? null : "Payment history unavailable.");
      setPrimaryAsset(recipient.primary_asset); setPrimaryNetwork(recipient.primary_network); setPrimaryAddress(recipient.primary_address); setPrimaryMemo(recipient.primary_memo || ""); setBackupNetwork(recipient.backup_network || ""); setBackupAddress(recipient.backup_address || ""); setConsent(recipient.fallback_consent === 1);
      setStep(recipient.preference_status === "confirmed" ? "summary" : "primary");
    } catch (cause) { if (active.current && request === generation.current) setError(walletErrorMessage(cause)); }
    finally { if (active.current && request === generation.current) setLoading(false); }
  }, [endpoint, showHistory]);
  useEffect(() => { void load(); }, [load]);
  function changed() { setSuccess(false); setReviewed(false); }
  async function confirm() {
    if (!portal || saving || !reviewed) return;
    const request=++generation.current;
    setSaving(true); setError(null); setSuccess(false);
    try {
      const result = await identityRequest<{ recipient: Recipient }>(`${activeEndpoint.current}/confirm`, { expectedVersion: portal.recipient.version, primaryAsset, primaryNetwork, primaryAddress: primaryAddress.trim(), primaryMemo: primaryMemo.trim() || null, backupNetwork: backupNetwork || null, backupAddress: backupAddress.trim() || null, fallbackConsent: consent });
      if (!active.current||request!==generation.current) return;
      activeEndpoint.current=`/recipient-workspace/profiles/${encodeURIComponent(result.recipient.id)}`;
      if(endpoint.startsWith("/recipient-portal/"))window.history.replaceState(null,"",appHref(`/receive?view=profiles&recipientId=${encodeURIComponent(result.recipient.id)}`));
      setPortal({ ...portal, recipient: result.recipient }); setSuccess(true); setReviewed(false); setStep("summary");
      void refreshIdentity().catch(()=>{});
      if(showHistory){
        setHistoryWarning("Loading payment history...");
        void identityRequest<{payments:Payment[]}>(`${activeEndpoint.current}/payments`).then(history=>{if(active.current&&request===generation.current){setPayments(history.payments);setHistoryWarning(null);}}).catch(()=>{if(active.current&&request===generation.current)setHistoryWarning("Payment history unavailable. Refresh to try again.");});
      }
    } catch (cause) { if (active.current&&request===generation.current) setError(walletErrorMessage(cause)); }
    finally { if (active.current&&request===generation.current) setSaving(false); }
  }
  const selected = assets.find(asset => asset.assetId === primaryAsset), payment = payments.find(value => value.id === selectedPayment);
  const canConfirm = Boolean(primaryAsset && primaryNetwork && primaryAddress.trim() && (!consent || backupNetwork && backupAddress.trim()));
  if (loading) return <p role="status" className="text-sm text-muted-foreground">Loading payout preferences...</p>;
  if (!portal) return <div className="grid gap-5"><h2 className="text-2xl font-medium">Payout preferences</h2>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<LinkRecipientIdentity onComplete={load} companyInvitation={endpoint.startsWith("/recipient-portal/")}/><div className="flex flex-wrap items-center gap-4"><Action onClick={() => void load()}>Try again</Action><a href={appHref("/receive")} className="text-sm text-primary">Open my workspace</a></div></div>;
  const primary = !primaryAsset||!primaryNetwork||!primaryAddress.trim()?<p className="rounded-2xl bg-muted/50 p-5 text-sm text-muted-foreground">Awaiting payout setup</p>:<div className="grid min-w-0 gap-3 rounded-2xl bg-muted/50 p-5"><p className="text-xs text-muted-foreground">Primary payout</p><AssetIdentity symbol={selected?.symbol || primaryAsset} network={primaryNetwork} assetId={primaryAsset}/><Address value={primaryAddress.trim()} network={primaryNetwork} full/>{primaryMemo.trim() && <Field as="div" label="Required memo"><Address value={primaryMemo.trim()} label="memo" full/></Field>}</div>;
  const backup = <div className="grid min-w-0 gap-3 rounded-2xl border p-5"><p className="text-xs text-muted-foreground">USDC backup</p>{backupNetwork ? <><AssetIdentity symbol="USDC" network={backupNetwork}/><Address value={backupAddress.trim()} network={backupNetwork} full/><span className={`text-xs ${consent ? "text-emerald-700" : "text-muted-foreground"}`}>{consent ? "Authorized when primary is unavailable" : "Backup not authorized"}</span></> : <p className="text-sm text-muted-foreground">No backup selected</p>}</div>;
  return <section aria-busy={saving} className="grid min-w-0 gap-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div>{showHistory && <p className="mb-1 text-sm text-muted-foreground">{portal.organization.name}</p>}<h2 className="text-xl font-medium">{step === "summary" ? "Payout preferences" : step === "primary" ? "Choose your payout" : step === "backup" ? "Set a USDC backup" : "Confirm receiving details"}</h2></div><Status value={portal.recipient.preference_status}/></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {success && <p role="status" className="inline-flex items-center gap-2 text-sm text-emerald-700"><Check size={16}/>Preferences confirmed · v{portal.recipient.version}</p>}
    {step === "summary" ? <><div className="grid min-w-0 gap-4 lg:grid-cols-2">{primary}{backup}</div><div className="flex flex-wrap items-center gap-4">{showHistory&&<a href={appHref("/receive")} className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white">Open my workspace</a>}<Action className={showHistory?"bg-muted text-foreground hover:bg-secondary":undefined} disabled={saving} onClick={() => { changed(); setStep("primary"); }}>Edit preferences</Action><button type="button" disabled={saving} className="text-sm text-muted-foreground" onClick={() => void load()}>Refresh</button></div></> : <>
      <div className="flex items-center gap-2 text-xs" aria-label="Payout setup progress">{(["primary", "backup", "review"] as const).map((value, index) => <span key={value} className={`rounded-full px-3 py-1.5 ${step === value ? "bg-primary text-white" : "bg-muted text-muted-foreground"}`}>{index + 1}. {value === "primary" ? "Payout" : value === "backup" ? "Backup" : "Review"}</span>)}</div>
      {step === "primary" && <form className="grid gap-5" onSubmit={event => { event.preventDefault(); if (primaryAsset && primaryNetwork && primaryAddress.trim()) { setError(null); setStep("backup"); } }}><fieldset disabled={saving} className="grid gap-5">
        {catalogWarning && <p role="status" className="text-sm text-muted-foreground">{catalogWarning}</p>}
        <Field as="div" label="Asset and network"><AssetPicker compact label="Receiving asset and network" tokens={assets} value={primaryAsset} onValueChange={value => { const asset = assets.find(item => item.assetId === value); if (asset && asset.blockchain !== primaryNetwork) { setPrimaryAddress(""); setPrimaryMemo(""); } setPrimaryAsset(value); if (asset) setPrimaryNetwork(asset.blockchain); setConsent(false); changed(); }} disabled={saving} required savedAsset={portal.recipient.primary_asset&&portal.recipient.primary_network?{ assetId: portal.recipient.primary_asset, symbol: portal.recipient.primary_asset, blockchain: portal.recipient.primary_network }:undefined}/></Field>
        {primaryAsset && !selected && primaryAsset !== "USDC" && <p role="status" className="text-sm text-amber-800">Saved asset is outside the current catalog. A USDC backup is recommended.</p>}
        <Field label={primaryNetwork?`Receiving address · ${networkName(primaryNetwork)}`:"Receiving address"}><input required disabled={!primaryNetwork} autoComplete="off" spellCheck={false} value={primaryAddress} onChange={event => { setPrimaryAddress(event.target.value); setConsent(false); changed(); }} className={`${control} font-mono text-sm`}/></Field>
        <Field label="Destination tag or memo (if required)"><input autoComplete="off" maxLength={120} value={primaryMemo} onChange={event => { setPrimaryMemo(event.target.value); setConsent(false); changed(); }} className={control}/></Field>
        {primaryNetwork&&<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Network requirements</summary><p className="mt-3 leading-5">{destinationGuidance(primaryNetwork)}</p></details>}
        <p className="text-xs text-muted-foreground">USDC on a popular supported network may offer lower fees and better compatibility.</p>
        <div className="flex justify-end border-t pt-5"><Action disabled={saving || !primaryAsset || !primaryNetwork || !primaryAddress.trim()}>Continue</Action></div>
      </fieldset></form>}
      {step === "backup" && <form className="grid gap-5" onSubmit={event => { event.preventDefault(); setReviewed(false); setError(null); setStep("review"); }}><fieldset disabled={saving} className="grid gap-5">
        <Field as="div" label="USDC network"><NetworkPicker compact label="USDC backup network" networks={portal.backupNetworks} symbol="USDC" allowEmpty emptyLabel="No backup" value={backupNetwork} onValueChange={value => { setBackupNetwork(value); setBackupAddress(""); setConsent(false); changed(); }} disabled={saving}/></Field>
        {backupNetwork && <Field label={`USDC address · ${networkName(backupNetwork)}`}><input required autoComplete="off" spellCheck={false} value={backupAddress} onChange={event => { setBackupAddress(event.target.value); setConsent(false); changed(); }} className={`${control} font-mono text-sm`}/></Field>}
        {backupNetwork && <label className="flex items-start gap-3 rounded-2xl bg-muted/50 p-4 text-sm"><input type="checkbox" checked={consent} disabled={saving || !backupAddress.trim()} onChange={event => { setConsent(event.target.checked); changed(); }} className="mt-1"/>I allow native USDC at this address on {networkName(backupNetwork)} when my primary route is unavailable.</label>}
        <div className="flex items-center justify-between gap-4 border-t pt-5"><button type="button" className="inline-flex items-center gap-1 text-sm text-muted-foreground" onClick={() => setStep("primary")}><ChevronLeft size={16}/>Payout</button><Action disabled={saving || !!backupNetwork && !backupAddress.trim()}>Review preferences</Action></div>
      </fieldset></form>}
      {step === "review" && <><div className="grid min-w-0 gap-4 lg:grid-cols-2">{primary}{backup}</div><label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={reviewed} disabled={saving} onChange={event => setReviewed(event.target.checked)} className="mt-1"/>I checked these addresses, networks and memo. Confirm this company's payout preferences.</label><div className="flex items-center justify-between gap-4 border-t pt-5"><button type="button" disabled={saving} className="inline-flex items-center gap-1 text-sm text-muted-foreground" onClick={() => { setReviewed(false); setStep("backup"); }}><ChevronLeft size={16}/>Backup</button><Action disabled={saving || !canConfirm || !reviewed} busy={saving} onClick={() => void confirm()}>Confirm preferences</Action></div></>}
    </>}
    {showHistory && step === "summary" && <div className="grid gap-4 border-t pt-5"><h3 className="text-lg font-medium">Recent payments</h3>{historyWarning ? <p role="status" className="text-sm text-muted-foreground">{historyWarning}</p> : payment ? <div className="grid gap-4 rounded-2xl border p-5"><button type="button" className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground" onClick={() => setSelectedPayment("")}><ChevronLeft size={16}/>Payments</button><div className="flex items-center justify-between gap-3"><strong className="font-medium">{usd(payment.amount)} USDC</strong><Status value={payment.status}/></div>{payment.destination_network && <NetworkIdentity network={payment.destination_network}/>} {payment.destination_address && <Address value={payment.destination_address} network={payment.destination_network || undefined}/>} {payment.destination_tx_hash && <Field as="div" label="Delivery transaction"><Address value={payment.destination_tx_hash} label="delivery transaction hash"/></Field>}</div> : payments.length ? <div className="divide-y rounded-2xl border px-4">{payments.map(value => <button key={value.id} type="button" className="flex w-full items-center justify-between gap-3 py-4 text-left" onClick={() => setSelectedPayment(value.id)}><div className="min-w-0"><p className="truncate text-sm font-medium">{/^(bill|payroll):/.test(value.reference) ? value.kind === "payroll" ? "Payroll payment" : "Invoice payment" : value.reference}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(value.created_at).toLocaleDateString()}</p></div><div className="ml-auto grid justify-items-end gap-2"><span className="text-sm tabular-nums">{usd(value.amount)}</span><Status value={value.status}/></div><ChevronRight size={16}/></button>)}</div> : <Empty>No payments yet.</Empty>}</div>}
  </section>;
}
