"use client";

import { useState } from "react";
import { paymentLabel } from "@/lib/payment-label";
import { api, RequestError } from "@/lib/api";
import { dateLabel, microUsd, usd } from "@/lib/format";
import type { PublicFundingRequest } from "@/server/funding-requests/types";
import { FundingPagination, type FundingPageInfo } from "./funding-pagination";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Empty, Field, Panel, Status } from "./shared";
import type { Payment } from "./types";

interface CompanyRequest extends PublicFundingRequest {
  paymentId: string | null; createdAt: string;
  funding: { id: string; status: string; expected_output: string; credited_amount: string; reference: string }[];
}
interface CreatedLink { request: CompanyRequest; link: { token: string; path: string } }

export function FundingRequestsPanel() {
  const { base, revision, refresh, organization, notify, navigate } = useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") ?? false;
  const canManage = Boolean(organization.permissions?.includes("company:manage") && organization.permissions.includes("payments:prepare"));
  const [page, setPage] = useState(1), [paymentPage, setPaymentPage] = useState(1);
  const resource = useResource<{ requests: CompanyRequest[] } & FundingPageInfo>(canRead ? `${base}/funding-requests?page=${page}&pageSize=25` : null, revision);
  const payments = useResource<{ payments: Payment[] } & FundingPageInfo>(canRead && canManage ? `${base}/payments?page=${paymentPage}&pageSize=50` : null, revision);
  const { busy, error, run } = useAction();
  const [created, setCreated] = useState<CreatedLink | null>(null), [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
  if (!canRead) return null;
  return <div className="grid gap-6">
    {canManage && <Panel title="Request company funding" description="Share a fixed USDC funding amount with a client or teammate. They choose a supported source asset and fund your verified NEAR treasury."><form className="grid gap-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); void run("create", async () => { let amount: string; try { amount = microUsd(String(values.get("amount"))); } catch (cause) { throw new RequestError((cause as Error).message, 422, "INVALID_AMOUNT"); } const result = await api<CreatedLink>(`${base}/funding-requests`, { amount, purpose: values.get("purpose"), expiresAt: new Date(Date.now() + Number(values.get("days")) * 86_400_000).toISOString(), paymentId: values.get("payment") || undefined }); setCreated(result); setSelectedPayment(null); setPage(1); form.reset(); refresh(); notify("Funding link created."); }); }}>
      <Field label="Requested USDC"><input className={control} name="amount" required inputMode="decimal" placeholder="2500.00" /></Field>
      <Field label="Link expires"><select className={control} name="days" defaultValue="7"><option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option></select></Field>
      <Field label="Shared funding purpose" hint="Anyone with the link sees this purpose. Keep individual payroll details in your workspace."><input className={control} name="purpose" required maxLength={500} placeholder="Project deposit or company top-up" /></Field>
      <Field label="Linked unpaid obligation (optional)"><select className={control} name="payment" value={selectedPayment?.id ?? ""} onChange={event=>setSelectedPayment(payments.data?.payments.find(payment=>payment.id===event.target.value) ?? null)}><option value="">General company funding</option>{selectedPayment&&!payments.data?.payments.some(payment=>payment.id===selectedPayment.id)&&<option value={selectedPayment.id}>{paymentLabel(selectedPayment)} - {usd(selectedPayment.amount)} (selected)</option>}{payments.data?.payments.filter((payment) => !["paid", "cancelled", "partially_paid"].includes(payment.status)).map((payment) => <option key={payment.id} value={payment.id}>{paymentLabel(payment)} - {usd(payment.amount)}</option>)}</select></Field>
      <div className="md:col-span-2"><FundingPagination data={payments.data} loading={payments.refreshing} onPageChange={setPaymentPage} label="Linked obligation choices"/></div>
      <div className="md:col-span-2"><Action disabled={!!busy} busy={busy === "create"}>Create funding link</Action></div>
    </form></Panel>}
    {error && <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">{error}</p>}
    {created && <Panel title="Share this funding link" description="The link authorizes funding this fixed request. It gives no access to your company ledger or payment approvals."><div className="flex flex-wrap gap-3"><input className={`${control} flex-1 font-mono text-xs`} aria-label="Shareable funding link" readOnly value={typeof window === "undefined" ? created.link.path : new URL(created.link.path, window.location.origin).toString()} onFocus={(event) => event.target.select()} /><Action disabled={!!busy} busy={busy === "copy"} onClick={() => void run("copy", async () => { try { await navigator.clipboard.writeText(new URL(created.link.path, window.location.origin).toString()); } catch { throw new RequestError("Select and copy the funding link from the field above.", 409, "COPY_UNAVAILABLE"); } notify("Funding link copied."); })}>Copy link</Action><a className="self-center text-sm text-primary" href={created.link.path} target="_blank" rel="noreferrer">Open funding page</a></div><p className="mt-3 text-sm">{usd(created.request.amount)} USDC for {created.request.purpose}. Expires {dateLabel(created.request.expiresAt)}.</p><p className="mt-2 text-xs text-muted-foreground">The raw link is shown here once. Replace an unused link from the request list if you need another copy later.</p></Panel>}
    <Panel title="Funding requests" description="Track each request's own funding legs. Fulfillment requires final native-USDC receipts; a provider report stays pending.">
      {resource.error && <p role="alert" className="text-sm text-destructive">{resource.error}</p>}
      {resource.loading ? <Empty>Loading funding requests...</Empty> : !resource.data?.requests.length ? <Empty>Create a fixed funding link after verifying and registering your NEAR company treasury.</Empty> : <DataTable columns={["Purpose", "Requested", "Confirmed", "Expires", "State", "Actions"]}>{resource.data.requests.map((request) => <tr key={request.id}><td className="max-w-64"><p className="font-medium">{request.purpose}</p><p className="mt-1 text-xs text-muted-foreground">{request.funding.length} matched funding legs</p>{request.funding.map((leg) => <div className="mt-2 text-xs" key={leg.id}><Status value={leg.status} /><span className="ml-2">{usd(leg.credited_amount)} credited</span></div>)}</td><td>{usd(request.amount)}</td><td>{usd(request.confirmedAmount)}</td><td>{dateLabel(request.expiresAt)}</td><td><Status value={request.status} /></td><td><div className="flex flex-wrap gap-2">{canManage && !["fulfilled", "expired", "revoked", "payment_closed"].includes(request.status) && <><Action disabled={!!busy || !!request.activeFunding || request.status === "paused"} busy={busy === `link-${request.id}`} onClick={() => void run(`link-${request.id}`, async () => { setCreated(await api<CreatedLink>(`${base}/funding-requests/${request.id}/rotate-link`, {})); refresh(); })}>Replace link</Action><button className="text-sm text-primary" disabled={!!busy} onClick={() => void run(request.id, async () => { await api(`${base}/funding-requests/${request.id}/revoke`, {}); if (created?.request.id === request.id) setCreated(null); refresh(); })}>Revoke link</button></>}<button className="text-sm text-primary" onClick={() => navigate("treasury")}>Review funding</button></div></td></tr>)}</DataTable>}
      <FundingPagination data={resource.data} loading={resource.refreshing} onPageChange={setPage} label="Funding request pages"/>
    </Panel>
  </div>;
}
