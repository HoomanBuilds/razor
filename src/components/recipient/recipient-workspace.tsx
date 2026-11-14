"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ReceiptText, Settings2, Users, Wallet } from "lucide-react";
import { useIdentity } from "../auth/identity-provider";
import { RecipientDashboard, type RecipientView } from "./recipient-dashboard";
import { PageMetrics, focusWorkspaceForm } from "../workspace/page-metrics";
import { WorkspaceTabs } from "../workspace/workspace-tabs";
import { useResource } from "../workspace/hooks";
import { AssetIdentity, TokenLogo } from "@/components/assets/asset-identity";
import { paymentLabel } from "@/lib/payment-label";
import { formatUnits, parseUnits } from "@/lib/money";
import { identityRequest, walletErrorMessage } from "../auth/wallets";
import { Action, Address, control, DataTable, Empty, Field, Panel, Status } from "../workspace/shared";
import { RecipientPortal } from "./recipient-portal";
import { NotificationInbox } from "../notifications/inbox";
import { PersonalExpenses } from "../personal-expenses";
import { PersonalProcurement } from "../personal-procurement";
import { RecipientDistributions } from "../recipient-distributions";
import { SupplierInvoiceCredits } from "../invoice-credits";
import { SupplierPrivateAgreements } from "../private-agreements/panels";
import { LenderFinancingPanel } from "../financing-lenders";

interface Profile {historicalOnly?:boolean;recipient:{id:string;name:string;kind:string;version:number;primary_asset:string;primary_network:string;primary_address:string;primary_memo?:string|null;backup_network:string|null;backup_address:string|null;fallback_consent:number;preference_status:string;confirmed_at:string|null;archived:number};company:{id:string;name:string}}
interface Attempt {destination_symbol?:string|null;destination_decimals?:number|null;confirmedOutputAtomic?:string|null;id:string;route:string;state:string;destination_asset:string;destination_network:string;destination_address:string;destination_memo?:string|null;expected_output:string;reportedOutputAtomic:string|null;destination_tx_hash:string|null;source_tx_hash:string|null;treasuryReceipt:string|null}
interface Payment {creditRetirement?:{noteId:string;billId:string;retiredAmount:string;acceptedCreditAmount:string;remainingLiability:string}|null;fundedClearing:{round_id:string;amount:string;mode:string;proof_block_hash:string;proof_block_height:string}|null;clearing:{round_id:string;amount:string;residual_payment_id:string|null;proof_block_hash:string;proof_block_height:string}|null;id:string;recipient_id:string;company:{id:string;name:string};reference:string;title:string|null;kind:string;amount:string;delivered_amount:string;status:string;periodStart:string|null;periodEnd:string|null;created_at:string;preference:{fallbackConsent:boolean;backupNetwork:string|null};attempts:Attempt[]}
interface InvoiceRequest {acceptedCreditUSDC?:string;settledUSDC:string;setoffUSDC:string;fundedDischargeUSDC:string;remainingUSDC:string|null;id:string;recipientId:string;status:string;billStatus:string|null;paymentStatus:string|null;createdAt:string;payload:{reference:string;amount:string;currency:string;dueDate?:string};review:{agreedUSDC:string}|null}
interface Workspace {profiles:Profile[]}
interface PaymentPage {payments:Payment[];total:number;page:number;pageSize:number;hasMore:boolean}
interface RequestPage {requests:InvoiceRequest[];total:number;page:number;pageSize:number;hasMore:boolean}
interface Asset {assetId:string;symbol:string;decimals:number;blockchain:string}
interface LineItem {description:string;quantity:string;unitPrice:string}

function Receipt({value,network}:{value:string;network?:string}) {
  const [copied,setCopied]=useState(false);
  const base=network==="near"?"https://nearblocks.io/txns/":network==="base"?"https://basescan.org/tx/":network==="eth"?"https://etherscan.io/tx/":network==="arb"?"https://arbiscan.io/tx/":network==="pol"?"https://polygonscan.com/tx/":network==="sol"?"https://solscan.io/tx/":undefined;
  return <span className="inline-flex max-w-full flex-wrap items-center gap-2 text-xs"><code className="break-all">{value.length>50?`${value.slice(0,24)}...${value.slice(-12)}`:value}</code><button type="button" className="underline" onClick={async()=>{try{await navigator.clipboard.writeText(value);setCopied(true);}catch{setCopied(false);}}}>{copied?"Copied":"Copy receipt"}</button>{base?<a href={`${base}${encodeURIComponent(value)}`} target="_blank" rel="noreferrer" className="underline">Explorer</a>:null}</span>;
}

