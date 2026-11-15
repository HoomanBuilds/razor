"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { dateLabel, microUsd, usdcInput, usd } from "@/lib/format";
import { useWorkspace } from "./workspace/context";
import { useAction, useResource } from "./workspace/hooks";
import { Action, control, Empty, Field, Panel, Status } from "./workspace/shared";
import type { CreditNote, CreditReview, SupplierBill } from "@/server/invoice-credits/service";

interface NotePage { notes: CreditNote[]; page: number; pageSize: number; hasMore: boolean }
interface BillPage { bills: SupplierBill[]; page: number; pageSize: number; hasMore: boolean }
interface SupplierDetail { note: CreditNote; bill: SupplierBill | null; canRevise: boolean; canWithdraw: boolean }

function useRequestKey() {
  const previous = useRef<{ payload: string; key: string } | null>(null);
  return (payload: unknown) => {
    const encoded = JSON.stringify(payload), current = previous.current;
    if (current?.payload === encoded) return current.key;
    const next = { payload: encoded, key: crypto.randomUUID() };
    previous.current = next;
    return next.key;
  };
}

function CreditHistory({ note }: { note: CreditNote }) {
  return <div className="grid gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="font-medium">{note.reference} - {usd(note.amount)} USDC</p>
      <Status value={note.status} />
    </div>
    <p className="break-words text-sm">Captured credit issuer: <strong>{note.issuer.name ?? "Historical name unavailable"}</strong> · profile version {note.issuer.profileVersion}</p>
    <p className="whitespace-pre-wrap break-words text-sm">{note.reason}</p>
    <p className="text-xs text-muted-foreground">Version {note.version} · Created {dateLabel(note.createdAt)}{note.acceptedAt ? ` · Accepted ${dateLabel(note.acceptedAt)}` : ""}</p>
    <details className="rounded-lg border p-3 text-xs">
      <summary className="cursor-pointer">Credit versions and decisions</summary>
      <div className="mt-3 space-y-3">
        {note.versions.map(version => <div key={version.version} className="min-w-0">
          <p className="font-medium">Version {version.version}: {usd(version.amount)} USDC</p>
          <p className="whitespace-pre-wrap break-words">{version.reason}</p>
        </div>)}
        {note.events.map(event => <div key={event.id} className="min-w-0 border-t pt-2">
          <p>{event.kind.replaceAll("_", " ")} · {event.actorRole} · version {event.version}</p>
          <p className="whitespace-pre-wrap break-words">{event.reason}</p>
        </div>)}
      </div>
    </details>
  </div>;
}

function CreditPager({ page, hasMore, disabled, label, onPage }: { page: number; hasMore: boolean; disabled: boolean; label: string; onPage: (page: number) => void }) {
  return <nav aria-label={label} className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
    <Action type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>Previous</Action>
    <span>Page {page}</span>
    <Action type="button" disabled={disabled || !hasMore} onClick={() => onPage(page + 1)}>Next</Action>
  </nav>;
}

