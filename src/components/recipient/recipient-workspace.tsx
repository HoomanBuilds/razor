"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Plus, ReceiptText, Trash2, Users, Wallet } from "lucide-react";
import { useIdentity } from "../auth/identity-provider";
import { RecipientDashboard, type RecipientView } from "./recipient-dashboard";
import { proportion, type PaymentActivity } from "@/lib/payment-activity";
import { ActivityChart, AttentionCard, CompositionCard, FinanceCard, InsightState } from "../workspace/dashboard-visuals";
import { PageMetrics } from "../workspace/page-metrics";
import { WorkspaceTabs } from "../workspace/workspace-tabs";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer } from "../workspace/task-drawer";
import { useResource } from "../workspace/hooks";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { paymentLabel } from "@/lib/payment-label";
import { formatUnits, parseUnits } from "@/lib/money";
import { identityRequest, walletErrorMessage } from "../auth/wallets";
import { Action, Address, control, Empty, Field, Panel, Status } from "../workspace/shared";
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
  useEffect(()=>setCopied(false),[value]);
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
  if(success)return <div className="space-y-5 rounded-2xl bg-muted/60 p-5"><ReceiptText className="text-primary" size={28}/><h2 className="text-lg font-medium">Invoice submitted</h2><p className="text-sm text-muted-foreground">Awaiting review from your payer.</p><div className="flex flex-wrap gap-3"><Action type="button" onClick={()=>closeTaskDrawer("receiver-invoice-task")}>Done</Action><button type="button" className="text-sm text-primary" onClick={()=>setSuccess(false)}>New invoice</button></div></div>;
  return !suppliers.length?<Empty>Confirm a contractor or supplier profile to submit an invoice.</Empty>:<form key={selected} aria-busy={pending} className="space-y-6" onSubmit={submit}><fieldset disabled={pending} className="min-w-0 space-y-6 border-0 p-0">
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Payer company"><select required className={control} value={selected} onChange={event=>{setRecipientId(event.target.value);setCurrency("USD");setLineItems([{description:"",quantity:"1",unitPrice:""}]);setError(null);setSuccess(false);}}>{suppliers.map(profile=><option key={profile.recipient.id} value={profile.recipient.id}>{profile.company.name} - {profile.recipient.name}</option>)}</select></Field>
    <Field label="Invoice reference"><input name="reference" required maxLength={120} className={control} placeholder="INV-2026-001"/></Field></div>
    <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3"><Field label="Invoice amount"><input name="amount" required inputMode="decimal" className={control} placeholder="0.00"/></Field><Field label="Currency"><input required value={currency} onChange={event=>setCurrency(event.target.value.trim().toUpperCase())} pattern="[A-Z]{3,8}" maxLength={8} className={control} placeholder="USD"/></Field></div>
    <section className="space-y-3"><h2 className="text-sm font-medium">Line items</h2>{lineItems.map((item,index)=><div key={index} className="grid grid-cols-2 gap-3 rounded-2xl bg-muted/60 p-4">
      <div className="col-span-2 flex items-end gap-2"><div className="min-w-0 flex-1"><Field label={`Item ${index+1}`}><input required maxLength={500} className={control} value={item.description} onChange={event=>setLineItems(current=>current.map((value,key)=>key===index?{...value,description:event.target.value}:value))}/></Field></div><button type="button" aria-label={`Remove item ${index+1}`} disabled={lineItems.length===1} className="grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-white disabled:opacity-30" onClick={()=>setLineItems(current=>current.filter((_,key)=>key!==index))}><Trash2 size={16}/></button></div>
      <Field label="Quantity"><input required inputMode="decimal" className={control} value={item.quantity} onChange={event=>setLineItems(current=>current.map((value,key)=>key===index?{...value,quantity:event.target.value}:value))}/></Field>
      <Field label={`Unit price (${currency})`}><input required inputMode="decimal" className={control} value={item.unitPrice} onChange={event=>setLineItems(current=>current.map((value,key)=>key===index?{...value,unitPrice:event.target.value}:value))}/></Field>
    </div>)}<div className="flex flex-wrap items-center justify-between gap-3"><button type="button" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary disabled:opacity-50" disabled={lineItems.length>=100} onClick={()=>setLineItems(current=>[...current,{description:"",quantity:"1",unitPrice:""}])}><Plus size={15}/>Add item</button>{lineTotal!==null&&<span className="text-sm tabular-nums">Total {lineTotal} {currency}</span>}</div></section>
    <details className="border-y py-4"><summary className="cursor-pointer text-sm font-medium">Due date, purchase order & notes</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Due date"><input type="date" name="dueDate" className={control}/></Field><Field label="Purchase reference"><input name="commitmentReference" className={control} maxLength={120}/></Field><Field label="Service date (UTC)" hint="Required for a purchase reference."><input name="commitmentDate" type="date" className={control}/></Field><div className="sm:col-span-2"><Field label="Supporting notes"><textarea name="text" maxLength={5000} className={`${control} min-h-24`}/></Field></div></div></details>
    <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">Payer reviews before payment.</span><Action busy={pending}>Submit invoice</Action></div>
  </fieldset>{error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}</form>;
}