function InvoiceSubmission({profiles,onSubmitted}:{profiles:Profile[];onSubmitted:()=>Promise<void>}) {
  const [recipientId,setRecipientId]=useState(""),[currency,setCurrency]=useState("USD"),[lineItems,setLineItems]=useState<LineItem[]>([{description:"",quantity:"1",unitPrice:""}]),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[success,setSuccess]=useState(false),lock=useRef(false);
  const suppliers=profiles.filter(profile=>!profile.historicalOnly&&["contractor","business"].includes(profile.recipient.kind)&&profile.recipient.preference_status==="confirmed"&&!profile.recipient.archived),selected=recipientId || suppliers[0]?.recipient.id || "";
  let lineTotal:string|null=null;
  try {const units=lineItems.reduce((sum,item)=>sum+BigInt(parseUnits(item.quantity,6))*BigInt(parseUnits(item.unitPrice,6)),0n);if(units%1000000n===0n)lineTotal=formatUnits((units/1000000n).toString(),6);}catch{}
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();if(lock.current)return;lock.current=true;setPending(true);setError(null);setSuccess(false);
    const form=event.currentTarget,values=new FormData(form);
    try {
      await identityRequest("/recipient-workspace/invoices",{recipientId:selected,reference:values.get("reference"),amount:values.get("amount"),currency,dueDate:values.get("dueDate") || undefined,commitmentReference:values.get("commitmentReference") || undefined,commitmentDate:values.get("commitmentDate") || undefined,lineItems,text:values.get("text") || undefined});
      await onSubmitted();form.reset();setLineItems([{description:"",quantity:"1",unitPrice:""}]);setSuccess(true);
    }catch(error){setError(walletErrorMessage(error));}finally{lock.current=false;setPending(false);}
  }
  return <Panel title="New invoice request" tone="white" description="Choose a payer and submit your invoice for finance review." help="Finance must explicitly agree a USDC liability before creating a payment draft. Submitting this request does not move funds.">{!suppliers.length?<Empty>Confirm an active contractor or supplier profile to submit an invoice.</Empty>:<form key={selected} className="space-y-4" onSubmit={submit}><fieldset disabled={pending} className="grid min-w-0 gap-4 border-0 p-0 sm:grid-cols-2">
    <Field label="Payer company"><select required className={control} value={selected} onChange={event=>{setRecipientId(event.target.value);setCurrency("USD");setLineItems([{description:"",quantity:"1",unitPrice:""}]);setError(null);setSuccess(false);}}>{suppliers.map(profile=><option key={profile.recipient.id} value={profile.recipient.id}>{profile.company.name} - {profile.recipient.name}</option>)}</select></Field>
    <Field label="Invoice reference"><input name="reference" required maxLength={120} className={control} placeholder="INV-2026-001"/></Field>
    <Field label="Invoice amount"><input name="amount" required inputMode="decimal" className={control} placeholder="0.00"/></Field>
    <Field label="Original invoice currency"><input required value={currency} onChange={event=>setCurrency(event.target.value.trim().toUpperCase())} pattern="[A-Z]{3,8}" maxLength={8} className={control} placeholder="USD, EUR, USDC..."/></Field>
    <Field label="Due date (optional)"><input type="date" name="dueDate" className={control}/></Field>
    <Field label="Purchase commitment reference (optional)" hint="A named PO is preserved for company review."><input name="commitmentReference" className={control} maxLength={120}/></Field>
    <Field label="Invoice service date (UTC)" hint="Required when naming a purchase commitment."><input name="commitmentDate" type="date" className={control}/></Field>
    <div className="sm:col-span-2 space-y-3"><p className="text-sm font-medium">Line items in {currency}</p>{lineItems.map((item,index)=><div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
      <Field label="Description"><input required maxLength={500} className={control} value={item.description} onChange={event=>setLineItems(current=>current.map((value,key)=>key===index?{...value,description:event.target.value}:value))}/></Field>
      <Field label="Quantity"><input required inputMode="decimal" className={control} value={item.quantity} onChange={event=>setLineItems(current=>current.map((value,key)=>key===index?{...value,quantity:event.target.value}:value))}/></Field>
      <Field label={`Unit price (${currency})`}><input required inputMode="decimal" className={control} value={item.unitPrice} onChange={event=>setLineItems(current=>current.map((value,key)=>key===index?{...value,unitPrice:event.target.value}:value))}/></Field>
      <Action type="button" disabled={lineItems.length===1} onClick={()=>setLineItems(current=>current.filter((_,key)=>key!==index))}>Remove</Action>
    </div>)}<Action type="button" disabled={lineItems.length>=100} onClick={()=>setLineItems(current=>[...current,{description:"",quantity:"1",unitPrice:""}])}>Add line item</Action><p className="text-xs text-muted-foreground">{lineTotal!==null?`Line total: ${lineTotal} ${currency}. The invoice amount must match.`:"Enter complete line items using up to six decimal places."}</p></div>
    <div className="sm:col-span-2"><Field label="Invoice text or supporting context (optional)"><textarea name="text" maxLength={5000} className={`${control} min-h-24`}/></Field></div>
    <div className="sm:col-span-2"><Action busy={pending}>Send for finance review</Action><p className="mt-2 text-xs text-muted-foreground">Foreign currency amounts are retained as submitted. They are never automatically converted into a company liability or payment.</p></div>
  </fieldset>{error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}{success?<p role="status" className="text-sm text-primary">Invoice request submitted. Your payer must review it before preparing a draft.</p>:null}</form>}</Panel>;
}