export function SupplierInvoiceCredits({ refreshRevision }: { refreshRevision: number }) {
  const [page,setPage]=useState(1),[billPage,setBillPage]=useState(1),[revision,setRevision]=useState(0);
  const [selectedNote,setSelectedNote]=useState(""),[task,setTask]=useState<"list"|"create"|"summary"|"revise"|"withdraw"|"history">("list"),[notice,setNotice]=useState("");
  const bills=useResource<BillPage>(`/supplier-invoice-credits/bills?page=${billPage}`,refreshRevision+revision),notes=useResource<NotePage>(`/supplier-invoice-credits?page=${page}`,refreshRevision+revision),detail=useResource<SupplierDetail>(selectedNote?`/supplier-invoice-credits/${selectedNote}`:null,refreshRevision+revision);
  const {busy,error,run,setError}=useAction(),requestKey=useRequestKey(),current=detail.error?null:detail.data;
  const locked=!!busy||detail.refreshing||!!detail.error;
  function open(next:typeof task){setTask(next);setNotice("");setError("");}
  function changed(message:string){setRevision(value=>value+1);setTask("summary");setNotice(message);}
  return <Panel title="Supplier credits" tone="white" action={task==="list"?<Action disabled={!!busy} onClick={()=>open("create")}>New credit</Action>:undefined}><div aria-busy={!!busy} className="grid gap-5">
    {task!=="list" && <button type="button" disabled={!!busy} className="justify-self-start text-sm text-muted-foreground" onClick={()=>open(["revise","withdraw","history"].includes(task)?"summary":"list")}>{["revise","withdraw","history"].includes(task)?"Back to credit":"All credits"}</button>}
    {task==="list" && <>{notes.error?<p role="alert" className="text-sm text-destructive">{notes.error}</p>:notes.loading?<Empty>Loading credits...</Empty>:notes.data?.notes.length?<div className="divide-y">{notes.data.notes.map(note=><button key={note.id} type="button" disabled={!!busy} onClick={()=>{setSelectedNote(note.id);open("summary");}} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4 text-left"><p className="min-w-0 truncate text-sm font-medium">{note.reference}</p><p className="text-sm font-medium tabular-nums">{usd(note.amount)}</p><div className="col-span-2"><Status value={note.status}/></div></button>)}</div>:<Empty>No supplier credits.</Empty>}{notes.data&&(page>1||notes.data.hasMore)&&<CreditPager {...notes.data} disabled={!!busy||notes.refreshing} label="Supplier credit pages" onPage={setPage}/>}</>}
    {task==="create" && <><h3 className="text-lg font-medium">New credit note</h3>{bills.error?<p role="alert" className="text-sm text-destructive">{bills.error}</p>:bills.loading?<Empty>Loading invoices...</Empty>:bills.data?.bills.length?<form className="grid gap-5 sm:grid-cols-2" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run("issue",async()=>{const payload={billId:String(values.get("bill")),reference:String(values.get("reference")),amount:microUsd(String(values.get("amount"))),unit:"USDC",reason:String(values.get("reason"))};const response=await api<{note:CreditNote}>("/supplier-invoice-credits",{...payload,idempotencyKey:requestKey({action:"issue",...payload})});setSelectedNote(response.note.id);setPage(1);changed("Credit proposed. The company must accept it.");});}}><div className="sm:col-span-2"><Field label="Invoice"><select name="bill" className={control} required disabled={!!busy||bills.refreshing||!!bills.error} defaultValue=""><option value="">Choose invoice</option>{bills.data.bills.map(bill=><option key={bill.id} value={bill.id} disabled={BigInt(bill.remainingLiability)<=0n}>{bill.company.name} · {bill.reference} · {usd(bill.remainingLiability)} remaining</option>)}</select></Field></div><Field label="Credit reference"><input name="reference" className={control} required maxLength={120} disabled={!!busy}/></Field><Field label="Credit amount (USDC)"><input name="amount" className={control} required inputMode="decimal" placeholder="0.00" disabled={!!busy}/></Field><div className="sm:col-span-2"><Field label="Reason"><textarea name="reason" className={control} required minLength={10} maxLength={2000} rows={3} disabled={!!busy}/></Field></div><div className="flex items-center justify-between gap-4 border-t pt-5 sm:col-span-2"><p className="text-xs text-muted-foreground">Reduces debt after acceptance. No refund.</p><Action busy={busy==="issue"} disabled={!!busy||bills.refreshing||!!bills.error}>Propose credit</Action></div></form>:<Empty>No eligible supplier invoices.</Empty>}{bills.data&&(billPage>1||bills.data.hasMore)&&<CreditPager page={billPage} hasMore={bills.data.hasMore} disabled={!!busy||bills.refreshing} label="Eligible invoice pages" onPage={setBillPage}/>}</>}
    {!["list","create"].includes(task) && <>{detail.error?<p role="alert" className="text-sm text-destructive">{detail.error}</p>:!current?<Empty>Loading credit...</Empty>:<>
      {task==="summary" && <><div className="flex items-start justify-between gap-3"><h3 className="text-lg font-medium">{current.note.reference}</h3><Status value={current.note.status}/></div><p className="text-3xl font-medium tabular-nums">{usd(current.note.amount)}<span className="ml-2 text-xs font-normal text-muted-foreground">USDC</span></p><p className="whitespace-pre-wrap break-words text-sm">{current.note.reason}</p>{current.bill?<div className="rounded-2xl bg-muted p-4"><p className="text-sm">{current.bill.company.name} · {current.bill.reference}</p><dl className="mt-3 flex justify-between gap-3 text-sm"><dt className="text-muted-foreground">Remaining invoice</dt><dd className="tabular-nums">{usd(current.bill.remainingLiability)}</dd></dl></div>:<p className="text-xs text-muted-foreground">Original invoice unavailable. Your issued credit history remains accessible.</p>}<div className="flex flex-wrap gap-3">{current.canRevise&&<Action disabled={locked} onClick={()=>open("revise")}>Revise credit</Action>}{current.canWithdraw&&<button type="button" disabled={locked} className="text-sm text-muted-foreground" onClick={()=>open("withdraw")}>Withdraw proposal</button>}<button type="button" disabled={!!busy} className="text-sm text-primary" onClick={()=>open("history")}>History</button></div></>}
      {task==="history" && <CreditHistory note={current.note}/>}
      {task==="revise"&&current.canRevise&&<form key={`${current.note.id}:${current.note.version}`} className="grid gap-5" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run("revise",async()=>{const payload={expectedVersion:current.note.version,amount:microUsd(String(values.get("amount"))),unit:"USDC",reason:String(values.get("reason"))};await api(`/supplier-invoice-credits/${current.note.id}/revisions`,{...payload,idempotencyKey:requestKey({action:"revise",id:current.note.id,...payload})});changed("Revised credit proposed.");});}}><h3 className="text-lg font-medium">Revise {current.note.reference}</h3><Field label="Credit amount (USDC)"><input name="amount" inputMode="decimal" className={control} required defaultValue={usdcInput(current.note.amount)} disabled={locked}/></Field><Field label="Reason"><textarea name="reason" className={control} required minLength={10} maxLength={2000} rows={3} defaultValue={current.note.reason} disabled={locked}/></Field><div className="flex justify-end border-t pt-5"><Action disabled={locked} busy={busy==="revise"}>Save revision</Action></div></form>}
      {task==="withdraw"&&current.canWithdraw&&<form key={`${current.note.id}:${current.note.version}`} className="grid gap-5" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run("withdraw",async()=>{const payload={expectedVersion:current.note.version,reason:String(values.get("reason"))};await api(`/supplier-invoice-credits/${current.note.id}/withdraw`,{...payload,idempotencyKey:requestKey({action:"withdraw",id:current.note.id,...payload})});changed("Proposal withdrawn. Invoice debt unchanged.");});}}><h3 className="text-lg font-medium">Withdraw {current.note.reference}</h3><Field label="Reason"><textarea name="reason" className={control} required minLength={10} maxLength={2000} rows={3} disabled={locked}/></Field><div className="flex justify-end border-t pt-5"><Action disabled={locked} busy={busy==="withdraw"}>Withdraw proposal</Action></div></form>}
    </>}</>}
    {notice&&<p role="status" className="text-sm text-primary">{notice}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </div></Panel>;
}