function HistoryPager({page,pageSize,total,hasMore,loading,label,onPage}:{page:number;pageSize:number;total:number;hasMore:boolean;loading:boolean;label:string;onPage:(page:number)=>void}) {
  if(!total)return null;
  return <nav aria-label={label} className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">{(page-1)*pageSize+1}-{Math.min(page*pageSize,total)} of {total}</p><div className="flex items-center gap-4"><button type="button" disabled={loading||page<=1} className="text-primary disabled:opacity-50" onClick={()=>onPage(page-1)}>Previous</button><span>Page {page}</span><button type="button" disabled={loading||!hasMore} className="text-primary disabled:opacity-50" onClick={()=>onPage(page+1)}>Next</button></div></nav>;
}

function PaymentHistory({payments,onSelect}:{payments:Payment[];onSelect:(id:string)=>void}) {
  return <div className="divide-y">{payments.map(payment=><div key={payment.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"><div className="min-w-0"><p className="truncate text-sm font-medium">{paymentLabel(payment)}</p><p className="mt-1 text-xs text-muted-foreground">{payment.company.name}</p></div><p className="max-w-[44vw] break-words text-right text-sm font-medium tabular-nums sm:max-w-[16rem]">{formatUnits(payment.amount,6)} <span className="text-xs font-normal text-muted-foreground">USDC</span></p><div><Status value={payment.status}/></div><button type="button" className="justify-self-end rounded-full bg-muted px-4 py-2 text-xs font-medium hover:bg-secondary" onClick={()=>onSelect(payment.id)}>Review</button></div>)}</div>;
}

function PaymentDetail({payment,assets}:{payment:Payment;assets:Asset[]}) {
  const [attemptId,setAttemptId]=useState(payment.attempts[0]?.id ?? "");
  const attempt=payment.attempts.find(item=>item.id===attemptId) ?? payment.attempts[0],fullyDelivered=BigInt(payment.delivered_amount)>0n&&BigInt(payment.delivered_amount)===BigInt(payment.amount);
  function output(amount:string,row:Attempt) {
    const asset=assets.find(item=>item.assetId===row.destination_asset),decimals=row.destination_decimals ?? asset?.decimals,symbol=row.destination_symbol || asset?.symbol;
    return decimals!==undefined&&decimals!==null?`${formatUnits(amount,decimals)} ${symbol || "receiving asset"}`:`${amount} base units`;
  }
  return <div className="space-y-5"><section className="workspace-panel p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs text-muted-foreground">{payment.company.name}</p><h2 className="mt-2 text-xl font-medium">{paymentLabel(payment)}</h2>{payment.title&&<p className="mt-1 text-sm text-muted-foreground">{payment.title}</p>}</div><Status value={payment.status}/></div><div className="mt-6 grid grid-cols-2 gap-4"><div><p className="text-xs text-muted-foreground">{fullyDelivered?"Delivered entitlement":"Net entitlement"}</p><p className="mt-2 break-words text-2xl font-medium tabular-nums">{formatUnits(payment.amount,6)} <span className="text-sm text-muted-foreground">USDC</span></p></div>{BigInt(payment.delivered_amount)>0n&&!fullyDelivered&&<div><p className="text-xs text-muted-foreground">Delivered entitlement</p><p className="mt-2 break-words text-lg font-medium tabular-nums">{formatUnits(payment.delivered_amount,6)} USDC</p></div>}</div>{payment.periodStart&&payment.periodEnd&&<p className="mt-5 text-xs text-muted-foreground">Pay period: {payment.periodStart} to {payment.periodEnd}</p>}
    {payment.creditRetirement&&<section className="mt-5 rounded-2xl bg-white p-4"><h3 className="text-sm font-medium">Supplier credit accepted</h3><dl className="mt-3 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-muted-foreground">Invoice credit</dt><dd className="mt-1">{formatUnits(payment.creditRetirement.acceptedCreditAmount,6)} USDC</dd></div><div><dt className="text-xs text-muted-foreground">Invoice remaining</dt><dd className="mt-1">{formatUnits(payment.creditRetirement.remainingLiability,6)} USDC</dd></div></dl><p className="mt-3 text-xs text-muted-foreground">Draft retired. No tokens sent.</p></section>}
    {payment.clearing&&<section className="mt-5 rounded-2xl bg-white p-4"><h3 className="text-sm font-medium">Noncash debt offset</h3><p className="mt-2 font-medium">{formatUnits(payment.clearing.amount,6)} USDC</p><p className="mt-2 text-xs text-muted-foreground">Consented by both companies. No tokens delivered.{payment.clearing.residual_payment_id?" Remaining debt uses a separate payment.":" No remaining payment."}</p></section>}
    {payment.fundedClearing&&<section className="mt-5 rounded-2xl bg-white p-4"><h3 className="text-sm font-medium">Company escrow discharge</h3><p className="mt-2 font-medium">{formatUnits(payment.fundedClearing.amount,6)} USDC</p><p className="mt-2 text-xs text-muted-foreground">No tokens delivered to this profile. Company withdrawals are separate.</p></section>}
    <p className="mt-4 text-xs text-muted-foreground">Created {new Date(payment.created_at).toLocaleDateString()}</p></section>
    {attempt?<section className="workspace-panel workspace-panel-white p-5 sm:p-6"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">Delivery</h2>{payment.attempts.length>1?<select aria-label="Delivery attempt" value={attempt.id} className={`${control} max-w-full sm:w-auto`} onChange={event=>setAttemptId(event.target.value)}>{payment.attempts.map((item,index)=><option key={item.id} value={item.id}>{index+1}. {item.route==="backup"?"USDC backup":"Primary route"} · {item.state.replaceAll("_"," ")}</option>)}</select>:<Status value={attempt.state}/>}</div><div className="grid gap-5 sm:grid-cols-2"><div className="min-w-0"><p className="mb-2 text-xs text-muted-foreground">{attempt.route==="backup"?"USDC backup":"Receiving destination"}</p><AssetIdentity symbol={attempt.destination_symbol || assets.find(asset=>asset.assetId===attempt.destination_asset)?.symbol || "Receiving asset"} network={attempt.destination_network} assetId={attempt.destination_asset}/><div className="mt-3"><Address value={attempt.destination_address} network={attempt.destination_network} full/></div>{attempt.destination_memo!==null&&attempt.destination_memo!==undefined&&<p className="mt-2 break-all text-sm">Memo / tag: {attempt.destination_memo}</p>}</div><dl className="space-y-4 rounded-2xl bg-muted/60 p-4">{attempt.confirmedOutputAtomic&&<div><dt className="text-xs text-muted-foreground">Recorded received</dt><dd className="mt-1 break-words text-lg font-medium tabular-nums">{output(attempt.confirmedOutputAtomic,attempt)}</dd></div>}{attempt.reportedOutputAtomic&&<div><dt className="text-xs text-muted-foreground">Provider reported</dt><dd className="mt-1 break-words text-sm tabular-nums">{output(attempt.reportedOutputAtomic,attempt)}</dd></div>}<div><dt className="text-xs text-muted-foreground">Quoted output</dt><dd className="mt-1 break-words text-sm tabular-nums">{output(attempt.expected_output,attempt)}</dd></div></dl></div><details className="mt-5 border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Receipts & identifiers</summary><div className="mt-4 space-y-4">{attempt.confirmedOutputAtomic&&<p className="text-muted-foreground">Recorded from NEAR settlement evidence; external delivery relies on the company reporter.</p>}{attempt.destination_tx_hash&&<div><p className="mb-2 text-muted-foreground">Destination transaction</p><Receipt value={attempt.destination_tx_hash} network={attempt.destination_network}/></div>}{attempt.source_tx_hash&&<div><p className="mb-2 text-muted-foreground">NEAR transaction</p><Receipt value={attempt.source_tx_hash} network="near"/></div>}{attempt.treasuryReceipt&&<div><p className="mb-2 text-muted-foreground">Settlement evidence</p><Receipt value={attempt.treasuryReceipt}/></div>}<div><p className="mb-2 text-muted-foreground">Payment ID</p><Address value={payment.id} label="payment ID"/></div><div><p className="mb-2 text-muted-foreground">Receiving asset ID</p><Address value={attempt.destination_asset} label="asset ID"/></div></div></details></section>:!payment.creditRetirement&&!payment.clearing&&!payment.fundedClearing?<Empty>Your payer has not prepared a delivery route yet.</Empty>:null}
  </div>;
}

function InvoiceDetail({request,company}:{request:InvoiceRequest;company?:string}) {
  const facts=[{label:"Delivered",value:request.settledUSDC},{label:"Supplier credits",value:request.acceptedCreditUSDC ?? "0"},{label:"Noncash debt offset",value:request.setoffUSDC},{label:"Escrow discharge",value:request.fundedDischargeUSDC ?? "0"}].filter(item=>BigInt(item.value)>0n);
  return <div className="space-y-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">{company}</p><h2 className="mt-2 text-xl font-medium">{request.payload.reference}</h2></div><Status value={request.billStatus || request.status}/></div><div className="rounded-2xl bg-muted/60 p-5"><p className="text-xs text-muted-foreground">Submitted invoice</p><p className="mt-2 break-words text-2xl font-medium tabular-nums">{request.payload.amount} <span className="text-sm text-muted-foreground">{request.payload.currency}</span></p>{request.payload.dueDate&&<p className="mt-3 text-xs text-muted-foreground">Due {request.payload.dueDate}</p>}</div>{request.review?<dl className="grid grid-cols-2 gap-5"><div><dt className="text-xs text-muted-foreground">Agreed by payer</dt><dd className="mt-2 break-words font-medium">{formatUnits(request.review.agreedUSDC,6)} USDC</dd></div>{request.remainingUSDC!==null&&<div><dt className="text-xs text-muted-foreground">Remaining</dt><dd className="mt-2 break-words font-medium">{formatUnits(request.remainingUSDC,6)} USDC</dd></div>}</dl>:<p className="rounded-xl bg-muted/60 p-4 text-sm">Awaiting payer review. No payment obligation yet.</p>}{request.paymentStatus&&<div className="flex items-center justify-between gap-3"><span className="text-sm">Payment</span><Status value={request.paymentStatus}/></div>}{facts.length>0&&<dl className="space-y-3 border-t pt-4">{facts.map(item=><div key={item.label} className="flex flex-wrap justify-between gap-2 text-sm"><dt className="text-muted-foreground">{item.label}</dt><dd className="font-medium tabular-nums">{formatUnits(item.value,6)} USDC</dd></div>)}</dl>}</div>;
}

export function RecipientWorkspace() {
  const { session } = useIdentity();
  return <RecipientWorkspaceContent key={session?.user.id ?? "signed-out"}/>;
}

function RecipientWorkspaceContent() {
  const [view, setView] = useState<RecipientView>("overview");
  const accountHref = `/account?returnTo=${encodeURIComponent(typeof window === "undefined" ? "/receive" : window.location.pathname + window.location.search)}`;
  const [workspace,setWorkspace]=useState<Workspace|null>(null),[assets,setAssets]=useState<Asset[]>([]),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true),[selectedProfile,setSelectedProfile]=useState<string|null>(null);
  const [revision,setRevision]=useState(0),[paymentPage,setPaymentPage]=useState(1),[requestPage,setRequestPage]=useState(1),[profileFilter,setProfileFilter]=useState(""),[paymentId,setPaymentId]=useState(""),[selectedInvoiceId,setSelectedInvoiceId]=useState<string|null>(null),[invoiceTab,setInvoiceTab]=useState(0);
  const payments=useResource<PaymentPage>(`/recipient-workspace/payments?page=${paymentPage}&pageSize=50${profileFilter?`&recipientId=${encodeURIComponent(profileFilter)}`:""}`,revision);
  const activity=useResource<PaymentActivity>(`/recipient-workspace/summary${profileFilter?`?recipientId=${encodeURIComponent(profileFilter)}`:""}`,revision);
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
  if(loading)return <p role="status" className="text-sm text-muted-foreground">Loading your workspace...</p>;
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
  const profiles = workspace?.profiles ?? [];
  const currentProfiles = profiles.filter(profile => !profile.historicalOnly && !profile.recipient.archived);
  const confirmed = currentProfiles.filter(profile => profile.recipient.preference_status === "confirmed");
  const backups = confirmed.filter(profile => profile.recipient.fallback_consent === 1 && profile.recipient.backup_network && profile.recipient.backup_address);
  const confirmedCompanies = new Set(confirmed.map(profile => profile.company.id)).size;
  const shownReviewed = requests.data?.requests.filter(request => request.review !== null).length ?? 0;
  const chart = activity.error ? null : activity.data;
  const profilesReady = !!workspace && !error;
  const metrics = [
    { label: "Payer companies", value: profilesReady ? companies : "Unavailable", progress: profilesReady ? { value: proportion(confirmedCompanies,companies ?? 0), label: "With confirmed profiles", detail: `${confirmedCompanies} / ${companies ?? 0}` } : undefined },
    { label: "Receiving profiles", value: profilesReady ? profiles.length : "Unavailable", progress: profilesReady ? { value: proportion(confirmed.length,profiles.length), label: "Confirmed profiles", detail: `${confirmed.length} / ${profiles.length}` } : undefined },
    { label: "Payment records", value: activity.error ? "Unavailable" : chart?.total, progress: chart ? { value: proportion(chart.states.settled,chart.total), label: "Paid", detail: `${chart.states.settled} / ${chart.total}` } : undefined },
    { label: "Invoice requests", value: requests.error ? "Unavailable" : requests.data?.total, progress: requests.data ? { value: proportion(shownReviewed,requests.data.requests.length), label: "Reviewed on this page", detail: `${shownReviewed} / ${requests.data.requests.length}` } : undefined },
  ];
  const overview = <div className="grid min-w-0 gap-5"><PageMetrics items={metrics}/>
    {activity.error && <p role="alert" className="text-xs text-destructive">Payment activity: {activity.error}</p>}
    {chart && profilesReady ? <div className="dashboard-visual-grid">
      <ActivityChart activity={chart} action={() => navigate("payments")} scope={`${profile ? `${profile.company.name}: selected profile` : "All your payer profiles"}${activity.data ? "" : " · Shown payment page"}`}/>
      <CompositionCard title="Payout profiles" total={profiles.length} action={() => navigate("profiles")} detail="Profile readiness" items={[{label:"Confirmed",value:confirmed.length},{label:"USDC backup",value:backups.length},{label:"Historical",value:profiles.length-currentProfiles.length}]}/>
      <AttentionCard detail="Payer action needed" action={() => navigate("payments")} items={[{label:"Drafts",value:chart.statuses.draft ?? 0,status:"open"},{label:"Needs funds",value:chart.statuses.approved_unfunded ?? 0,status:"review"},{label:"Held / partial",value:(chart.statuses.held ?? 0)+(chart.statuses.partially_paid ?? 0),status:"review"}]}/>
    </div> : <InsightState titles={["Payment activity","Payout profiles","Needs attention"]} error={!!activity.error || !!error}/>}
    <div className="dashboard-lower-grid"><div className="dashboard-recent-card min-w-0"><Panel title={paymentPage === 1 ? "Recent payments" : "Payment records"} tone="muted"  action={<button className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-medium hover:bg-secondary" onClick={() => navigate("payments")}>All payments<ArrowUpRight size={13}/></button>}>
      {payments.error ? <p role="alert" className="text-sm text-destructive">{payments.error}</p> : payments.loading ? <Empty>Loading your payment records...</Empty> : !payments.data?.payments.length ? <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl bg-white/70 px-5 py-8 text-center"><span className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary"><Wallet size={24} strokeWidth={1.5}/></span><h2 className="mt-5 text-base font-medium">Your payments, in one place</h2><p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">Open your payer's invitation to get started.</p></div> : <PaymentHistory payments={payments.data.payments.slice(0,3)} onSelect={openPayment}/>}
    </Panel></div>
      <FinanceCard title="Payout readiness" value={profilesReady ? <>{confirmed.length}<span className="text-2xl text-white/55"> / {profiles.length}</span></> : "Unavailable"} unit="Confirmed receiving profiles" meter={{value:proportion(confirmed.length,profiles.length),label:profilesReady ? `${confirmed.length} confirmed of ${profiles.length} saved receiving profiles` : "Receiving profiles unavailable",left:"Confirmed",right:profilesReady ? `${confirmed.length} / ${profiles.length}` : "Unavailable"}} stats={[{label:"Payer companies",value:profilesReady ? companies : "..."},{label:"USDC backups",value:profilesReady ? backups.length : "..."},{label:"Current profiles",value:profilesReady ? currentProfiles.length : "..."}]} action={<button className="dashboard-glass-button" aria-label="Review payout profiles" onClick={() => navigate("profiles")}><ArrowUpRight size={17}/></button>}/>
    </div>
    <div className="flex flex-wrap gap-2"><button onClick={() => navigate("profiles")} className="inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2.5 text-xs hover:bg-secondary"><Users size={14}/>Payout profiles<ArrowUpRight size={12}/></button><button onClick={() => { navigate("invoices"); setInvoiceTab(0); requestAnimationFrame(()=>{if(new URLSearchParams(window.location.search).get("view")==="invoices")openTaskDrawer("receiver-invoice-task");}); }} className="inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2.5 text-xs hover:bg-secondary"><ReceiptText size={14}/>Submit an invoice<ArrowUpRight size={12}/></button></div>
  </div>;
  return <RecipientDashboard active={view} onNavigate={navigate} onRefresh={() => void load()} notice={error ? <p role="alert" className="mb-5 rounded-xl border border-destructive/20 bg-white p-4 text-sm text-destructive">{error}</p> : null} views={{
    overview,
    payments: paymentId?<div className="space-y-5"><button type="button" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground" onClick={closePayment}><ArrowLeft size={16}/>All payments</button>{detail.error?<p role="alert" className="text-sm text-destructive">{detail.error}</p>:detail.data?<PaymentDetail key={detail.data.payment.id} payment={detail.data.payment} assets={assets}/>:<Empty>Loading payment...</Empty>}</div>:<section className="workspace-panel workspace-panel-white p-5 sm:p-6"><div className="mb-6 max-w-sm"><Field label="Payer company"><select className={control} value={profileFilter} onChange={event=>{setProfileFilter(event.target.value);setPaymentPage(1);}}><option value="">All companies</option>{workspace?.profiles.map(profile=><option key={profile.recipient.id} value={profile.recipient.id}>{profile.company.name} - {profile.recipient.name}</option>)}</select></Field></div>{payments.error?<p role="alert" className="mb-4 text-sm text-destructive">{payments.error}</p>:null}{payments.loading?<Empty>Loading payments...</Empty>:payments.data?.payments.length?<PaymentHistory payments={payments.data.payments} onSelect={openPayment}/>:<Empty>No payments yet.</Empty>}{payments.data&&<HistoryPager {...payments.data} loading={payments.loading} label="Payment history pages" onPage={setPaymentPage}/>}</section>,
    profiles: selectedProfile&&editableProfile?<div className="space-y-5"><button type="button" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground" onClick={closeProfile}><ArrowLeft size={16}/>All profiles</button><h2 className="text-xl font-medium">{editableProfile.company.name}</h2><RecipientPortal key={selectedProfile} recipientId={selectedProfile} showHistory={false}/></div>:workspace?.profiles.length?<div className="grid gap-4 xl:grid-cols-2">{workspace.profiles.map(({recipient,company,historicalOnly})=><section key={recipient.id} className="workspace-panel min-w-0 p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-medium">{company.name}</h2><p className="mt-1 text-xs text-muted-foreground">{recipient.name} · {recipient.kind}</p></div><Status value={historicalOnly?"historical_read_only":recipient.archived?"archived":recipient.preference_status}/></div><div className="mt-5"><AssetIdentity symbol={assets.find(asset=>asset.assetId===recipient.primary_asset)?.symbol || "Receiving asset"} network={recipient.primary_network} assetId={recipient.primary_asset}/></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{recipient.fallback_consent&&recipient.backup_network&&recipient.backup_address?"USDC backup enabled":"USDC backup off"}</p>{!recipient.archived&&!historicalOnly&&<button type="button" className="rounded-full bg-white px-4 py-2 text-xs font-medium hover:bg-secondary" onClick={()=>openProfile(recipient.id)}>Manage profile</button>}</div><details className="mt-4 border-t pt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Receiving details</summary><div className="mt-4 space-y-3"><Address value={recipient.primary_address} network={recipient.primary_network} full/>{recipient.primary_memo!==null&&recipient.primary_memo!==undefined&&<p className="break-all">Memo / tag: {recipient.primary_memo}</p>}{recipient.backup_network&&<div className="space-y-2"><p className="text-muted-foreground">Backup {recipient.fallback_consent?"authorized":"not authorized"}</p><AssetIdentity symbol="USDC" network={recipient.backup_network}/>{recipient.backup_address&&<Address value={recipient.backup_address} network={recipient.backup_network} full/>}</div>}<p className="text-muted-foreground">Profile version {recipient.version}{historicalOnly?" · Earlier records only":""}</p></div></details></section>)}</div>:<Empty>No linked payout profiles.<a href={accountHref} className="mt-3 block font-medium text-primary">Link your invited wallet or email</a></Empty>,
    invoices: <WorkspaceTabs activeIndex={invoiceTab} onActiveChange={setInvoiceTab} tabs={[{label:"Invoices",content:<><section className="workspace-panel workspace-panel-white p-5 sm:p-6"><div className="mb-6 flex justify-end"><Action type="button" onClick={()=>openTaskDrawer("receiver-invoice-task")}>Submit invoice</Action></div>{requests.error?<p role="alert" className="mb-4 text-sm text-destructive">{requests.error}</p>:null}{requests.loading?<Empty>Loading invoices...</Empty>:requests.data?.requests.length?<div className="divide-y">{requests.data.requests.map(request=><div key={request.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-5 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"><div className="min-w-0"><p className="truncate text-sm font-medium">{request.payload.reference}</p><p className="mt-1 text-xs text-muted-foreground">{workspace?.profiles.find(profile=>profile.recipient.id===request.recipientId)?.company.name}</p></div><p className="max-w-[44vw] break-words text-right text-sm font-medium tabular-nums sm:max-w-[16rem]">{request.payload.amount} <span className="text-xs text-muted-foreground">{request.payload.currency}</span></p><div><Status value={request.billStatus || request.status}/></div><button type="button" className="justify-self-end rounded-full bg-muted px-4 py-2 text-xs font-medium hover:bg-secondary" onClick={()=>{setSelectedInvoiceId(request.id);openTaskDrawer("receiver-invoice-review");}}>Review</button></div>)}</div>:<Empty>No invoices submitted.</Empty>}{requests.data&&<HistoryPager {...requests.data} loading={requests.loading} label="Invoice request pages" onPage={setRequestPage}/>}</section><TaskDrawer id="receiver-invoice-task" title="Submit invoice"><div id="receiver-invoice-compose" className="scroll-mt-6"><InvoiceSubmission profiles={workspace?.profiles || []} onSubmitted={async()=>{setRequestPage(1);await load();}}/></div></TaskDrawer><TaskDrawer id="receiver-invoice-review" title="Invoice review">{requests.data?.requests.filter(request=>request.id===selectedInvoiceId).map(request=><InvoiceDetail key={request.id} request={request} company={workspace?.profiles.find(profile=>profile.recipient.id===request.recipientId)?.company.name}/>)}</TaskDrawer></>},{label:"Supplier credits",content:<SupplierInvoiceCredits refreshRevision={revision}/>}]} />,
    expenses: <PersonalExpenses refreshRevision={revision}/>,
    purchasing: <WorkspaceTabs tabs={[{label:"Supplier invitations",content:<PersonalProcurement refreshRevision={revision} assets={assets}/>},{label:"Private agreements",content:<SupplierPrivateAgreements refreshRevision={revision} assets={assets}/>}]} />,
    distributions: <RecipientDistributions revision={revision}/>,
    financing: <LenderFinancingPanel />,
    notifications: <NotificationInbox/>,
  }}/>;
}
