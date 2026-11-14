"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { microUsd, usd, usdcInput } from "@/lib/format";
import type { supplierRequests } from "@/server/procurement/service";
import { Action, control, DataTable, Empty, Field, Panel, Status } from "./workspace/shared";
import { useAction, useResource } from "./workspace/hooks";

type Request = ReturnType<typeof supplierRequests>[number];

function QuoteForm({ request, busy, onSubmit }: { request: Request; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const latest = request.quotes[0];
  return <form className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
    <Field label="All-inclusive unit price (USDC)"><input name="unitPrice" className={control} inputMode="decimal" required defaultValue={latest ? usdcInput(latest.unit_price) : ""} /></Field>
    <Field label="Proposed delivery date (UTC)"><input name="deliveryDate" className={control} type="date" min={request.delivery_from} max={request.delivery_to} required defaultValue={latest?.delivery_date} /></Field>
    <Field label="Quote valid for award until (your device time)"><input name="validUntil" className={control} type="datetime-local" required /></Field>
    <div className="sm:col-span-2"><Field label="Complete shipping, service, tax and acceptance terms"><textarea name="terms" className={control} rows={3} required minLength={3} maxLength={3000} defaultValue={latest?.terms} /></Field></div>
    <p className="text-xs text-muted-foreground sm:col-span-2">Price includes all commercial charges for {request.quantity} {request.unit}. Your confirmed receiving asset/network remains unchanged. Route conversion and execution costs are separately reviewed by the payer. Each supplier can submit up to twenty versions per RFQ. Submission creates no payment or delivery guarantee.</p>
    <div><Action busy={busy} disabled={busy}>{latest ? "Submit new exact quote version" : "Submit supplier quote"}</Action></div>
  </form>;
}

export function PersonalProcurement({ basePath = "/supplier-procurement", refreshRevision = 0 }: { basePath?: string; refreshRevision?: number }) {
  const [revision, setRevision] = useState(0), [notice, setNotice] = useState("");
  const { data, loading, error: loadError } = useResource<{ requests: Request[] }>(basePath, revision + refreshRevision), { busy, error, run } = useAction();
  return <Panel title="Supplier sourcing invitations" description="Only RFQs addressed to your currently confirmed business profiles appear here. Other suppliers' bids and company finances remain private.">
    <div className="grid min-w-0 grid-cols-1 gap-4">
      {loading ? <Empty>Loading your eligible sourcing requests...</Empty> : !data?.requests.length ? <Empty>No eligible supplier requests. A company must add and authorize your confirmed business profile first.</Empty> : data.requests.map(request => <article key={`${request.id}:${request.recipientId}`} className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{request.reference} · {request.companyName}</h3><Status value={request.historicalOnly ? "historical" : request.state} /></div>
        {request.historicalOnly && <p className="text-xs text-muted-foreground">{request.visibility} Ask the company for a newly reviewed invitation before submitting another quote.</p>}
        <p className="whitespace-pre-wrap text-sm">{request.specification}</p><p className="text-sm">{request.quantity} {request.unit} · Maximum commercial value {usd(request.budget)}</p><p className="text-xs">Delivery window {request.delivery_from} to {request.delivery_to}. Submissions close {new Date(request.quote_deadline).toLocaleString()}.</p><p className="whitespace-pre-wrap text-xs text-muted-foreground">Required evidence: {request.evidence}</p>
        {request.awardedToYou && <p role="status" className="text-sm">{request.historicalOnly ? "Your historical quote was selected. Its commercial history remains available here. New invoices or quotes require a current confirmed company relationship and the applicable invitation." : "Your quote was selected. The company reviews the purchase commitment separately. Submit invoices through your ordinary recipient workflow; accepted receiving quantities gate approval."}</p>}
        {!request.historicalOnly && request.state === "open" && request.reviewerActive && Date.parse(request.quote_deadline) > Date.now() ? <QuoteForm key={`${request.id}:${request.recipientId}:${request.quotes[0]?.version ?? 0}`} request={request} busy={!!busy} onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run(`quote:${request.id}:${request.recipientId}`, async () => { await api(`${basePath}/requests/${request.id}/quotes`, { recipientId: request.recipientId, expectedVersion: request.quotes[0]?.version ?? 0, unitPrice: microUsd(String(values.get("unitPrice"))), deliveryDate: values.get("deliveryDate"), validUntil: new Date(String(values.get("validUntil"))).toISOString(), terms: values.get("terms") }); setNotice("Supplier quote version saved. Your receiving profile and company financial authority were not changed."); setRevision(value => value + 1); }); }} /> : <p className="text-xs text-muted-foreground">{request.historicalOnly ? "Historical quote versions are read-only." : !request.reviewerActive ? "The company's reviewing role is unavailable. Ask the company to resolve its role policy." : "This request no longer accepts quote revisions."}</p>}
        {request.quotes.length > 0 && <details><summary className="cursor-pointer text-xs font-medium">Your quote history</summary><div className="mt-3"><DataTable columns={["Version", "Commercial value", "Terms"]}>{request.quotes.map(quote => <tr key={quote.version}><td>{quote.version}<p className="text-xs">{new Date(quote.created_at).toLocaleString()}</p></td><td>{usd(quote.total)}<p className="text-xs">{usd(quote.unit_price)} / {request.unit}</p></td><td className="max-w-80 whitespace-pre-wrap break-words text-xs">{quote.terms}<p>Deliver {quote.delivery_date}. Valid for award until {new Date(quote.valid_until).toLocaleString()}.</p></td></tr>)}</DataTable></div></details>}
      </article>)}
      {notice && <p role="status" className="text-sm">{notice}</p>}{(loadError || error) && <p role="alert" className="text-sm text-destructive">{loadError || error}</p>}
    </div>
  </Panel>;
}
