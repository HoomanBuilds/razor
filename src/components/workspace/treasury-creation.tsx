"use client";

import { ContractUpgradeDisclosure } from "@/components/contract-upgrade-disclosure";
import type { ContractUpgradePolicy } from "@/lib/contract-upgrade-policy";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, RequestError } from "@/lib/api";
import { formatUnits, parseUnits } from "@/lib/money";
import { usd } from "@/lib/format";
import { authenticateWallet } from "@/components/auth/wallets";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { withTaskDrawerWallet } from "./task-drawer";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Field, Panel, Status } from "./shared";

interface RegistrationState {upgradePolicy?:ContractUpgradePolicy;ready:boolean;network:"mainnet"|"testnet";treasuryId:string|null;reason?:string|null;verifiedWallets:Array<{address:string;network:string}>}
interface CompanyRegistration {account_id:string;owner_id:string;status:"ready"}
interface RegistrationQuote {upgradePolicy:ContractUpgradePolicy;architecture:"shared_v1";companyId:string;accountId:string;ownerAccount:string;slug:string;tokenContract:string;treasuryCodeHash:string;minimumDeposit:string;storageBytes:string;perPaymentLimit:string;dailyLimit:string;network:"mainnet"|"testnet";hash:string}
interface QuoteResult {quote:RegistrationQuote;creation:CompanyRegistration|null}
interface RegistrationResult {status:string;creation:CompanyRegistration|null;configured:boolean}
const near=(amount:string)=>`${formatUnits(amount,24)} NEAR`;