function HistoryPager({page,pageSize,total,hasMore,loading,label,onPage}:{page:number;pageSize:number;total:number;hasMore:boolean;loading:boolean;label:string;onPage:(page:number)=>void}) {
  if(!total)return null;
  return <nav aria-label={label} className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">{(page-1)*pageSize+1}-{Math.min(page*pageSize,total)} of {total}</p><div className="flex items-center gap-4"><button type="button" disabled={loading||page<=1} className="text-primary disabled:opacity-50" onClick={()=>onPage(page-1)}>Previous</button><span>Page {page}</span><button type="button" disabled={loading||!hasMore} className="text-primary disabled:opacity-50" onClick={()=>onPage(page+1)}>Next</button></div></nav>;
}

function PaymentHistory({payments,assets}:{payments:Payment[];assets:Asset[]}) {
  function output(amount:string,attempt:Attempt) {
    const asset=assets.find(item=>item.assetId===attempt.destination_asset);
    const decimals=attempt.destination_decimals ?? asset?.decimals,symbol=attempt.destination_symbol || asset?.symbol;
    return decimals!==undefined&&decimals!==null?`${formatUnits(amount,decimals)} ${symbol || "receiving asset"}`:`${amount} base units of ${attempt.destination_asset}`;
  }
  return <DataTable columns={["Payment","Entitlement","Delivered entitlement","Status and delivery"]}>{payments.map(payment=><tr key={payment.id}><td><p className="font-medium">{paymentLabel(payment)}</p><p className="mt-1 text-xs text-muted-foreground">{payment.company.name}</p>{payment.title?<p className="mt-1 text-xs">{payment.title}</p>:null}{payment.periodStart&&payment.periodEnd?<p className="mt-1 text-xs text-muted-foreground">Pay period {payment.periodStart} to {payment.periodEnd}</p>:null}</td><td className="whitespace-nowrap tabular-nums">{formatUnits(payment.amount,6)} USDC</td><td className="whitespace-nowrap tabular-nums">{formatUnits(payment.delivered_amount,6)} USDC</td><td><Status value={payment.status}/>{payment.creditRetirement&&<p className="mt-2 text-xs">This unsigned draft was retired after supplier credit acceptance. No tokens were sent. Accepted invoice credits: {formatUnits(payment.creditRetirement.acceptedCreditAmount,6)} USDC. Remaining invoice liability: {formatUnits(payment.creditRetirement.remainingLiability,6)} USDC. {BigInt(payment.creditRetirement.remainingLiability)>0n?"Any residual payment needs fresh preparation and approval.":"No remaining invoice payment is required."}</p>}{payment.clearing&&<p className="mt-2 text-xs">{formatUnits(payment.clearing.amount,6)} USDC of debt discharged with company consent. This retired payment delivered no tokens.{payment.clearing.residual_payment_id?" The remaining invoice uses a separate payment draft.":" No remaining invoice payment is required."}</p>}{payment.fundedClearing&&<p className="mt-2 text-xs">{formatUnits(payment.fundedClearing.amount,6)} USDC settled through consented company escrow. This retired payment delivered no tokens to this receiving profile. Company credit rights and withdrawals are separate.</p>}{payment.attempts.length?<div className="mt-3 space-y-3">{payment.attempts.map(attempt=><details key={attempt.id} className="rounded border p-3 text-xs"><summary className="cursor-pointer">{attempt.route==="backup"?"USDC backup attempt":"Primary attempt"} on {attempt.destination_network}: {attempt.state.replaceAll("_"," ")}</summary><div className="mt-3 space-y-2"><p>Quoted output: {output(attempt.expected_output,attempt)}</p>{attempt.confirmedOutputAtomic?<p className="font-medium">Recorded received amount: {output(attempt.confirmedOutputAtomic,attempt)}</p>:null}{attempt.reportedOutputAtomic?<p>Provider-reported output: {output(attempt.reportedOutputAtomic,attempt)}</p>:null}{attempt.confirmedOutputAtomic?<p className="text-muted-foreground">Recorded from final NEAR settlement evidence. External delivery attestations retain the treasury owner or reporter trust boundary.</p>:null}<AssetIdentity symbol={attempt.destination_symbol || assets.find(asset=>asset.assetId===attempt.destination_asset)?.symbol || "Receiving asset"} network={attempt.destination_network} assetId={attempt.destination_asset}/><Address value={attempt.destination_address} network={attempt.destination_network}/>{attempt.destination_memo!==null&&attempt.destination_memo!==undefined?<p>XRP tag: {attempt.destination_memo} (encoded in address)</p>:null}{attempt.destination_tx_hash?<div><p className="mb-1 text-muted-foreground">Destination transaction</p><Receipt value={attempt.destination_tx_hash} network={attempt.destination_network}/></div>:null}{attempt.source_tx_hash?<div><p className="mb-1 text-muted-foreground">NEAR source transaction</p><Receipt value={attempt.source_tx_hash} network="near"/></div>:null}{attempt.treasuryReceipt?<div><p className="mb-1 text-muted-foreground">Recorded settlement evidence</p><Receipt value={attempt.treasuryReceipt}/></div>:null}</div></details>)}</div>:<p className="mt-2 text-xs text-muted-foreground">{payment.creditRetirement?"Unsigned draft retired after a reviewed supplier credit; no payout route was used.":payment.fundedClearing?"NEAR escrow-backed company settlement recorded; no payout route was used.":payment.clearing?"NEAR debt discharge recorded; no payout route was used.":"No route has been prepared yet."}</p>}</td></tr>)}</DataTable>;
}

