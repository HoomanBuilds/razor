"use client";

import { appHref } from "@/lib/demo-scope";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { projectReports } from "@/server/projects/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Empty, Field, Panel } from "./shared";
import { TaskDrawer, closeTaskDrawer, openTaskDrawer } from "./task-drawer";

type Reports = ReturnType<typeof projectReports>;
export function ProjectReportsPanel() {
  const { base, organization, revision, refresh } = useWorkspace();
  const permitted = organization.permissions?.includes("reports:read") && organization.permissions?.includes("payments:read");
  const { data, loading, error: loadError } = useResource<Reports>(permitted ? `${base}/projects` : null, revision);
  const { run, busy, error } = useAction();
  const [selectedId, setSelectedId] = useState(""), [category, setCategory] = useState<"projects" | "costCenters">("projects"), [reference, setReference] = useState("");
  if (!permitted) return null;
  const selected = data?.funding.find(item => item.id === selectedId);
  const records = category === "projects" ? data?.projects : data?.costCenters;
  const report = records?.find(item => item.reference === reference);
  return <><Panel title="Project cash" tone="white" action={<a className="min-h-10 text-sm text-primary" href={appHref(`/api${base}/projects/export`)} download>Export CSV</a>}>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div role="group" aria-label="Project report grouping" className="flex gap-1 rounded-full bg-muted p-1">{([['projects', 'Projects'], ['costCenters', 'Cost centers']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={category === value} onClick={() => { setCategory(value); setReference(""); }} className={`min-h-9 rounded-full px-4 text-xs font-medium ${category === value ? "bg-foreground text-white" : "text-muted-foreground"}`}>{label}</button>)}</div>{data?.canClassify && <Action type="button" onClick={() => openTaskDrawer("project-classification")}>Classify receipt</Action>}</div>
    {loadError && <p role="alert" className="mb-4 text-sm text-destructive">{loadError}</p>}
    {category === "costCenters" && <p className="mb-4 text-xs text-muted-foreground">Alternate view of project records. Do not add both totals.</p>}
    {loading ? <Empty>Loading reports...</Empty> : !records?.length ? <Empty>No {category === "projects" ? "project" : "cost-center"} records yet.</Empty> : <div className="divide-y">{records.map(item => <article key={item.reference} className="grid gap-4 py-5"><div className="flex items-center justify-between gap-4"><h3 className="text-sm font-medium">{item.reference}</h3><button type="button" className="shrink-0 text-sm text-primary" onClick={() => { setReference(item.reference); openTaskDrawer("project-report-details"); }}>Details<ChevronRight size={15} className="ml-1 inline"/></button></div><dl className="grid grid-cols-3 gap-3 text-sm">{[["Earned receipts", item.earnedReceipts], ["Source spent", item.sourceSpent], ["Cash result", item.cashResult]].map(([label, amount]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1.5 break-words font-medium tabular-nums">{usd(amount)}</dd></div>)}</dl></article>)}</div>}
    <p className="mt-4 text-xs text-muted-foreground">USDC · Cash result is not profit.</p>
  </Panel>
  <TaskDrawer id="project-report-details" title={reference || "Project report"}>{report && <div key={`${category}:${report.reference}`} className="grid gap-5"><dl className="grid gap-3 text-sm">{[["Earned receipts", report.earnedReceipts], ["Receipts held for review", report.heldReceipts], ["Client deposits", report.clientDeposits], ["Internal transfers", report.internalTransfers], ["Actual source spent", report.sourceSpent], ["Open budget incl. cost limits", report.openBudget], ["Cash result (not profit)", report.cashResult]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{usd(value)}</dd></div>)}</dl><div className="border-t pt-5"><h3 className="mb-4 text-sm font-medium">Invoice liabilities</h3><dl className="grid gap-3 text-sm">{[["Noncash debt offset", report.dischargedDebt], ["Escrow-backed discharge", report.fundedDischargedDebt], ["Accepted supplier credits", report.acceptedCredits], ["Unprepared liability", report.unpreparedLiability], ["Remaining principal", report.remainingLiability]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{usd(value)}</dd></div>)}</dl><p className="mt-4 text-xs text-muted-foreground">{report.unresolvedPayments} unresolved payments. Debt reductions do not restore spent cash.</p></div></div>}</TaskDrawer>
  <TaskDrawer id="project-classification" title="Classify receipt">{data?.canClassify && <form aria-busy={!!busy} className="grid gap-4" key={`${selected?.id}:${selected?.version}`} onSubmit={event => { event.preventDefault(); if (!selected) return; const values = new FormData(event.currentTarget); void run("classify", async () => { await api(`${base}/projects/classifications`, { fundingId: selected.id, expectedVersion: selected.version, projectReference: values.get("project"), costCenterReference: values.get("costCenter") || undefined, classification: values.get("classification"), evidence: values.get("evidence") }); closeTaskDrawer("project-classification", true); refresh(); }); }}>
    {data.unassignedClientHolds && <p role="alert" className="text-sm text-amber-900">Attribute unlinked client earmarks before classifying earned receipts.</p>}
    <fieldset disabled={!!busy} className="contents"><Field label="Confirmed receipt"><select className={control} required value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">Choose receipt</option>{data.funding.filter(item => item.verifiedCredit !== "0").map(item => <option key={item.id} value={item.id}>{item.reference} · {usd(item.verifiedCredit)}</option>)}</select></Field>
    {selected && <><div className="grid gap-4 sm:grid-cols-2"><Field label="Project"><input className={control} name="project" defaultValue={selected.projectReference ?? ""} maxLength={120} required/></Field><Field label="Cost center (optional)"><input className={control} name="costCenter" defaultValue={selected.costCenterReference ?? ""} maxLength={120}/></Field></div><Field label="Classification"><select className={control} name="classification" defaultValue={selected.classification ?? "client_deposit"}><option value="client_deposit">Client deposit</option><option value="earned_revenue">Earned revenue</option><option value="internal_transfer">Internal transfer</option></select></Field><Field label="Evidence"><textarea className={control} name="evidence" defaultValue={selected.evidence ?? ""} required minLength={3} maxLength={2000} rows={3}/></Field><Action className="justify-self-end" disabled={!!busy} busy={busy === "classify"}>Save classification</Action></>}
    </fieldset>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>}</TaskDrawer></>;
}
