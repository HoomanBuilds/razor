"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { projectReports } from "@/server/projects/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Empty, Field, Panel } from "./shared";

type Reports = ReturnType<typeof projectReports>;

export function ProjectReportsPanel() {
  const { base, organization, revision, refresh } = useWorkspace();
  const permitted = organization.permissions?.includes("reports:read") && organization.permissions?.includes("payments:read");
  const { data, loading, error: loadError } = useResource<Reports>(permitted ? `${base}/projects` : null, revision);
  const { run, busy, error } = useAction();
  const [selectedId, setSelectedId] = useState("");
  if (!permitted) return null;
  const selected = data?.funding.find(item => item.id === selectedId);
  return <Panel title="Project cash and commitments" description="Confirmed receipts need an explicit classification. Client deposits and internal transfers are separate from earned receipts." action={<a className="text-sm text-primary" href={`/api${base}/projects/export`}>Export project CSV</a>}>
    {(error || loadError) && <p role="alert" className="mb-4 text-sm text-destructive">{error || loadError}</p>}
    {loading ? <Empty>Loading project records...</Empty> : !data?.projects.length ? <Empty>Add a project reference to a bill or classify a confirmed receipt to begin.</Empty> : <DataTable columns={["Project", "Earned receipts", "Client deposits", "Actual source spent", "Noncash setoff", "Escrow-backed discharge", "Open maximum budget", "Unprepared net liability", "Classified cash result"]}>{data.projects.map(project => <tr key={project.reference}><td className="font-medium">{project.reference}</td><td>{usd(project.earnedReceipts)}{project.heldReceipts !== "0" && <p className="mt-1 text-xs text-muted-foreground">{usd(project.heldReceipts)} held for client review</p>}</td><td>{usd(project.clientDeposits)}<p className="mt-1 text-xs text-muted-foreground">Internal transfers: {usd(project.internalTransfers)}</p></td><td>{usd(project.sourceSpent)}</td><td>{usd(project.dischargedDebt)}<p className="mt-1 text-xs text-muted-foreground">Business setoff, no cash transfer</p></td><td>{usd(project.fundedDischargedDebt)}</td><td>{usd(project.openBudget)}<p className="mt-1 text-xs text-muted-foreground">{project.unresolvedPayments} unresolved payments</p></td><td>{usd(project.unpreparedLiability)}<p className="mt-1 text-xs text-muted-foreground">{usd(project.remainingLiability)} remaining invoice principal</p></td><td>{usd(project.cashResult)}</td></tr>)}</DataTable>}
    {data && data.costCenters.length > 0 && <div className="mt-6"><h3 className="mb-3 text-sm font-semibold">Cost center cash and commitments</h3><DataTable columns={["Cost center", "Earned receipts", "Client deposits", "Actual source spent", "Noncash setoff", "Escrow-backed discharge", "Open maximum budget", "Unprepared net liability", "Classified cash result"]}>{data.costCenters.map(value => <tr key={value.reference}><td>{value.reference}</td><td>{usd(value.earnedReceipts)}</td><td>{usd(value.clientDeposits)}</td><td>{usd(value.sourceSpent)}</td><td>{usd(value.dischargedDebt)}</td><td>{usd(value.fundedDischargedDebt)}</td><td>{usd(value.openBudget)}</td><td>{usd(value.unpreparedLiability)}<p className="mt-1 text-xs text-muted-foreground">{usd(value.remainingLiability)} remaining invoice principal</p></td><td>{usd(value.cashResult)}</td></tr>)}</DataTable></div>}
    <p className="mt-4 text-xs text-muted-foreground">The cash result compares classified earned receipts with actual reconciled source spending, including incomplete deliveries. It is not a profit measure. Noncash setoff and escrow-backed company settlement reduce invoice liabilities separately. Escrow creates fixed-owner company credit rights; shared treasury cash and earned revenue require their own receipt evidence. Direct owner-wallet escrow deposits and withdrawals are tracked separately in Business clearing. Open payment budgets include their approved cost ceilings. Unprepared net liability is remaining invoice principal without an active installment or remainder, with no future fees assumed. Client principal and unresolved transfers remain separate. Project and cost-center views overlap and must not be added together.</p>
    {data?.unassignedClientHolds && <p className="mt-3 text-xs text-amber-900">Client earmarks without a linked funding receipt need attribution before new receipts can be classified as earned.</p>}
    {data?.canClassify && <form className="mt-6 grid gap-4 rounded-lg border p-4 md:grid-cols-2" key={`${selected?.id}:${selected?.version}`} onSubmit={event => { event.preventDefault(); if (!selected) return; const form = event.currentTarget, values = new FormData(form); void run("classify", async () => { await api(`${base}/projects/classifications`, { fundingId: selected.id, expectedVersion: selected.version, projectReference: values.get("project"), costCenterReference: values.get("costCenter") || undefined, classification: values.get("classification"), evidence: values.get("evidence") }); refresh(); }); }}>
      <Field label="Verified funding receipt"><select className={control} required value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">Choose a confirmed receipt</option>{data.funding.filter(item => item.verifiedCredit !== "0").map(item => <option key={item.id} value={item.id}>{item.reference} - {usd(item.verifiedCredit)}</option>)}</select></Field>
      <Field label="Project reference"><input className={control} name="project" defaultValue={selected?.projectReference ?? ""} maxLength={120} required /></Field>
      <Field label="Cost center (optional)"><input className={control} name="costCenter" defaultValue={selected?.costCenterReference ?? ""} maxLength={120} /></Field>
      <Field label="Classification"><select className={control} name="classification" defaultValue={selected?.classification ?? "client_deposit"}><option value="client_deposit">Client deposit</option><option value="earned_revenue">Earned revenue</option><option value="internal_transfer">Internal transfer</option></select></Field>
      <Field label="Review evidence"><textarea className={control} name="evidence" defaultValue={selected?.evidence ?? ""} required minLength={3} maxLength={2000} rows={2} /></Field>
      <div className="md:col-span-2"><Action disabled={!!busy || !selected} busy={busy === "classify"}>Save reviewed classification</Action></div>
    </form>}
  </Panel>;
}
