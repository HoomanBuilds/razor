"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, RequestError } from "@/lib/api";
import { formatUnits, parseUnits } from "@/lib/money";
import { usd } from "@/lib/format";
import { authenticateWallet, connectNearWallet, getNearConnector } from "@/components/auth/wallets";
import type { NearWalletAction } from "@/lib/near-actions";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Field, Panel, Status } from "./shared";

interface FactoryState {ready:boolean;network:"mainnet"|"testnet";factoryId:string|null;reason?:string|null;settlementEnabled:boolean;verifiedWallets:Array<{address:string;network:string}>}
interface Creation {account_id:string;owner_id:string;slug:string;status:"pending"|"ready"|"failed"|"refunding"|"refunded";refund_amount:string}
interface CreationQuote {accountId:string;ownerAccount:string;slug:string;tokenContract:string;treasuryCodeHash:string;factoryCodeHash:string;minimumDeposit:string;treasuryFunding:string;factoryStorageFee:string;perPaymentLimit:string;dailyLimit:string;network:"mainnet"|"testnet";factoryId:string;hash:string}
interface QuoteResult {quote:CreationQuote;creation:Creation|null}
interface CreationResult {status:string;creation:Creation|null;configured:boolean;recoveryActions?:NearWalletAction[]}
const near=(amount:string)=>`${formatUnits(amount,24)} NEAR`;

