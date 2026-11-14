"use client";

import { useRef, useState } from "react";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer } from "./task-drawer";
import { api, RequestError } from "@/lib/api";
import { PageMetrics } from "./page-metrics";
import { microUsd, usd } from "@/lib/format";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Empty, Field, Panel, Status } from "./shared";

interface ClientReserve {
  id: string; amount: string; purpose: string; clientReference: string | null; fundingId: string | null;
  paymentId: string | null; paymentReference: string | null; paymentStatus: string | null; state: string;
  clientReserved: string; paymentCovered: string; principalInFlight: string; outstandingPrincipal: string;
  releaseReason: string | null;
}
interface Treasury { balance: string; available: string; paymentReserved: string; clientReserved: string; reserveDeficit: string }
interface Candidate { id: string; reference: string; amount: string; max_fee: string; status: string; approved_at: string | null }

export function ClientReservesPanel() {
  const { base, revision, refresh, notify, navigate, organization } = useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const canApprove = organization.permissions?.includes("payments:approve") === true;
  const resource = useResource<{ reserves: ClientReserve[]; treasury: Treasury; canManage: boolean }>(canRead ? `${base}/client-reserves` : null, revision);
  const payments = useResource<{ payments: Candidate[] }>(canRead && canApprove ? `${base}/payments` : null, revision);
  const funding = useResource<{ funding: { id: string; reference: string; status: string; credited_amount: string }[] }>(canRead && canApprove ? `${base}/funding` : null, revision);
  const { busy, error, run } = useAction();
  const createKey = useRef("");
  const [allocation, setAllocation] = useState<{ reserve: ClientReserve; key: string } | null>(null);
  const [release, setRelease] = useState<{ reserve: ClientReserve; key: string } | null>(null);
  const data = resource.data;
  const canManage = canApprove && data?.canManage;
  if (!canRead) return null;
  return <div className="grid gap-6">
    <Panel title="Client funds and operating cash" tone="white" description={`${organization.name} treasury`} help="Client earmarks are application bookkeeping reservations. The NEAR owner contract controls actual funds; creating a reservation neither adds income nor transfers tokens.">
      {resource.error && <p role="alert" className="text-sm text-destructive">{resource.error}</p>}
      <PageMetrics items={[
        {label:"Reserved for clients",value:data ? usd(data.treasury.clientReserved) : resource.error ? "Unavailable" : null,asset:"USDC"},
        {label:"Existing payment reservations",value:data ? usd(data.treasury.paymentReserved) : resource.error ? "Unavailable" : null,asset:"USDC"},
        {label:"Spendable operating cash",value:data ? usd(data.treasury.available) : resource.error ? "Unavailable" : null,asset:"USDC"},
      ]}/><p className="mt-4 text-xs leading-5 text-muted-foreground">Client principal stays reserved for its stated purpose, separate from your available operating funds.</p>
      {data && BigInt(data.treasury.reserveDeficit) > 0n && <p role="status" className="mt-4 rounded-lg border border-amber-200 p-3 text-sm text-amber-900">Confirmed cash is {usd(data.treasury.reserveDeficit)} below the recorded cash commitments. Fund or reconcile this deficit before allocating more.</p>}
    </Panel>
    <Panel title="Client principal" tone="white" description="Client reference, purpose and payment coverage in one place." action={canManage ? <Action type="button" onClick={()=>openTaskDrawer("client-reserve-create-flow")}>Reserve client cash</Action> : undefined} help="Principal covered by a payment reservation or a proven in-flight source is counted once. Cancellation restores the earmark while paid principal closes it.">
      {resource.loading ? <Empty>Loading client earmarks...</Empty> : !data?.reserves.length ? <Empty>No client cash earmarks yet.</Empty> : <DataTable columns={["Client and purpose", "Principal", "Cash held", "Payment coverage", "State", "Action"]}>{data.reserves.map((reserve) => <tr key={reserve.id}><td className="max-w-64"><p className="font-medium">{reserve.clientReference ?? "Client funds"}</p><p className="mt-1 text-xs text-muted-foreground">{reserve.purpose}</p>{reserve.releaseReason && <p className="mt-2 text-xs">Release: {reserve.releaseReason}</p>}</td><td className="tabular-nums">{usd(reserve.amount)}</td><td className="tabular-nums">{usd(reserve.clientReserved)}</td><td><p className="text-xs">{usd(reserve.paymentCovered)} reserved</p><p className="mt-1 text-xs">{usd(reserve.principalInFlight)} in flight</p><p className="mt-1 text-xs text-muted-foreground">{reserve.paymentReference ?? "Unallocated"}</p></td><td><Status value={reserve.state} />{reserve.state === "terms_changed" && <p className="mt-2 max-w-48 text-xs text-amber-900">Review the changed obligation before releasing or replacing this earmark.</p>}</td><td>{canManage && !["released", "closed"].includes(reserve.state) && <div className="flex flex-wrap gap-2">{reserve.outstandingPrincipal === reserve.amount ? <Action disabled={!!busy || ["in_flight", "terms_changed", "ambiguous_lineage"].includes(reserve.state)} onClick={() => { setRelease(null); setAllocation({ reserve, key: crypto.randomUUID() }); }}>Allocate</Action> : <button type="button" className="text-sm text-primary" onClick={() => navigate("payments")}>View remaining payment</button>}<button className="text-sm text-primary" disabled={!!busy} onClick={() => { setAllocation(null); setRelease({ reserve, key: crypto.randomUUID() }); }}>Release with reason</button></div>}</td></tr>)}</DataTable>}
    </Panel>
    {canManage && <TaskDrawer id="client-reserve-create-flow" title="Reserve client cash" description="Classify existing confirmed funds for an agreed client purpose."><div aria-busy={!!busy}><Panel title="Reserve cash for a client" description="Classify existing confirmed cash for an agreed purpose." help="A funding receipt provides provenance. Creating an earmark does not add income, change the treasury balance or transfer funds."><form className="grid gap-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); if (!createKey.current) createKey.current = crypto.randomUUID(); void run("create", async () => { let amount: string; try { amount = microUsd(String(values.get("amount"))); } catch (cause) { throw new RequestError((cause as Error).message, 422, "INVALID_AMOUNT"); } await api(`${base}/client-reserves`, { idempotencyKey: createKey.current, amount, purpose: values.get("purpose"), clientReference: values.get("client") || undefined, fundingId: values.get("funding") || undefined, paymentId: values.get("payment") || undefined }); createKey.current = ""; form.reset();closeTaskDrawer("client-reserve-create-flow",true); refresh(); notify("Client cash earmarked."); }); }}>
      <Field label="Client principal (USDC)"><input className={control} name="amount" required inputMode="decimal" placeholder="1000.00" /></Field><Field label="Private client reference"><input className={control} name="client" maxLength={200} placeholder="Client or project reference" /></Field>
      <Field label="Earmark purpose"><input className={control} name="purpose" required maxLength={500} placeholder="Client funds held for supplier delivery" /></Field><Field label="Confirmed funding receipt (optional)"><select className={control} name="funding"><option value="">From available confirmed cash</option>{funding.data?.funding.filter((item) => item.status === "confirmed").map((item) => <option key={item.id} value={item.id}>{item.reference} - {usd(item.credited_amount)}</option>)}</select></Field>
      <Field label="Exact unpaid obligation (optional)"><select className={control} name="payment"><option value="">Link when allocating</option>{payments.data?.payments.filter((payment) => !["paid", "cancelled", "partially_paid"].includes(payment.status)).map((payment) => <option key={payment.id} value={payment.id}>{payment.reference} - {usd(payment.amount)}</option>)}</select></Field>
      <div className="flex items-end"><Action disabled={!!busy} busy={busy === "create"}>Create client earmark</Action></div>
    </form></Panel>{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}</div></TaskDrawer>}
    {error && <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">{error}</p>}
    {canManage && allocation && <Panel title="Review client allocation" tone="brand" description="The exact principal moves from the client earmark into the existing payment reservation. Company operating cash covers the approved payment costs."><form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("allocate", async () => { await api(`${base}/client-reserves/${allocation.reserve.id}/allocate`, { idempotencyKey: allocation.key, paymentId: values.get("payment") }); setAllocation(null); refresh(); notify("Client earmark allocated to the approved obligation."); }); }}><Field label={`Approved obligation for ${usd(allocation.reserve.amount)} principal`}><select className={control} name="payment" required><option value="">Choose an approved obligation</option>{payments.data?.payments.filter((payment) => payment.amount === allocation.reserve.amount && !!payment.approved_at && ["approved_unfunded", "approved"].includes(payment.status) && (!allocation.reserve.paymentId || payment.id === allocation.reserve.paymentId)).map((payment) => <option key={payment.id} value={payment.id}>{payment.reference} - costs up to {usd(payment.max_fee)}</option>)}</select></Field><div className="flex items-end gap-3"><Action disabled={!!busy} busy={busy === "allocate"}>Allocate earmark</Action><button className="text-sm text-primary" type="button" disabled={!!busy} onClick={() => setAllocation(null)}>Cancel</button></div></form><p className="mt-4 text-xs text-muted-foreground">If costs remain unfunded, the client earmark stays held. Underlying invoice and pay-run review remains required.</p></Panel>}
    {canManage && release && <Panel title="Review reservation release" tone="brand" description="Record why this cash classification is changing. Releasing an earmark does not prove a token transfer or client settlement."><form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("release", async () => { await api(`${base}/client-reserves/${release.reserve.id}/release`, { idempotencyKey: release.key, reason: values.get("reason") }); setRelease(null); refresh(); notify("Client earmark release recorded."); }); }}><Field label="Release reason"><textarea className={control} name="reason" required minLength={3} maxLength={2000} rows={2} /></Field><div className="flex gap-3"><Action disabled={!!busy} busy={busy === "release"}>Record release</Action><button className="text-sm text-primary" type="button" disabled={!!busy} onClick={() => setRelease(null)}>Cancel</button></div></form></Panel>}

  </div>;
}
