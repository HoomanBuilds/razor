"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Building2 } from "lucide-react";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { PageMetrics } from "./page-metrics";
import { api } from "@/lib/api";
import { microUsd, usdcInput, usd } from "@/lib/format";
import type { billCommitmentReview, getCommitment, reviewCommitment } from "@/server/vendor-commitments/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Empty, Field, Panel, Status } from "./shared";

type Commitment = ReturnType<typeof getCommitment>;
type Review = ReturnType<typeof reviewCommitment>;
export type PurchaseMatch = ReturnType<typeof billCommitmentReview>;

export function PurchaseMatchFields({ reference = "", date = "" }: { reference?: string; date?: string }) {
  return <>
    <Field label="Purchase commitment reference (optional)" hint="Name the exact approved PO. An invalid or exhausted PO holds this bill."><input name="commitmentReference" className={control} maxLength={120} defaultValue={reference} /></Field>
    <Field label="Invoice service date (UTC)" hint="Required for a named PO. Monthly allowances reset by calendar month without rollover."><input name="commitmentDate" type="date" className={control} defaultValue={date} /></Field>
    <label className="flex items-start gap-2 text-sm"><input name="commitmentScopeConfirmed" type="checkbox" className="mt-1" />I checked the invoice scope and quantities against the named purchase commitment.</label>
  </>;
}

export function purchaseMatchInput(values: FormData) {
  return {
    commitmentReference: String(values.get("commitmentReference") ?? "").trim() || undefined,
    commitmentDate: String(values.get("commitmentDate") ?? "") || undefined,
    commitmentScopeConfirmed: values.get("commitmentScopeConfirmed") === "on" || undefined,
  };
}