export function TreasuryCreation() {
  const {base,revision,refresh,organization,session}=useWorkspace();
  const {data:config,error:configError,loading}=useResource<FactoryState>(`${base}/onboarding/config`,revision),{busy,error,run}=useAction();
  const [owner,setOwner]=useState(""),[slug,setSlug]=useState(""),[perPayment,setPerPayment]=useState("10000"),[daily,setDaily]=useState("100000");
  const [quoted,setQuoted]=useState<QuoteResult|null>(null),[result,setResult]=useState<CreationResult|null>(null),[txHash,setTxHash]=useState<string|null>(null),[acknowledged,setAcknowledged]=useState(false),pollCount=useRef(0);
  const ownerAccount=owner || config?.verifiedWallets[0]?.address || "",rememberKey=`float:treasury-creation:${session.user.id}:${organization.id}:v1`;
  const refreshCreation=useCallback(async(ownerAccount:string,slug:string)=>{
    const current=await api<CreationResult>(`${base}/onboarding/reconcile`,{ownerAccount,slug});
    setResult(current);if(current.configured)refresh();return current;
  },[base,refresh]);
  useEffect(()=>{
    try {const stored=JSON.parse(localStorage.getItem(rememberKey) || "null") as {ownerAccount?:string;slug?:string;txHash?:string}|null;
      if(stored?.ownerAccount&&stored.slug){setOwner(stored.ownerAccount);setSlug(stored.slug);setTxHash(stored.txHash || null);}
    }catch{}
  },[rememberKey]);
  useEffect(()=>{setQuoted(null);setResult(null);setAcknowledged(false);},[ownerAccount,slug,perPayment,daily]);
  useEffect(()=>{
    if(!result||!["pending","refunding"].includes(result.status)||pollCount.current>=12)return;
    const timer=setTimeout(()=>{pollCount.current+=1;void run("poll",async()=>{await refreshCreation(ownerAccount,slug);});},5000);
    return ()=>clearTimeout(timer);
  },[result,ownerAccount,slug,run,refreshCreation]);
  function input() {
    try{return {ownerAccount,slug,perPaymentLimit:parseUnits(perPayment,6),dailyLimit:parseUnits(daily,6)};}
    catch{throw new RequestError("Enter USDC policy limits with at most six decimal places.",422,"INVALID_LIMITS");}
  }
  async function sign(actions:NearWalletAction[],owner:string,network:string) {
    const connector=await getNearConnector();
    if(connector.network!==network)throw new RequestError("Reconnect your wallet on the configured NEAR network before signing.",409,"WALLET_NETWORK_MISMATCH");
    const {wallet,accounts}=await connectNearWallet();
    if(!accounts.some(account=>account.accountId===owner))throw new RequestError("Connect the verified NEAR wallet selected as treasury owner.",403,"OWNER_WALLET_MISMATCH");
    const receipts=await wallet.signAndSendTransactions({transactions:actions.map(action=>({...action,signerId:owner})),network:network as "mainnet"|"testnet"}),last=receipts.at(-1);
    if(!last)throw new RequestError("No wallet receipt was returned. Check creation status before retrying.",409,"RECEIPT_REQUIRED");
    setTxHash(last.transaction.hash);
    try{localStorage.setItem(rememberKey,JSON.stringify({ownerAccount:owner,slug,txHash:last.transaction.hash}));}catch{}
    if(receipts.some(receipt=>typeof receipt.status==="object"&&"Failure" in receipt.status))throw new RequestError("The wallet action failed. Check the factory status before trying again.",409,"CREATION_ACTION_FAILED");
  }
  async function create() {
    if(!quoted||!acknowledged)return;
    const terms=input(),prepared=await api<QuoteResult&{walletActions:NearWalletAction[]}>(`${base}/onboarding/prepare`,{...terms,quoteHash:quoted.quote.hash});
    if(prepared.quote.hash!==quoted.quote.hash)throw new RequestError("Review a fresh deposit quote before signing.",409,"CREATION_QUOTE_CHANGED");
    try{localStorage.setItem(rememberKey,JSON.stringify({ownerAccount:terms.ownerAccount,slug:terms.slug}));}catch{}
    await sign(prepared.walletActions,terms.ownerAccount,prepared.quote.network);pollCount.current=0;await refreshCreation(terms.ownerAccount,terms.slug);
  }
  const recorded=result?.creation || quoted?.creation,canCreate=Boolean(config?.ready&&ownerAccount&&quoted&&acknowledged&&(!recorded||recorded.status==="refunded"));
  return <Panel title="Create your company treasury" description="Create a NEAR contract from your own wallet. You stay its owner; the deployed treasury has no access keys."><div className="grid gap-5">
    {loading?<p className="text-sm text-muted-foreground">Checking treasury creation infrastructure...</p>:null}
    {configError?<p role="alert" className="text-sm text-destructive">{configError}</p>:null}
    {config&&!config.ready?<p role="status" className="rounded-lg bg-muted p-4 text-sm">{config.reason}</p>:null}
    {config?.network==="testnet"?<p className="text-sm text-muted-foreground">Testnet creation supports development. Live NEAR Intents funding requires a mainnet treasury.</p>:null}
    {config?.factoryId?<div className="text-sm"><span className="mr-2 text-muted-foreground">Factory on {config.network}</span><Address value={config.factoryId} network={config.network}/></div>:null}
    <form onSubmit={event=>{event.preventDefault();void run("quote",async()=>{const quote=await api<QuoteResult>(`${base}/onboarding/quote`,input());setQuoted(quote);setResult(quote.creation?{status:quote.creation.status,creation:quote.creation,configured:false}:null);setAcknowledged(false);});}}>
      <fieldset disabled={!!busy} className="grid min-w-0 gap-4 border-0 p-0 md:grid-cols-2">
        <Field label="Verified NEAR owner wallet"><select required className={control} value={ownerAccount} onChange={event=>setOwner(event.target.value)}><option value="">Choose owner wallet</option>{config?.verifiedWallets.map(wallet=><option key={wallet.address} value={wallet.address}>{wallet.address}</option>)}</select></Field>
        <Field label="Treasury name" hint="1 to 24 lowercase letters, digits or hyphens."><input className={control} required value={slug} onChange={event=>setSlug(event.target.value.trim().toLowerCase())} pattern="[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?" maxLength={24} placeholder="company"/></Field>
        <Field label="Maximum per payment (USDC)"><input className={control} required value={perPayment} onChange={event=>setPerPayment(event.target.value)} inputMode="decimal"/></Field>
        <Field label="Daily payment limit (USDC)"><input className={control} required value={daily} onChange={event=>setDaily(event.target.value)} inputMode="decimal"/></Field>
        <div className="flex flex-wrap gap-3 md:col-span-2"><Action busy={busy==="quote"} disabled={!config?.ready||!ownerAccount}>Review creation deposit</Action><Action type="button" busy={busy==="link"} onClick={()=>void run("link",async()=>{await authenticateWallet("near",{link:true});refresh();})}>Link owner wallet</Action><Action type="button" busy={busy==="check"||busy==="poll"} disabled={!ownerAccount||!slug} onClick={()=>void run("check",async()=>{pollCount.current=0;await refreshCreation(ownerAccount,slug);})}>Check creation status</Action></div>
      </fieldset>
    </form>
    {quoted?<section className="space-y-4 rounded-lg border bg-muted/40 p-4">
      <div className="grid gap-4 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Treasury account</p><div className="mt-2"><Address value={quoted.quote.accountId} network={quoted.quote.network}/></div></div><div><p className="text-xs text-muted-foreground">Contract owner</p><div className="mt-2"><Address value={quoted.quote.ownerAccount} network={quoted.quote.network}/></div></div><div><p className="text-xs text-muted-foreground">Required wallet deposit</p><p className="mt-1 text-xl font-semibold">{near(quoted.quote.minimumDeposit)}</p></div><div><p className="text-xs text-muted-foreground">Payment policy</p><p className="mt-1 text-sm">{usd(quoted.quote.perPaymentLimit)} per payment</p><p className="text-sm">{usd(quoted.quote.dailyLimit)} per day</p></div></div>
      <p className="text-xs leading-5 text-muted-foreground">{near(quoted.quote.treasuryFunding)} goes to the treasury for code, initial state and its operating reserve. {near(quoted.quote.factoryStorageFee)} remains with the factory for its creation record. Wallet gas and USDC storage registration are additional. This creates an empty treasury and does not fund company USDC.</p>
      <details className="text-xs"><summary className="cursor-pointer">Verified contract details</summary><p className="mt-2 break-all">USDC contract: {quoted.quote.tokenContract}</p><p className="mt-1 break-all">Treasury code hash: {quoted.quote.treasuryCodeHash}</p><p className="mt-1 break-all">Factory code hash: {quoted.quote.factoryCodeHash}</p></details>
      <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" checked={acknowledged} disabled={!!busy} onChange={event=>setAcknowledged(event.target.checked)} className="mt-1.5"/>I reviewed the owner wallet, native NEAR deposit and USDC policy limits above.</label>
      <Action busy={busy==="create"} disabled={!canCreate||!!busy} onClick={()=>void run("create",create)}>Create treasury in my wallet</Action>
    </section>:null}
    {recorded?<section className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-3"><h3 className="text-sm font-medium">Factory creation status</h3><Status value={recorded.status}/></div><Address value={recorded.account_id} network={config?.network}/>
      {recorded.status==="pending"?<p className="text-sm text-muted-foreground">Creation is pending. FLOAT checks the factory before connecting the treasury. Reusing this wallet and name cannot schedule a second deployment.</p>:null}
      {recorded.status==="failed"?<><p className="text-sm text-muted-foreground">Deployment failed. The factory records a refund claim for {near(recorded.refund_amount)}. Its record storage fee is retained. Claiming costs 1 yoctoNEAR plus wallet gas.</p><Action busy={busy==="refund"} disabled={!!busy} onClick={()=>void run("refund",async()=>{const prepared=await api<{walletActions:NearWalletAction[]}>(`${base}/onboarding/refund`,{ownerAccount,slug});await sign(prepared.walletActions,ownerAccount,config!.network);pollCount.current=0;await refreshCreation(ownerAccount,slug);})}>Claim creation refund</Action></>:null}
      {recorded.status==="refunding"?<p className="text-sm text-muted-foreground">A refund transfer is pending. Check its final receipt before requesting recovery. A second refund is never unlocked on a timer.</p>:null}
      {recorded.status==="refunded"?<p className="text-sm text-muted-foreground">The refund completed. You can request a fresh deposit quote for this name.</p>:null}
      {result?.recoveryActions?.length?<Action busy={busy==="recover"} disabled={!!busy} onClick={()=>void run("recover",async()=>{await sign(result.recoveryActions!,ownerAccount,config!.network);pollCount.current=0;await refreshCreation(ownerAccount,slug);})}>Verify pending child on NEAR</Action>:null}
    </section>:result?.status==="not_requested"?<p role="status" className="text-sm text-muted-foreground">No creation is recorded for this wallet and treasury name.</p>:null}
    {txHash?<p className="break-all text-xs text-muted-foreground">Latest wallet transaction: {txHash}</p>:null}
    {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
  </div></Panel>;
}