export function TreasuryCreation() {
  const {base,revision,refresh,organization,session}=useWorkspace();
  const {data:config,error:configError,loading}=useResource<RegistrationState>(`${base}/onboarding/config`,revision),{busy,error,run}=useAction();
  const [owner,setOwner]=useState(""),[perPayment,setPerPayment]=useState("10000"),[daily,setDaily]=useState("100000"),[step,setStep]=useState(0);
  const [quoted,setQuoted]=useState<QuoteResult|null>(null),[result,setResult]=useState<RegistrationResult|null>(null),[txHash,setTxHash]=useState<string|null>(null),[acknowledged,setAcknowledged]=useState(false),[pending,setPending]=useState(false),pollCount=useRef(0);
  const ownerAccount=owner || config?.verifiedWallets[0]?.address || "",slug="company",rememberKey=`razor:treasury-registration:${session.user.id}:${organization.id}:${config?.network || "unknown"}:v1`;
  const refreshRegistration=useCallback(async(ownerAccount:string)=>{
    const current=await api<RegistrationResult>(`${base}/onboarding/reconcile`,{ownerAccount,slug:"company"});
    setResult(current);
    if(current.configured){setPending(false);refresh();try{localStorage.removeItem(rememberKey);}catch{}}
    return current;
  },[base,refresh,rememberKey]);
  useEffect(()=>{
    try {const stored=JSON.parse(localStorage.getItem(rememberKey) || "null") as {ownerAccount?:string;txHash?:string}|null;
      if(stored?.ownerAccount){setOwner(stored.ownerAccount);setTxHash(stored.txHash || null);setPending(Boolean(stored.txHash));if(stored.txHash)setStep(2);}
    }catch{}
  },[rememberKey]);
  useEffect(()=>{setQuoted(null);setResult(null);setAcknowledged(false);},[ownerAccount,perPayment,daily]);
  useEffect(()=>{
    if(!pending||result?.configured||pollCount.current>=12)return;
    const timer=setTimeout(()=>{pollCount.current+=1;void run("poll",async()=>{await refreshRegistration(ownerAccount);});},5000);
    return ()=>clearTimeout(timer);
  },[pending,result,ownerAccount,run,refreshRegistration]);
  function input() {
    try{return {ownerAccount,slug,perPaymentLimit:parseUnits(perPayment,6),dailyLimit:parseUnits(daily,6)};}
    catch{throw new RequestError("Enter USDC policy limits with at most six decimal places.",422,"INVALID_LIMITS");}
  }
  async function register() {
    if(!quoted||!acknowledged||pending)return;
    const terms=input(),prepared=await api<QuoteResult&{walletActions:NearWalletAction[]}>(`${base}/onboarding/prepare`,{...terms,quoteHash:quoted.quote.hash});
    if(prepared.quote.hash!==quoted.quote.hash)throw new RequestError("Review a fresh registration quote before signing.",409,"CREATION_QUOTE_CHANGED");
    const hash=await withTaskDrawerWallet(()=>signNearActions(prepared.walletActions,prepared.quote.network,[terms.ownerAccount]));
    if(!hash)throw new RequestError("No wallet receipt was returned. Check registration status before trying again.",409,"RECEIPT_REQUIRED");
    setTxHash(hash);
    setPending(true);pollCount.current=0;
    try{localStorage.setItem(rememberKey,JSON.stringify({ownerAccount:terms.ownerAccount,txHash:hash}));}catch{}
    await refreshRegistration(terms.ownerAccount);
  }
  const recorded=result?.creation || quoted?.creation,canRegister=Boolean(config?.ready&&ownerAccount&&quoted&&acknowledged&&!recorded&&!pending);
  return <div data-wallet-action-busy={busy === "register" || busy === "link" ? "true" : "false"}><Panel title="Activate your company treasury" description="Choose an owner, set spending limits, then review the exact registration."><div className="grid gap-5">
    <ol aria-label="Treasury activation steps" className="flex gap-2">{["Owner wallet","Spending limits","Review and activate"].map((label,index)=><li key={label} aria-current={step === index ? "step" : undefined} className={`flex-1 rounded-xl px-3 py-3 text-xs ${step === index ? "bg-secondary font-medium text-primary" : "bg-muted text-muted-foreground"}`}><span className="mr-1">{index+1}.</span>{label}</li>)}</ol>
    {loading?<p className="text-sm text-muted-foreground">Checking the shared treasury...</p>:null}
    {step === 0 && config && !config.verifiedWallets.length ? <div className="rounded-xl bg-muted p-4"><p className="text-sm leading-6">A verified NEAR owner wallet is required. Link an existing wallet below, or create and recover one from your account settings.</p><div className="mt-3 flex flex-wrap items-center gap-4"><a href="/account" target="_blank" rel="noreferrer" className="text-sm font-medium text-primary">Open wallet setup</a><button type="button" className="text-sm font-medium text-primary" onClick={refresh}>Refresh linked wallets</button></div></div> : null}
    {configError?<p role="alert" className="text-sm text-destructive">{configError}</p>:null}
    {config&&!config.ready?<p role="status" className="rounded-lg bg-muted p-4 text-sm">{config.reason}</p>:null}
    {config?.network==="testnet"?<p className="text-sm text-muted-foreground">Testnet registration supports development. Live NEAR Intents funding requires mainnet.</p>:null}
    {config?.treasuryId && step === 2 ? <div className="text-sm"><span className="mr-2 text-muted-foreground">Shared treasury on {config.network}</span><Address value={config.treasuryId} network={config.network}/></div> : null}

    <form hidden={step === 2} onSubmit={event=>{event.preventDefault();if(step === 0){setStep(1);return;}void run("quote",async()=>{const quote=await api<QuoteResult>(`${base}/onboarding/quote`,input());setQuoted(quote);setResult(quote.creation?{status:quote.creation.status,creation:quote.creation,configured:false}:null);setAcknowledged(false);setStep(2);});}}>
      <fieldset disabled={!!busy||pending} className="grid min-w-0 gap-4 border-0 p-0 md:grid-cols-2">
        <div hidden={step !== 0} className="md:col-span-2"><Field label="Verified NEAR owner wallet"><select required className={control} value={ownerAccount} onChange={event=>setOwner(event.target.value)}><option value="">Choose owner wallet</option>{config?.verifiedWallets.map(wallet=><option key={wallet.address} value={wallet.address}>{wallet.address}</option>)}</select></Field><p className="mt-3 text-xs leading-5 text-muted-foreground">This wallet will control your company's balance and approvals. Google login alone does not provide NEAR signing authority.</p></div>
        <div hidden={step !== 1} className="grid gap-4 md:col-span-2 sm:grid-cols-2">        <Field label="Maximum per payment (USDC)"><input className={control} required value={perPayment} onChange={event=>setPerPayment(event.target.value)} inputMode="decimal"/></Field>
        <Field label="Daily payment limit (USDC)"><input className={control} required value={daily} onChange={event=>setDaily(event.target.value)} inputMode="decimal"/></Field>
<p className="text-xs leading-5 text-muted-foreground sm:col-span-2">These initial limits bound company payments. Review and change treasury policy later with authorized wallet approval.</p></div>
        <div className="flex flex-wrap gap-3 md:col-span-2">{step === 1 && <Action type="button" disabled={!!busy} className="bg-muted text-foreground hover:bg-secondary" onClick={()=>setStep(0)}>Back</Action>}<Action busy={busy==="quote"} disabled={!config?.ready||!ownerAccount}>{step === 0 ? "Continue to limits" : "Review registration"}</Action>{step === 0 && <Action type="button" busy={busy==="link"} className="bg-muted text-foreground hover:bg-secondary" onClick={()=>void run("link",async()=>{await withTaskDrawerWallet(()=>authenticateWallet("near",{link:true}));refresh();})}>Link owner wallet</Action>}</div>
      </fieldset>
    </form>
    {(pending || recorded || txHash) && <Action type="button" busy={busy==="check"||busy==="poll"} disabled={!ownerAccount||!!busy} onClick={()=>void run("check",async()=>{pollCount.current=0;await refreshRegistration(ownerAccount);})}>Check registration status</Action>}
    {quoted && step === 2 ? <section className="space-y-4 rounded-2xl border bg-muted/40 p-5"><button type="button" disabled={!!busy || pending} className="text-xs font-medium text-primary" onClick={()=>{setStep(1);setAcknowledged(false);}}>Edit owner or limits</button>
      <ContractUpgradeDisclosure policy={quoted.quote.upgradePolicy}/>
      <div className="grid gap-4 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Shared treasury account</p><div className="mt-2"><Address value={quoted.quote.accountId} network={quoted.quote.network}/></div></div><div><p className="text-xs text-muted-foreground">Company owner</p><div className="mt-2"><Address value={quoted.quote.ownerAccount} network={quoted.quote.network}/></div></div><div><p className="text-xs text-muted-foreground">Company storage allowance</p><p className="mt-1 text-xl font-semibold">{near(quoted.quote.minimumDeposit)}</p></div><div><p className="text-xs text-muted-foreground">Payment policy</p><p className="mt-1 text-sm">{usd(quoted.quote.perPaymentLimit)} per payment</p><p className="text-sm">{usd(quoted.quote.dailyLimit)} per day</p></div></div>
      <p className="text-xs leading-5 text-muted-foreground">This deposit funds your company's {quoted.quote.storageBytes} bytes of shared-state allowance. It does not pay for another contract deployment, and is not a Razor subscription fee or a USDC deposit. Wallet gas is additional. More history can require a storage top-up.</p>
      <details className="text-xs"><summary className="cursor-pointer">Verified registration details</summary><p className="mt-2 break-all">Company ID: {quoted.quote.companyId}</p><p className="mt-1 break-all">USDC contract: {quoted.quote.tokenContract}</p><p className="mt-1 break-all">Treasury code hash: {quoted.quote.treasuryCodeHash}</p></details>
      <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" checked={acknowledged} disabled={!!busy||pending} onChange={event=>setAcknowledged(event.target.checked)} className="mt-1.5"/>I reviewed the company owner, shared account, storage deposit, USDC policy limits and contract upgrade authority.</label>
      <Action busy={busy==="register"||pending} disabled={!canRegister||!!busy} onClick={()=>void run("register",register)}>{pending?"Verifying registration":"Activate in my wallet"}</Action>
    </section>:null}
    {recorded?<section className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-3"><h3 className="text-sm font-medium">Company registration</h3><Status value={recorded.status}/></div><Address value={recorded.account_id} network={config?.network}/><p className="text-sm text-muted-foreground">This company is registered. Check registration status to verify its owner and connect its isolated company balance.</p></section>:result?.status==="not_requested"?<p role="status" className="text-sm text-muted-foreground">No final registration was found for this company. A submitted transaction may still be confirming.</p>:null}
    {pending?<p role="status" className="text-sm text-muted-foreground">Registration was submitted. Verify its final status before taking another action. If confirmation takes longer, use Check registration status.</p>:null}
    {txHash?<p className="break-all text-xs text-muted-foreground">Latest wallet transaction: {txHash}</p>:null}
    {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
  </div></Panel></div>;
}
