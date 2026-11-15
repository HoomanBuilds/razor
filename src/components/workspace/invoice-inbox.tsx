"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, Upload, Settings2 } from "lucide-react";
import { api } from "@/lib/api";
import { invoiceSourceAmount } from "@/lib/invoice-register";
import { dateLabel, usd } from "@/lib/format";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Empty, Field, Status } from "./shared";
import { InvoiceChannels } from "./invoice-channels";
import { InvoiceDocumentIntake } from "./document-intake";
import { PurchaseMatchFields, purchaseMatchInput } from "./vendor-commitments";
import { TaskDrawer, openTaskDrawer } from "./task-drawer";
import { openInvoice } from "./invoice-navigation";

interface Request { id: string; recipientId: string; recipientName: string; sourceFingerprint: string; status: string; billId: string | null; paymentStatus: string | null; payload: { reference: string; amount: string; currency: string; dueDate?: string; commitmentReference?: string; commitmentDate?: string; lineItems: unknown[]; text?: string }; review: { agreedUSDC: string } | null }

export function InvoiceInbox() {
  const { base, revision, refresh, analyzeInvoice, organization, navigate } = useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const canPrepare = organization.permissions?.includes("payments:prepare") === true;
  const canAnalyze = organization.permissions?.includes("documents:manage") === true;
  const canConfigure = canAnalyze && organization.permissions?.includes("company:manage") === true;
  const [page, setPage] = useState(1), [selectedId, setSelectedId] = useState("");
  const { data, error: loadError, loading, refreshing } = useResource<{ requests: Request[]; total: number; page: number; pageSize: number; hasMore: boolean }>(canRead ? `${base}/intake?page=${page}&pageSize=25` : null, revision);
  const { busy, error, run, setError } = useAction();
  useEffect(() => { setError(""); }, [selectedId, setError]);
  const request = data?.requests.find(item => item.id === selectedId);
  const locked = !!busy || refreshing || !!loadError;
  return <div className="grid min-w-0 gap-5">
    {selectedId ? <button type="button" disabled={!!busy} className="flex min-h-10 items-center gap-1 justify-self-start text-sm text-primary" onClick={() => setSelectedId("")}><ChevronLeft size={16} />Inbox</button> : <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{data && !loadError ? data.total > 0 ? `${data.total} submitted` : null : "Supplier invoices"}</p><div className="flex gap-4">{canAnalyze && <button type="button" className="flex min-h-10 items-center gap-2 text-sm text-primary" onClick={() => openTaskDrawer("invoice-files")}><Upload size={16} />Files</button>}{canConfigure && <button type="button" aria-label="Invoice connections" className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground" onClick={() => openTaskDrawer("invoice-connections")}><Settings2 size={17} /></button>}</div></div>}
    {loadError && <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-red-50 p-4 text-sm text-destructive"><p>{loadError}</p><button type="button" onClick={refresh} className="underline">Retry</button></div>}
    {canRead && <section className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" aria-busy={!!busy}>
      {selectedId ? request ? <div className="grid gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-medium tracking-tight">{request.payload.reference}</h2><p className="mt-2 text-sm text-muted-foreground">{request.recipientName}</p></div><Status value={request.paymentStatus ?? request.status} /></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-5"><p className="text-2xl font-medium tabular-nums">{invoiceSourceAmount(request.payload.amount)} <span className="text-xs text-muted-foreground">{request.payload.currency}</span></p><button type="button" className="min-h-9 text-sm text-primary" onClick={() => openTaskDrawer("invoice-source")}>View source</button></div>
        {request.payload.dueDate && <p className="text-xs text-muted-foreground">Due {dateLabel(request.payload.dueDate, organization.timezone)}</p>}
        {request.status === "submitted" && canPrepare ? <form key={request.id} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run(request.id, async () => { await api(`${base}/intake/${request.id}/prepare`, { sourceFingerprint: request.sourceFingerprint, agreedUSDC: values.get("amount"), maxFee: values.get("fee"), title: values.get("title"), ...purchaseMatchInput(values), reviewConfirmed: true }); refresh(); }); }}>
          <fieldset disabled={!!busy} className="grid min-w-0 gap-5 sm:grid-cols-2"><Field label="Description"><input name="title" className={control} required maxLength={240} defaultValue={`Invoice ${request.payload.reference}`} /></Field><Field label="Agreed net amount (USDC)"><input name="amount" className={control} required inputMode="decimal" defaultValue={request.payload.currency === "USDC" ? request.payload.amount : ""} /></Field><details className="border-y py-4 sm:col-span-2" onInvalidCapture={event => { event.currentTarget.open = true; }}><summary className="cursor-pointer text-sm text-muted-foreground">Payment cost limit</summary><div className="mt-4"><Field label="Maximum cost (USDC)"><input name="fee" className={control} required inputMode="decimal" defaultValue="1" /></Field></div></details><PurchaseMatchFields reference={request.payload.commitmentReference} date={request.payload.commitmentDate} /><label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required className="mt-1" />I reviewed the source and agreed this USDC amount.{request.payload.currency !== "USDC" && " Foreign currency is not converted automatically."}</label></fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-5">{canAnalyze && <button type="button" disabled={!!busy} className="text-sm text-muted-foreground" onClick={() => analyzeInvoice({ id: request.id, recipientId: request.recipientId, sourceFingerprint: request.sourceFingerprint, reference: request.payload.reference, currency: request.payload.currency, text: request.payload.text || JSON.stringify({ reference: request.payload.reference, amount: request.payload.amount, currency: request.payload.currency, dueDate: request.payload.dueDate, lineItems: request.payload.lineItems }) })}>Analyze privately</button>}<Action className="ml-auto" busy={busy === request.id} disabled={locked}>Save draft</Action></div>
        </form> : request.review && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm">Draft prepared for {usd(request.review.agreedUSDC)} USDC.</p><button type="button" className="min-h-10 text-sm text-primary" onClick={() => { navigate("bills"); if (request.billId) openInvoice(request.billId); }}>Open Bills</button></div>}
      </div> : loading ? <Empty>Loading invoice...</Empty> : !loadError && <Empty>Invoice unavailable. Return to the inbox to refresh.</Empty> : loading ? <Empty>Loading submitted invoices...</Empty> : data?.requests.length ? <div className="divide-y">{data.requests.map(item => <article key={item.id} className="flex items-center justify-between gap-4 py-5 first:pt-0 last:pb-0"><div className="min-w-0"><button type="button" className="text-left text-sm font-medium hover:text-primary" onClick={() => setSelectedId(item.id)}>{item.payload.reference}</button><p className="mt-1.5 text-sm text-muted-foreground">{item.recipientName}</p><div className="mt-2"><Status value={item.paymentStatus ?? item.status} /></div></div><div className="shrink-0 text-right"><p className="text-sm font-medium tabular-nums">{invoiceSourceAmount(item.payload.amount)} <span className="text-xs font-normal text-muted-foreground">{item.payload.currency}</span></p><button type="button" className="mt-2 min-h-9 text-sm text-primary" aria-label={`Review ${item.payload.reference}`} onClick={() => setSelectedId(item.id)}>{item.status === "submitted" ? "Review" : "View"}</button></div></article>)}</div> : data && !loadError ? <div className="py-10 text-center text-sm text-muted-foreground">No submitted invoices.</div> : null}
      {!selectedId && data && (data.hasMore || page > 1) && <nav aria-label="Supplier invoice pages" className="mt-5 flex items-center justify-between gap-3 border-t pt-4 text-sm"><button type="button" disabled={refreshing || page <= 1} className="text-primary disabled:opacity-50" onClick={() => setPage(value => value - 1)}>Previous</button><span className="text-muted-foreground">{(data.page - 1) * data.pageSize + 1}-{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span><button type="button" disabled={refreshing || !data.hasMore} className="text-primary disabled:opacity-50" onClick={() => setPage(value => value + 1)}>Next</button></nav>}
    </section>}
    {canAnalyze && <TaskDrawer id="invoice-files" title="Invoice files"><InvoiceDocumentIntake key={base} /></TaskDrawer>}
    {canConfigure && <TaskDrawer id="invoice-connections" title="Invoice connections"><InvoiceChannels key={`${base}:channels`} /></TaskDrawer>}
    <TaskDrawer id="invoice-source" title="Invoice source" description={request?.payload.reference}>{request && <pre className="whitespace-pre-wrap break-words text-sm leading-6">{request.payload.text || JSON.stringify(request.payload.lineItems, null, 2)}</pre>}</TaskDrawer>
  </div>;
}