export function CompanyInvoiceCredits({ billId }: { billId: string }) {
  const { base, revision, refresh, organization } = useWorkspace();
  const [page, setPage] = useState(1), [selected, setSelected] = useState(""), [notice, setNotice] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const canRead = organization.permissions?.includes("payments:read"), canApprove = organization.permissions?.includes("payments:approve");
  const notes = useResource<NotePage>(canRead ? `${base}/invoice-credits?billId=${encodeURIComponent(billId)}&page=${page}` : null, revision);
  const note = notes.data?.notes.find(value => value.id === selected);
  const review = useResource<CreditReview>(canApprove && note?.status === "proposed" ? `${base}/invoice-credits/${note.id}/review` : null, revision);
  const currentReview = !notes.error && !review.error && review.data?.note.id === note?.id && review.data?.note.version === note?.version ? review.data : null;
  const { busy, error, run, setError } = useAction(), requestKey = useRequestKey();
  useEffect(() => { setError(""); }, [selected, rejecting, page, setError]);
  const locked = !!busy || review.refreshing || notes.refreshing || !!notes.error || !!review.error;
  if (!canRead) return null;
  return <section className="grid min-w-0 gap-5" aria-label="Supplier credit notes" aria-busy={!!busy}>
    {notes.error ? <p role="alert" className="text-sm text-destructive">{notes.error}</p> : notes.loading ? <Empty>Loading credits...</Empty> : !note ? <>
      {notes.data?.notes.length ? <div className="divide-y">{notes.data.notes.map(item => <button key={item.id} type="button" disabled={!!busy} onClick={() => { setSelected(item.id); setNotice(""); setRejecting(false); }} className="flex w-full items-center justify-between gap-3 py-5 text-left"><span className="min-w-0"><span className="block text-sm font-medium">{item.reference}</span><span className="mt-2 block"><Status value={item.status} /></span></span><span className="shrink-0 text-sm font-medium tabular-nums">{usd(item.amount)}</span></button>)}</div> : notes.data && <p className="py-8 text-center text-sm text-muted-foreground">No supplier credits.</p>}
      {notes.data && (notes.data.hasMore || page > 1) ? <CreditPager {...notes.data} disabled={locked} label="Company invoice credit pages" onPage={setPage} /> : null}
    </> : <>
      <button type="button" className="justify-self-start text-sm text-primary" disabled={!!busy} onClick={() => setSelected("")}>All credits</button>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{note.reference}</h3><p className="mt-2 text-sm text-muted-foreground">{note.issuer.name ?? "Historical supplier name unavailable"}</p></div><Status value={note.status} /></div>
      <p className="flex items-baseline gap-2 text-3xl font-medium tabular-nums">{usd(note.amount)}<span className="text-xs font-normal text-muted-foreground">USDC</span></p>
      <p className="whitespace-pre-wrap break-words text-sm">{note.reason}</p>
      {review.error && <p role="alert" className="text-sm text-destructive">{review.error}</p>}
      {currentReview && note.status === "proposed" && <>
        <dl className="grid gap-3 border-y py-4 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Remaining invoice</dt><dd>{usd(currentReview.totals.remainingLiability)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">After credit</dt><dd className="font-medium">{usd(currentReview.totals.residualLiability)}</dd></div></dl>
        <p className="text-xs text-muted-foreground">No money is sent or refunded.</p>
        {currentReview.draftsToRetire.length > 0 && <div className="grid gap-3 text-sm"><p className="font-medium">Drafts to retire</p>{currentReview.draftsToRetire.map(draft => <div key={draft.id} className="flex flex-wrap justify-between gap-2"><span>{draft.reference}</span><span className="tabular-nums">{usd(draft.amount)} · Costs up to {usd(draft.maxFee)}</span></div>)}</div>}
        {currentReview.locks.length > 0 ? <ul role="status" className="grid gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">{currentReview.locks.map((lock, index) => <li key={`${lock.code}:${index}`}>{lock.message}</li>)}</ul> : !rejecting && <form key={currentReview.reviewHash} className="grid gap-5" onSubmit={event => {
          event.preventDefault(); const values = new FormData(event.currentTarget);
          void run("accept", async () => {
            const payload = { expectedVersion: note.version, reviewHash: currentReview.reviewHash, acknowledgeDraftRetirement: values.has("acknowledge") };
            const result = await api<{ remainingLiability: string }>(`${base}/invoice-credits/${note.id}/accept`, { ...payload, idempotencyKey: requestKey({ action: "accept", id: note.id, ...payload }) });
            refresh(); setNotice(`Credit accepted. ${usd(result.remainingLiability)} remains.`);
          });
        }}><label className="flex items-start gap-2 text-sm"><input name="acknowledge" type="checkbox" required disabled={locked} className="mt-1" /><span>I reviewed this credit and its draft retirements. Any remainder needs a fresh installment and approval.</span></label><div className="flex justify-end"><Action disabled={locked} busy={busy === "accept"}>Accept credit</Action></div></form>}
        {rejecting ? <form className="grid gap-4 border-t pt-5" onSubmit={event => {
          event.preventDefault(); const values = new FormData(event.currentTarget);
          void run("reject", async () => {
            const payload = { expectedVersion: note.version, reason: String(values.get("reason")) };
            await api(`${base}/invoice-credits/${note.id}/reject`, { ...payload, idempotencyKey: requestKey({ action: "reject", id: note.id, ...payload }) });
            refresh(); setNotice("Credit rejected. Invoice balance unchanged."); setRejecting(false);
          });
        }}><Field label="Reason for rejection"><textarea name="reason" className={control} required minLength={10} maxLength={2000} disabled={locked} /></Field><div className="flex justify-between gap-3"><button type="button" className="text-sm text-muted-foreground" disabled={!!busy} onClick={() => setRejecting(false)}>Cancel</button><Action disabled={locked} busy={busy === "reject"}>Reject credit</Action></div></form> : <button type="button" disabled={locked} className="justify-self-start text-sm text-muted-foreground" onClick={() => setRejecting(true)}>Reject proposal</button>}
      </>}
      {note.status === "proposed" && canApprove && review.loading && <Empty>Checking credit...</Empty>}
      <details className="border-t pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">History</summary><div className="mt-4 grid gap-3"><p>Supplier profile version {note.issuer.profileVersion} · Created {dateLabel(note.createdAt)}{note.acceptedAt ? ` · Accepted ${dateLabel(note.acceptedAt)}` : ""}</p>{note.versions.map(version => <div key={version.version}><p>Version {version.version}: {usd(version.amount)} USDC</p><p className="mt-1 whitespace-pre-wrap">{version.reason}</p></div>)}{note.events.map(event => <div key={event.id} className="border-t pt-3"><p>{event.kind.replaceAll("_", " ")} · {event.actorRole} · version {event.version}</p><p className="mt-1 whitespace-pre-wrap">{event.reason}</p></div>)}</div></details>
    </>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