export function PurchaseMatchReview({ value }: { value: PurchaseMatch }) {
  if (!value) return null;
  return <div className="grid gap-2 rounded-lg border bg-muted p-3 text-sm">
    <p className="font-medium">PO {value.reference} · version {value.version ?? "awaiting approval"} · {value.state}</p>
    <p className="text-xs">Supplier: {value.supplierName ?? "Awaiting approval"} · receiving profile version {value.supplierVersion ?? "unapproved"}</p>
    <p className="whitespace-pre-wrap text-xs text-muted-foreground">{value.scope ?? "No approved scope"}</p>
    <p>Agreed {usd(value.agreedAllowance)} USDC · current allowance {usd(value.allowance)} · previously invoiced {usd(value.priorInvoiced)} · total PO paid {usd(value.paid)} · remaining allowance {usd(value.remaining)}</p>
    <p className="text-xs">Invoice commercial value {usd(value.invoiceValue)}. Period: {value.period ?? "Needs service date"}. Service date: {value.invoiceDate ?? "Missing"} (UTC).</p>
    {value.accepted && <p className="text-xs">The full invoice value was accepted once against version {value.accepted.version}. Supplier credits, installments, setoff and failed payment routes do not restore this allowance.</p>}
    {value.problems.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-4 text-xs text-destructive">{value.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
    <p className="text-xs text-muted-foreground">Application purchase review gate. This allowance is separate from cash and delivered payments. NEAR payment authorization remains required.</p>
  </div>;
}

function CommitmentForm({ value, pending, onSubmit }: { value?: Commitment; pending: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const { recipients } = useWorkspace(), terms = value?.current ?? value?.versions[0];
  return <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={onSubmit}>
    <Field label="Supplier"><select name="recipientId" className={control} required defaultValue={value?.recipient_id ?? ""} disabled={!!value}><option value="">Choose a company payee</option>{recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></Field>
    <Field label="Purchase reference"><input name="reference" className={control} required maxLength={120} defaultValue={value?.reference} readOnly={!!value} placeholder="PO-1042" /></Field>
    <Field label="Allowance (USDC)"><input name="allowance" className={control} required inputMode="decimal" defaultValue={terms ? usdcInput(terms.allowance) : ""} /></Field>
    <Field label="Allowance period" hint="UTC calendar months reset without rollover."><select name="cadence" className={control} defaultValue={terms?.cadence ?? "total"} disabled={!!value?.current}><option value="total">Total agreement value</option><option value="monthly">Each calendar month</option></select></Field>
    <Field label="Starts on (UTC)"><input name="startsOn" type="date" className={control} required defaultValue={terms?.starts_on} readOnly={!!value?.current} /></Field>
    <Field label="Ends on (UTC, inclusive)"><input name="endsOn" type="date" className={control} required defaultValue={terms?.ends_on} /></Field>
    <div className="sm:col-span-2 lg:col-span-3"><Field label="Approved goods, services and quantity scope"><textarea name="scope" className={control} rows={3} required minLength={3} maxLength={3000} defaultValue={terms?.scope} /></Field></div>
    {value && <Field label="State after approval"><select name="targetState" className={control} defaultValue={value.state === "draft" ? "active" : value.state}><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled permanently</option></select></Field>}
    <Field label={value ? "Reason for amendment or state change" : "Reason for the purchase"}><textarea name="reason" className={control} rows={2} required minLength={3} maxLength={3000} /></Field>
    <div className="flex items-end"><Action busy={pending} disabled={pending || !recipients.length}>{value ? "Submit amendment for review" : "Save purchase proposal"}</Action></div>
  </form>;
}

export function VendorCommitments() {
  const { base, organization, revision, refresh } = useWorkspace();
  const read = organization.permissions?.includes("payments:read") === true, prepare = organization.permissions?.includes("payments:prepare") === true, approve = organization.permissions?.includes("payments:approve") === true;
  const [selected, setSelected] = useState(""), [search, setSearch] = useState(""), [notice, setNotice] = useState("");
  const history = useResource<{ commitments: Commitment[] }>(read ? `${base}/vendor-commitments?search=${encodeURIComponent(search)}` : null, revision);
  const detail = useResource<{ commitment: Review }>(read && selected ? `${base}/vendor-commitments/${selected}` : null, revision);
  const bills = useResource<{ bills: { id: string; reference: string; status: string; acceptedCreditAmount?: string; fundedClearingAmount: string; vendorCommitment: PurchaseMatch }[] }>(read ? `${base}/bills` : null, revision);
  const { busy, error, run } = useAction(), current = detail.data?.commitment;
  const proposal = current?.versions.find(value => value.version === current.pending_version);
  function submitted(values: FormData, value?: Commitment) {
    return { recipientId: value?.recipient_id ?? String(values.get("recipientId")), reference: values.get("reference"), settlementUnit: "USDC", scope: values.get("scope"), allowance: microUsd(String(values.get("allowance"))), cadence: value?.current?.cadence ?? values.get("cadence"), startsOn: values.get("startsOn"), endsOn: values.get("endsOn"), reason: values.get("reason"), targetState: values.get("targetState") ?? "active" };
  }
  useEffect(() => { if (current) document.getElementById("company-commitment-review")?.scrollIntoView({block:"start"}); }, [current?.id]);
  if (!read) return null;
  return <Panel title="Supplier commitments" tone="white" description="Agreed supplier scope, purchasing limits and invoice use." help="Approve vendor scope and USDC limits before invoices arrive. Accepted invoice value consumes the purchasing allowance once.">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><span className="flex items-center gap-2 text-sm"><Building2 size={16} className="text-primary" aria-hidden="true"/>{organization.name}<span className="text-xs text-muted-foreground">Your company · buyer</span></span><AssetIdentity symbol="USDC" network="near"/></div>
    <details className="mb-5 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Purchasing allowance and invoice rules</summary><p className="mt-3 leading-5">Application review gate using the company's payment approvers. This is a purchasing allowance, separate from treasury cash, payment reservations and delivered funds. Existing NEAR payment authority is still required. Monthly limits use the UTC invoice service date, reset each calendar month and never roll over. Accepted liabilities retain their allowance after pause, cancellation, dispute or failed routing.</p></details>

    <form className="mb-4 flex items-end gap-3" onSubmit={event => { event.preventDefault(); setSearch(String(new FormData(event.currentTarget).get("search") ?? "")); }}><Field label="Search purchase references"><input name="search" className={control} maxLength={120} /></Field><Action type="submit">Search</Action>{organization.permissions?.includes("reports:read") && <a className="py-2 text-sm text-primary" href={`/api${base}/vendor-commitments/export`} download>Export history</a>}</form>
    {history.error && <p role="alert" className="mb-3 text-sm text-destructive">{history.error}</p>}
    {history.loading ? <Empty>Loading purchase commitments...</Empty> : history.data?.commitments.length ? <DataTable columns={["Purchase / supplier", "State", "Period allowance", "Remaining", "Review"]}>{history.data.commitments.map(value => <tr key={value.id}><td><p className="font-medium">{value.reference}</p><p className="mt-1 text-xs text-muted-foreground">{value.supplierProfile.name}</p><p className="mt-1 text-xs text-muted-foreground">Version {value.current_version ?? "unapproved"}{value.pending_version ? ` · proposal ${value.pending_version}` : ""}</p></td><td><Status value={value.state} /></td><td>{usd(value.current?.allowance ?? value.versions[0].allowance)}<p className="text-xs text-muted-foreground">{value.current?.cadence ?? value.versions[0].cadence}</p></td><td>{usd(value.remaining)}<p className="text-xs text-muted-foreground">{value.period}</p></td><td><button type="button" className="text-primary" onClick={() => { setSelected(value.id); setNotice(""); }}>Inspect and review</button></td></tr>)}</DataTable> : <Empty>No purchase commitments match this search.</Empty>}
    {detail.error && <p role="alert" className="mt-4 text-sm text-destructive">{detail.error}</p>}
    {detail.loading && <p role="status" className="mt-4 text-sm">Loading purchase history...</p>}
    {current && <div id="company-commitment-review" className="mt-6 scroll-mt-8 grid gap-5 rounded-2xl border bg-muted/30 p-5">
      <div className="flex flex-wrap justify-between gap-3"><h3 className="font-medium">{current.reference}</h3><Status value={current.state} /></div>
      <div className="grid gap-4 rounded-xl bg-white p-4 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Your company · buyer</p><p className="mt-2 text-sm font-medium">{organization.name}</p></div><div><p className="text-xs text-muted-foreground">Supplier counterparty</p><p className="mt-2 text-sm font-medium">{current.supplierProfile.name}</p></div></div>
      <PageMetrics items={[
        {label:"Invoices accepted",value:usd(current.totalInvoiced),asset:"USDC"},
        {label:"Payments delivered",value:usd(current.paid),asset:"USDC"},
        {label:"Purchasing allowance left",value:usd(current.remaining),asset:"USDC",detail:"Allowance is separate from treasury cash"},
      ]}/><details className="text-xs"><summary className="cursor-pointer font-medium">Noncash and escrow-backed settlement breakdown</summary><dl className="mt-3 grid gap-3 sm:grid-cols-3"><div><dt className="text-muted-foreground">Debt setoff</dt><dd className="mt-1">{usd(current.setoff)}</dd></div><div><dt className="text-muted-foreground">Escrow-backed settlement</dt><dd className="mt-1">{usd(current.fundedClearingAmount)}</dd></div><div><dt className="text-muted-foreground">Supplier credits</dt><dd className="mt-1">{usd(current.acceptedCredits)}</dd></div></dl></details>
      {proposal && <div className="grid gap-3 rounded-lg bg-muted p-4 text-sm"><h4 className="font-medium">Review proposal {proposal.version}</h4><p>Supplier: {proposal.supplierName} · profile version {proposal.supplier_version}. Current supplier: {current.supplierProfile.name} · profile version {current.supplierProfile.version}.</p><p>{usd(proposal.allowance)} USDC {proposal.cadence === "monthly" ? "per UTC calendar month" : "total"} · {proposal.starts_on} to {proposal.ends_on} · {proposal.target_state}</p><p className="whitespace-pre-wrap">{proposal.scope}</p><p className="whitespace-pre-wrap">Reason: {proposal.reason}</p><p className="text-xs">Proposed by {proposal.proposed_by}. Approval policy: payments:approve. Review includes existing allowance use and payment history.</p>{approve && <Action type="button" busy={busy === "approve-po"} disabled={!!busy || detail.refreshing} onClick={() => void run("approve-po", async () => { await api(`${base}/vendor-commitments/${current.id}/approve`, { reviewToken: current.reviewToken }); setNotice("Reviewed purchase version approved. It does not fund or execute a payment."); refresh(); })}>Approve this purchase version</Action>}{prepare && <form className="grid gap-3" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("withdraw-po", async () => { await api(`${base}/vendor-commitments/${current.id}/withdraw`, { pendingVersion: current.pending_version, reason: values.get("reason") }); refresh(); }); }}><Field label="Reason to withdraw or correct proposal"><input name="reason" className={control} required minLength={3} maxLength={3000} /></Field><Action busy={busy === "withdraw-po"} disabled={!!busy}>Withdraw proposal and retain history</Action></form>}</div>}
      {prepare && !current.pending_version && current.state !== "cancelled" && <details><summary className="cursor-pointer text-sm font-medium">Amend allowance, scope, dates or state</summary><p className="my-3 text-xs text-muted-foreground">A new reviewed version is required. Historical invoice use is permanent. Supplier, reference, reset period and approved starting date stay fixed. Cancellation cannot be reopened.</p><CommitmentForm key={`${current.id}:${current.current_version}`} value={current} pending={!!busy} onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("amend-po", async () => { await api(`${base}/vendor-commitments/${current.id}/amend`, { ...submitted(values, current), expectedVersion: current.current_version ?? 0 }); setNotice("Amendment proposed. The currently approved version stays in effect until review."); refresh(); }); }} /></details>}
      <details><summary className="cursor-pointer text-sm font-medium">Version and approval history</summary><div className="mt-3 grid gap-3">{current.versions.map(value => <article key={value.version} className="rounded border p-3 text-xs"><p className="font-medium">Version {value.version} · {value.approved_at ? "Approved" : value.withdrawn_at ? "Withdrawn" : "Pending"} · {value.target_state}</p><p className="mt-1">Supplier {value.supplierName} · profile version {value.supplier_version}</p><p className="mt-1">{usd(value.allowance)} {value.cadence} · {value.starts_on} to {value.ends_on}</p><p className="mt-2 whitespace-pre-wrap">{value.scope}</p><p className="mt-2 whitespace-pre-wrap">{value.reason}</p><p className="mt-2 break-all">Proposed {value.proposed_at} by {value.proposed_by}{value.approved_at ? ` · Approved ${value.approved_at} by ${value.approved_by}` : value.withdrawn_at ? ` · Withdrawn ${value.withdrawn_at} by ${value.withdrawn_by}` : ""}</p></article>)}</div></details>
      {current.uses.length > 0 && <DataTable columns={["Invoice", "Period", "Accepted value", "Delivered", "Noncash setoff", "Escrow-backed settlement", "Supplier credit"]}>{current.uses.map(use => <tr key={use.bill_id}><td><span className="break-all text-xs">{use.bill_id}</span><p className="text-xs">PO version {use.version}</p></td><td>{use.period_key}</td><td>{usd(use.amount)}</td><td>{usd(use.paid)}</td><td>{usd(use.setoff)}</td><td>{usd(use.fundedClearingAmount)}</td><td>{usd(use.acceptedCredit)}</td></tr>)}</DataTable>}
      {prepare && <form key={`${current.id}:${revision}`} className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("match-po", async () => { const result = await api<{ match: PurchaseMatch }>(`${base}/vendor-commitments/match/${values.get("billId")}`, { ...purchaseMatchInput(values), reason: values.get("reason") }); setNotice(result.match?.problems.length ? `Match saved and held: ${result.match.problems.join(". ")}` : "Invoice matched. Review the invoice separately to accept its full commercial value."); refresh(); }); }}><Field label="Match an existing unapproved invoice"><select name="billId" className={control} required><option value="">Choose a bill</option>{bills.data?.bills.filter(value => !value.vendorCommitment?.accepted && BigInt(value.acceptedCreditAmount ?? "0") === 0n && BigInt(value.fundedClearingAmount ?? "0") === 0n).map(value => <option key={value.id} value={value.id}>{value.reference} · {value.status}</option>)}</select></Field><PurchaseMatchFields reference={current.reference} date={new Date().toISOString().slice(0, 10)} /><Field label="Reason for this match or correction"><input name="reason" className={control} required minLength={3} maxLength={3000} /></Field><div><Action busy={busy === "match-po"} disabled={!!busy}>Save exact invoice match</Action></div><p className="text-xs text-muted-foreground sm:col-span-2">Correcting a previously named PO requires preparation and approval permissions plus a reason. Overruns require an approved allowance amendment. There is no automatic fallback to another PO.</p></form>}
    </div>}
    {prepare && <details className="mb-5 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Create a purchase commitment</summary><div className="mt-4"><CommitmentForm pending={!!busy} onSubmit={event => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); void run("create-po", async () => { const result = await api<{ commitment: Commitment }>(`${base}/vendor-commitments`, submitted(values)); setSelected(result.commitment.id); form.reset(); setNotice("Proposal saved. Review and approval are required before it covers an invoice."); refresh(); }); }} /></div></details>}
    {notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
    {(error || bills.error) && <p role="alert" className="mt-4 text-sm text-destructive">{error || bills.error}</p>}
  </Panel>;
}
