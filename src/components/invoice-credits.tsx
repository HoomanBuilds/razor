"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { dateLabel, microUsd, usdcInput, usd } from "@/lib/format";
import { useWorkspace } from "./workspace/context";
import { useAction, useResource } from "./workspace/hooks";
import { Action, control, Empty, Field, Panel, Status } from "./workspace/shared";
import { InvoiceLiability } from "./workspace/invoice-liability";
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
  const [page, setPage] = useState(1), [billPage, setBillPage] = useState(1), [revision, setRevision] = useState(0);
  const [selectedNote, setSelectedNote] = useState(""), [notice, setNotice] = useState("");
  const bills = useResource<BillPage>(`/supplier-invoice-credits/bills?page=${billPage}`, refreshRevision + revision);
  const notes = useResource<NotePage>(`/supplier-invoice-credits?page=${page}`, refreshRevision + revision);
  const detail = useResource<SupplierDetail>(selectedNote ? `/supplier-invoice-credits/${selectedNote}` : null, refreshRevision + revision);
  const { busy, error, run } = useAction(), requestKey = useRequestKey();
  const refresh = () => setRevision(value => value + 1);
  const current = detail.error ? null : detail.data;
  return <Panel title="My supplier credit notes" description="Propose a USDC reduction to an existing business invoice. Your payer must accept it before the liability changes. A credit does not refund delivered funds.">
    <div className="grid gap-5">
      {bills.error ? <p role="alert" className="text-sm text-destructive">{bills.error}</p> : null}
      {bills.loading ? <Empty>Loading your eligible business invoices...</Empty> : bills.data?.bills.length ? <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
        void run("issue", async () => {
          const payload = { billId: String(values.get("bill")), reference: String(values.get("reference")), amount: microUsd(String(values.get("amount"))), unit: "USDC", reason: String(values.get("reason")) };
          const response = await api<{ note: CreditNote }>("/supplier-invoice-credits", { ...payload, idempotencyKey: requestKey({ action: "issue", ...payload }) });
          setSelectedNote(response.note.id); setPage(1); form.reset(); refresh(); setNotice("Credit note issued for company review. No payment or refund was sent.");
        });
      }}>
        <Field label="Original business invoice"><select name="bill" className={control} required disabled={!!busy || bills.refreshing || !!bills.error} defaultValue=""><option value="">Choose an invoice</option>{bills.data.bills.map(bill => <option key={bill.id} value={bill.id} disabled={BigInt(bill.remainingLiability) <= 0n}>{bill.company.name} · {bill.reference} · {usd(bill.remainingLiability)} remaining</option>)}</select></Field>
        <Field label="Credit note reference"><input name="reference" className={control} required maxLength={120} disabled={!!busy} /></Field>
        <Field label="Credit amount (USDC)"><input name="amount" className={control} required inputMode="decimal" placeholder="0.00" disabled={!!busy} /></Field>
        <div className="sm:col-span-2"><Field label="Reason for the supplier credit"><textarea name="reason" className={control} minLength={10} maxLength={2000} required disabled={!!busy} /></Field></div>
        <div className="sm:col-span-2"><Action busy={busy === "issue"} disabled={!!busy || bills.refreshing || !!bills.error}>Issue credit note for review</Action></div>
      </form> : <Empty>No currently linked business invoices are eligible for a new supplier credit. Previous notes remain available below. Expense reimbursement reversals use a separate process.</Empty>}
      {bills.data && (bills.data.hasMore || billPage > 1) ? <CreditPager page={billPage} hasMore={bills.data.hasMore} disabled={!!busy || bills.refreshing || !!bills.error} label="Eligible supplier invoice pages" onPage={setBillPage} /> : null}
      {notes.error ? <p role="alert" className="text-sm text-destructive">{notes.error}</p> : null}
      {notes.loading ? <Empty>Loading your credit notes...</Empty> : notes.data?.notes.length ? <div className="grid gap-3">{notes.data.notes.map(note => <button key={note.id} type="button" disabled={!!busy} onClick={() => { setSelectedNote(note.id); setNotice(""); }} className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border p-4 text-left text-sm hover:bg-muted"><span className="min-w-0 break-words">{note.reference} · {usd(note.amount)} USDC</span><Status value={note.status} /></button>)}</div> : <Empty>No supplier credit notes have been issued.</Empty>}
      {notes.data ? <CreditPager {...notes.data} disabled={!!busy || notes.refreshing} label="Supplier credit note pages" onPage={setPage} /> : null}
      {selectedNote ? <section className="grid min-w-0 gap-4 rounded-lg border p-4" aria-label="Selected supplier credit note">
        <div className="flex justify-end"><button type="button" className="text-sm text-primary" onClick={() => setSelectedNote("")}>Close credit note</button></div>
        {detail.error ? <p role="alert" className="text-sm text-destructive">{detail.error}</p> : current ? <>
          <CreditHistory note={current.note} />
          {current.bill ? <p className="text-xs text-muted-foreground">{current.bill.company.name} · {current.bill.reference} · Remaining invoice liability {usd(current.bill.remainingLiability)} USDC</p> : <p className="text-xs text-muted-foreground">Only your own issued credit history is available. The current invoice or receiving profile is not accessible to this account.</p>}
          {current.canRevise ? <form key={`${current.note.id}:${current.note.version}`} className="grid gap-3 rounded-lg border p-4" onSubmit={event => {
            event.preventDefault(); const values = new FormData(event.currentTarget);
            void run("revise", async () => {
              const payload = { expectedVersion: current.note.version, amount: microUsd(String(values.get("amount"))), unit: "USDC", reason: String(values.get("reason")) };
              await api(`/supplier-invoice-credits/${current.note.id}/revisions`, { ...payload, idempotencyKey: requestKey({ action: "revise", id: current.note.id, ...payload }) });
              refresh(); setNotice("A new credit version was recorded. Earlier terms and decisions remain in the history.");
            });
          }}><Field label="Revised credit amount (USDC)"><input name="amount" inputMode="decimal" className={control} required defaultValue={usdcInput(current.note.amount)} disabled={!!busy || detail.refreshing} /></Field><Field label="Revised credit reason"><textarea name="reason" className={control} required minLength={10} maxLength={2000} defaultValue={current.note.reason} disabled={!!busy || detail.refreshing} /></Field><div><Action disabled={!!busy || detail.refreshing} busy={busy === "revise"}>Record revised credit terms</Action></div></form> : null}
          {current.canWithdraw ? <form className="grid gap-3 rounded-lg border p-4" onSubmit={event => {
            event.preventDefault(); const values = new FormData(event.currentTarget);
            void run("withdraw", async () => {
              const payload = { expectedVersion: current.note.version, reason: String(values.get("reason")) };
              await api(`/supplier-invoice-credits/${current.note.id}/withdraw`, { ...payload, idempotencyKey: requestKey({ action: "withdraw", id: current.note.id, ...payload }) });
              refresh(); setNotice("Credit proposal withdrawn. The invoice liability was not reduced.");
            });
          }}><Field label="Reason to withdraw the proposal"><textarea name="reason" className={control} required minLength={10} maxLength={2000} disabled={!!busy || detail.refreshing} /></Field><div><Action disabled={!!busy || detail.refreshing} busy={busy === "withdraw"}>Withdraw proposed credit</Action></div></form> : null}
        </> : <Empty>Loading the selected credit...</Empty>}
      </section> : null}
      {notice ? <p role="status" className="text-sm text-primary">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  </Panel>;
}

export function CompanyInvoiceCredits({ billId }: { billId: string }) {
  const { base, revision, refresh, organization } = useWorkspace();
  const [page, setPage] = useState(1), [selected, setSelected] = useState(""), [notice, setNotice] = useState("");
  const canRead = organization.permissions?.includes("payments:read"), canApprove = organization.permissions?.includes("payments:approve");
  const notes = useResource<NotePage>(canRead ? `${base}/invoice-credits?billId=${encodeURIComponent(billId)}&page=${page}` : null, revision);
  const note = notes.data?.notes.find(value => value.id === selected);
  const review = useResource<CreditReview>(canApprove && note?.status === "proposed" ? `${base}/invoice-credits/${note.id}/review` : null, revision);
  const currentReview = !notes.error && !review.error && review.data?.note.id === note?.id && review.data?.note.version === note?.version ? review.data : null;
  const { busy, error, run } = useAction(), requestKey = useRequestKey();
  if (!canRead) return null;
  return <section className="grid min-w-0 gap-4 rounded-lg border p-4" aria-label="Supplier credit notes">
    <div><h3 className="font-medium">Supplier credit notes</h3><p className="mt-1 text-xs text-muted-foreground">A supplier proposal changes no liability until finance accepts its exact terms. Accepted credits do not return previously delivered money.</p></div>
    {notes.error ? <p role="alert" className="text-sm text-destructive">{notes.error}</p> : notes.loading ? <Empty>Loading invoice credits...</Empty> : notes.data?.notes.length ? <div className="flex flex-wrap gap-3">{notes.data.notes.map(item => <Action key={item.id} type="button" disabled={!!busy} onClick={() => { setSelected(item.id); setNotice(""); }}>{item.reference} · {usd(item.amount)} · {item.status.replaceAll("_", " ")}</Action>)}</div> : <p className="text-sm text-muted-foreground">No supplier credit notes for this invoice.</p>}
    {notes.data && (notes.data.hasMore || page > 1) ? <CreditPager {...notes.data} disabled={!!busy || notes.refreshing || !!notes.error || !!review.error} label="Company invoice credit pages" onPage={setPage} /> : null}
    {note ? <CreditHistory note={note} /> : null}
    {review.error ? <p role="alert" className="text-sm text-destructive">{review.error}</p> : null}
    {currentReview && note?.status === "proposed" ? <div className="grid gap-4">
      <p className="break-words rounded-lg bg-muted p-3 text-sm">Original invoice: <strong>{currentReview.bill.reference}</strong> · {currentReview.bill.company.name}<br />{currentReview.bill.title}</p>
      <InvoiceLiability amount={currentReview.totals.originalAmount} delivered={currentReview.totals.deliveredAmount} credit={currentReview.totals.acceptedCreditAmount} setoff={currentReview.totals.noncashSetoffAmount} funded={currentReview.totals.fundedClearingAmount} remaining={currentReview.totals.remainingLiability} />
      <p className="text-sm">This credit reduces the remaining liability by <strong>{usd(currentReview.totals.creditAmount)} USDC</strong>. After acceptance: <strong>{usd(currentReview.totals.residualLiability)} USDC</strong>.</p>
      {currentReview.draftsToRetire.length ? <div className="rounded-lg border p-3 text-sm"><p className="font-medium">Unsigned drafts to retire</p><ul className="mt-2 list-disc space-y-2 pl-5">{currentReview.draftsToRetire.map(draft => <li key={draft.id} className="break-words">{draft.reference}: {usd(draft.amount)} USDC, maximum payment cost {usd(draft.maxFee)}. This draft will require a fresh installment and approval for any remaining liability.</li>)}</ul></div> : <p className="text-xs text-muted-foreground">No unsigned payment drafts need retirement.</p>}
      {currentReview.locks.length ? <div role="status" className="rounded-lg border p-3 text-sm"><p className="font-medium">Acceptance is held</p><ul className="mt-2 list-disc space-y-2 pl-5">{currentReview.locks.map((lock, index) => <li key={`${lock.code}:${index}`}>{lock.message}</li>)}</ul></div> : <form key={currentReview.reviewHash} className="grid gap-3" onSubmit={event => {
        event.preventDefault(); if (!currentReview || !note) return;
        const values = new FormData(event.currentTarget);
        void run("accept", async () => {
          const payload = { expectedVersion: note.version, reviewHash: currentReview!.reviewHash, acknowledgeDraftRetirement: values.has("acknowledge") };
          const result = await api<{ remainingLiability: string }>(`${base}/invoice-credits/${note.id}/accept`, { ...payload, idempotencyKey: requestKey({ action: "accept", id: note.id, ...payload }) });
          refresh(); setNotice(`Supplier credit accepted. Remaining invoice liability: ${usd(result.remainingLiability)} USDC. No money was sent or refunded.`);
        });
      }}><label className="flex items-start gap-2 text-sm"><input name="acknowledge" type="checkbox" required disabled={!!busy || review.refreshing || notes.refreshing} /><span>I reviewed this exact credit and the listed draft retirements. Any remaining invoice needs fresh payment preparation and approval.</span></label><div><Action disabled={!!busy || review.refreshing || notes.refreshing} busy={busy === "accept"}>Accept exact supplier credit</Action></div></form>}
      <form className="grid gap-3 rounded-lg border p-4" onSubmit={event => {
        event.preventDefault(); if (!note) return; const values = new FormData(event.currentTarget);
        void run("reject", async () => {
          const payload = { expectedVersion: note.version, reason: String(values.get("reason")) };
          await api(`${base}/invoice-credits/${note.id}/reject`, { ...payload, idempotencyKey: requestKey({ action: "reject", id: note.id, ...payload }) });
          refresh(); setNotice("Supplier proposal rejected. The invoice liability was not reduced.");
        });
      }}><Field label="Reason to reject the supplier proposal"><textarea name="reason" className={control} required minLength={10} maxLength={2000} disabled={!!busy || notes.refreshing || !!notes.error || !!review.error} /></Field><div><Action disabled={!!busy || notes.refreshing || !!notes.error || !!review.error} busy={busy === "reject"}>Reject proposed credit</Action></div></form>
    </div> : null}
    {note?.status === "proposed" && canApprove && review.loading ? <Empty>Checking the exact credit and payment authority...</Empty> : null}
    {notice ? <p role="status" className="text-sm text-primary">{notice}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </section>;
}