export function RecipientWorkspace() {
  const { session } = useIdentity();
  return <RecipientWorkspaceContent key={session?.user.id ?? "signed-out"}/>;
}

function RecipientWorkspaceContent() {
  const [view, setView] = useState<RecipientView>("overview");
  const [workspace,setWorkspace]=useState<Workspace|null>(null),[assets,setAssets]=useState<Asset[]>([]),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true),[selectedProfile,setSelectedProfile]=useState<string|null>(null);
  const [revision,setRevision]=useState(0),[paymentPage,setPaymentPage]=useState(1),[requestPage,setRequestPage]=useState(1),[profileFilter,setProfileFilter]=useState(""),[paymentId,setPaymentId]=useState("");
  const payments=useResource<PaymentPage>(`/recipient-workspace/payments?page=${paymentPage}&pageSize=50${profileFilter?`&recipientId=${encodeURIComponent(profileFilter)}`:""}`,revision);
  const requests=useResource<RequestPage>(`/recipient-workspace/invoices?page=${requestPage}&pageSize=50`,revision);
  const detail=useResource<{payment:Payment}>(paymentId?`/recipient-workspace/payments/${encodeURIComponent(paymentId)}`:null,revision);
  const load=useCallback(async()=>{
    setError(null);
    try {
      const [data,catalog]=await Promise.allSettled([identityRequest<Workspace>("/recipient-workspace/profiles"),identityRequest<{tokens:Asset[]}>("/assets")]);
      if(data.status!=="fulfilled")throw data.reason;
      setWorkspace(data.value);
      if(catalog.status==="fulfilled")setAssets(catalog.value.tokens);
      setRevision(value=>value+1);
    }catch(cause){setError(walletErrorMessage(cause));}finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    const readLocation=()=>{
      const params=new URLSearchParams(window.location.search),profileId=params.get("recipientId");
      setPaymentId(params.get("paymentId") || "");
      const next = params.get("view");
      const allowed: RecipientView[] = ["overview", "payments", "profiles", "invoices", "expenses", "purchasing", "distributions", "financing", "notifications"];
      setView(allowed.includes(next as RecipientView) ? next as RecipientView : params.get("paymentId") ? "payments" : profileId ? "profiles" : "overview");
      if(profileId&&workspace){
        const profile=workspace.profiles.find(profile=>profile.recipient.id===profileId);
        if(!profile){setError("This receiving profile is not linked to your account.");return;}
        setProfileFilter(profileId);setPaymentPage(1);
        if(!profile.historicalOnly&&!profile.recipient.archived)setSelectedProfile(profileId);
      }
    };
    readLocation();window.addEventListener("popstate",readLocation);
    return()=>window.removeEventListener("popstate",readLocation);
  },[workspace]);
  const closePayment=()=>{
    setPaymentId("");const url=new URL(window.location.href);url.searchParams.delete("paymentId");window.history.replaceState(null,"",url.pathname+url.search);
  };
  const editableProfile=workspace?.profiles.find(profile=>profile.recipient.id===selectedProfile&&!profile.historicalOnly&&!profile.recipient.archived);
  if(loading)return <p role="status" className="text-sm text-muted-foreground">Loading your private payment workspace...</p>;
  const navigate = (next: RecipientView) => {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.pushState(null, "", url.pathname + url.search);
  };
  const openProfile = (id: string) => {
    setSelectedProfile(id);
    const url = new URL(window.location.href);
    url.searchParams.set("recipientId", id);
    url.searchParams.set("view", "profiles");
    window.history.pushState(null, "", url.pathname + url.search);
    setView("profiles");
  };
  const closeProfile = () => {
    setSelectedProfile(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("recipientId");
    window.history.replaceState(null, "", url.pathname + url.search);
    void load();
  };
  const openPayment = (id: string) => {
    setPaymentId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("paymentId", id);
    url.searchParams.set("view", "payments");
    window.history.pushState(null, "", url.pathname + url.search);
    setView("payments");
  };
  const profile = workspace?.profiles.find(profile => profile.recipient.id === profileFilter);
  const companies = workspace ? new Set(workspace.profiles.map(profile => profile.company.id)).size : null;
  const metrics = [
    { label: "Payer companies", value: workspace ? companies : "Unavailable", detail: "Distinct companies in your receiving records" },
    { label: "Receiving profiles", value: workspace?.profiles.length ?? "Unavailable", detail: "Preferences are separate for each profile" },
    { label: "Payment records", value: payments.error ? "Unavailable" : payments.data?.total, detail: profile ? `${profile.company.name} profile only` : "Across all your payer profiles" },
    { label: "Invoice requests", value: requests.error ? "Unavailable" : requests.data?.total, detail: "Across all your payer profiles" },
  ];
  const overview = <div className="grid min-w-0 gap-8"><PageMetrics items={metrics}/><div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
    <Panel title="Payment snapshot" tone="muted" description={`Up to five records from payment history page ${paymentPage}${profile ? ` for ${profile.company.name}` : " across your payer profiles"}.`} action={<button className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-medium hover:bg-secondary" onClick={() => navigate("payments")}>All payments<ArrowUpRight size={13}/></button>}>
      {payments.error ? <p role="alert" className="text-sm text-destructive">{payments.error}</p> : payments.loading ? <Empty>Loading your payment records...</Empty> : !payments.data?.payments.length ? <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl bg-white/70 px-5 py-8 text-center"><span className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary"><Wallet size={24} strokeWidth={1.5}/></span><h2 className="mt-5 text-base font-medium">Your payments, in one place</h2><p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">Confirmed payer profiles and payment records will appear here. Use your company's invitation to get started.</p></div> : <DataTable columns={["Payment / company", "Entitlement", "Status", "Created"]}>{payments.data.payments.slice(0,5).map(payment => <tr key={payment.id}><td><button className="text-left font-medium hover:text-primary" onClick={() => openPayment(payment.id)}>{paymentLabel(payment)}<span className="mt-1 block text-xs font-normal text-muted-foreground">{payment.company.name}</span></button></td><td className="whitespace-nowrap tabular-nums">{formatUnits(payment.amount,6)} USDC</td><td><Status value={payment.status}/></td><td className="whitespace-nowrap text-xs text-muted-foreground">{new Date(payment.created_at).toLocaleDateString()}</td></tr>)}</DataTable>}
    </Panel>
    <div className="grid gap-5"><Panel title="Your next step"><div className="grid gap-2"><button onClick={() => navigate("profiles")} className="flex items-center gap-3 rounded-xl bg-white p-3 text-left hover:bg-secondary/50"><Users size={18} className="shrink-0 text-primary"/><span className="flex-1"><span className="block text-xs font-medium">Manage payout profiles</span><span className="mt-1 block text-[11px] text-muted-foreground">Choose how each company pays you</span></span><ArrowUpRight size={14}/></button><button onClick={() => { navigate("invoices"); focusWorkspaceForm("receiver-invoice-compose"); }} className="flex items-center gap-3 rounded-xl bg-white p-3 text-left hover:bg-secondary/50"><ReceiptText size={18} className="shrink-0 text-primary"/><span className="flex-1"><span className="block text-xs font-medium">Submit an invoice</span><span className="mt-1 block text-[11px] text-muted-foreground">Send a request to your payer company</span></span><ArrowUpRight size={14}/></button></div></Panel>
      <section className="rounded-[1.25rem] bg-primary p-6 text-white"><div className="flex items-center justify-between gap-3"><h2 className="text-base font-medium">Receiving your money</h2><TokenLogo symbol="USDC" size={24}/></div><p className="mt-4 text-sm leading-6 text-white/90">Your company records entitlements in USDC. You receive your confirmed supported asset, or your consented USDC backup.</p><button onClick={() => navigate("profiles")} className="mt-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-xs font-medium hover:bg-white/25"><Settings2 size={13}/>Review preferences</button></section>
    </div>
  </div></div>;
  return <RecipientDashboard active={view} onNavigate={navigate} onRefresh={() => void load()} notice={error ? <p role="alert" className="mb-5 rounded-xl border border-destructive/20 bg-white p-4 text-sm text-destructive">{error}</p> : null} views={{
    overview,
    payments: <div className="grid min-w-0 gap-6">{paymentId&&<Panel title="Selected payment" action={<button type="button" className="text-sm text-primary" onClick={closePayment}>Close payment</button>}>{detail.error?<p role="alert" className="text-sm text-destructive">{detail.error}</p>:detail.data?<PaymentHistory payments={[detail.data.payment]} assets={assets}/>:<Empty>Loading the selected payment...</Empty>}</Panel>}<Panel title="My payment history" tone="white" description="Filter your payment records by payer profile." help="USDC entitlement is separate from the received asset and network. Recorded settlement and provider reports are identified separately."><Field label="Payment history scope"><select className={control} value={profileFilter} onChange={event=>{setProfileFilter(event.target.value);setPaymentPage(1);}}><option value="">All my payer profiles</option>{workspace?.profiles.map(profile=><option key={profile.recipient.id} value={profile.recipient.id}>{profile.company.name} - {profile.recipient.name}</option>)}</select></Field>{payments.error?<p role="alert" className="mt-4 text-sm text-destructive">{payments.error}</p>:null}<div className="mt-4">{payments.loading?<Empty>Loading your payments...</Empty>:payments.data?.payments.length?<PaymentHistory payments={payments.data.payments} assets={assets}/>:<Empty>No payments have been created for these linked profiles yet.</Empty>}</div>{payments.data&&<HistoryPager {...payments.data} loading={payments.loading} label="Payment history pages" onPage={setPaymentPage}/>}</Panel></div>,
    profiles: <div className="grid min-w-0 gap-6">{selectedProfile&&editableProfile?<Panel title={`${editableProfile.company.name}: receiving preferences`} tone="white" action={<Action className="border border-border bg-white text-foreground hover:bg-muted" onClick={closeProfile}>Close and refresh</Action>}><RecipientPortal key={selectedProfile} recipientId={selectedProfile} showHistory={false}/></Panel>:null}<Panel title="Your payer companies" tone="white" description="Each company has its own receiving profile and confirmed preferences.">{workspace?.profiles.length?<div className="grid gap-4 sm:grid-cols-2">{workspace.profiles.map(({recipient,company,historicalOnly})=><section key={recipient.id} className="min-w-0 space-y-4 rounded-2xl border border-border bg-muted/50 p-5"><div><h2 className="text-lg font-medium tracking-tight">{company.name}</h2><p className="text-sm text-muted-foreground">{recipient.name} - {recipient.kind}</p></div><div className="flex flex-wrap gap-2"><Status value={historicalOnly?"historical_read_only":recipient.archived?"archived":recipient.preference_status}/><span className="text-xs text-muted-foreground">Version {recipient.version}</span></div><AssetIdentity symbol={assets.find(asset=>asset.assetId===recipient.primary_asset)?.symbol || recipient.primary_asset} network={recipient.primary_network} assetId={recipient.primary_asset}/><Address value={recipient.primary_address} network={recipient.primary_network}/>{recipient.primary_memo!==null&&recipient.primary_memo!==undefined?<p className="text-xs">XRP tag: {recipient.primary_memo} (encoded in address)</p>:null}<div className="grid gap-2">{recipient.backup_network?<AssetIdentity symbol="USDC" network={recipient.backup_network}/>:<p className="text-xs text-muted-foreground">USDC backup not selected</p>}<p className="text-xs text-muted-foreground">Backup consent: {recipient.fallback_consent?"consented":"not consented"}</p></div>{!recipient.archived&&!historicalOnly?<Action onClick={()=>openProfile(recipient.id)}>Manage payout preferences</Action>:null}{historicalOnly?<p className="text-xs text-muted-foreground">This saved profile is shown for your earlier records. It cannot be edited or used for new invoice requests.</p>:null}</section>)}</div>:<Empty>No confirmed payee profiles are linked to this account yet. Open your payer's invitation and verify the receiving wallet or email first.</Empty>}</Panel></div>,
    invoices: <div className="grid min-w-0 gap-6"><Panel title="Invoice requests" tone="white" description="Your submitted invoices and each payer company's finance review.">{requests.error?<p role="alert" className="mb-4 text-sm text-destructive">{requests.error}</p>:null}{requests.loading?<Empty>Loading invoice requests...</Empty>:requests.data?.requests.length?<DataTable columns={["Invoice","Submitted amount","Review and payment"]}>{requests.data.requests.map(request=><tr key={request.id}><td><p className="font-medium">{request.payload.reference}</p><p className="mt-1 text-xs text-muted-foreground">{workspace?.profiles.find(profile=>profile.recipient.id===request.recipientId)?.company.name}</p>{request.payload.dueDate?<p className="mt-1 text-xs">Due {request.payload.dueDate}</p>:null}</td><td>{request.payload.amount} {request.payload.currency}</td><td><Status value={request.billStatus || request.status}/>{request.review?<p className="mt-2 text-xs">Finance agreed {formatUnits(request.review.agreedUSDC,6)} USDC for the draft.</p>:<p className="mt-2 text-xs text-muted-foreground">Awaiting human finance review. No company liability has been created.</p>}{request.remainingUSDC!==null&&<p className="mt-2 text-xs">Delivered: {formatUnits(request.settledUSDC,6)} USDC. Accepted supplier credits: {formatUnits(request.acceptedCreditUSDC??"0",6)} USDC. Noncash debt discharge: {formatUnits(request.setoffUSDC,6)} USDC. Escrow-backed discharge: {formatUnits(request.fundedDischargeUSDC??"0",6)} USDC. Remaining: {formatUnits(request.remainingUSDC,6)} USDC.</p>}</td></tr>)}</DataTable>:<Empty>No invoice requests submitted.</Empty>}{requests.data&&<HistoryPager {...requests.data} loading={requests.loading} label="Invoice request pages" onPage={setRequestPage}/>}</Panel><div id="receiver-invoice-compose" className="scroll-mt-6"><InvoiceSubmission profiles={workspace?.profiles || []} onSubmitted={async()=>{setRequestPage(1);await load();}}/></div><Panel collapsible title="Supplier credits" description="Review credit notes separately from token delivery."><SupplierInvoiceCredits refreshRevision={revision}/></Panel></div>,
    expenses: <PersonalExpenses refreshRevision={revision}/>,
    purchasing: <WorkspaceTabs tabs={[{label:"Supplier invitations",content:<PersonalProcurement refreshRevision={revision} assets={assets}/>},{label:"Private agreements",content:<SupplierPrivateAgreements refreshRevision={revision} assets={assets}/>}]} />,
    distributions: <RecipientDistributions revision={revision}/>,
    financing: <LenderFinancingPanel />,
    notifications: <NotificationInbox/>,
  }}/>;
}
