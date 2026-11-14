"use client";

import { useState } from "react";
import { BarChart3, Calculator } from "lucide-react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { CompanyCostComparison, CompanyInsights } from "@/server/insights";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Empty, Field, Panel } from "./shared";

const usdc = (value: string) => `${usd(value).replace("$", "")} USDC`;
const count = (value: number) => value.toLocaleString("en-US");
function defaultWindow() { const to = new Date().toISOString().slice(0, 10); return { from: new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10), to }; }

export function CompanyInsightsPanel() {
  const { organization, base, revision } = useWorkspace();
  const permitted = ["company:read", "payments:read", "reports:read"].every(permission => organization.permissions?.includes(permission));
  if (!permitted) return null;
  return <InsightsContent key={`${organization.id}:${base}`} base={base} revision={revision}/>;
}

function InsightsContent({ base, revision }: { base: string; revision: number }) {
  const [window, setWindow] = useState(defaultWindow), [from, setFrom] = useState(window.from), [to, setTo] = useState(window.to), [basis, setBasis] = useState<"observed" | "manual">("observed");
  const [comparison, setComparison] = useState<CompanyCostComparison | null>(null), { busy, error, run } = useAction();
  const query = new URLSearchParams(window).toString(), resource = useResource<CompanyInsights>(`${base}/insights?${query}`, revision), report = resource.data;
  return <Panel title="Company operations and costs" description="Read-only company aggregates from saved financial records. Dates use UTC. This view does not connect to an analytics service or change payment authority.">
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <form className="flex min-w-0 flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setComparison(null); setWindow({ from, to }); }}>
        <Field label="From, UTC"><input type="date" className={control} value={from} required max={to} disabled={!!busy} onChange={event => setFrom(event.target.value)}/></Field>
        <Field label="Through, UTC"><input type="date" className={control} value={to} required min={from} max={new Date().toISOString().slice(0, 10)} disabled={!!busy} onChange={event => setTo(event.target.value)}/></Field>
        <Action disabled={!!busy}>Apply up to 93 days</Action>
        {report && <a className="text-sm font-medium text-primary underline underline-offset-4" href={`/api${base}/insights/export?${query}`}>Download aggregate CSV</a>}
      </form>
      {(resource.error || error) && <p role="alert" className="break-words rounded-lg border p-3 text-sm text-destructive">{resource.error || error}</p>}
      {resource.loading && !report ? <Empty>Loading company aggregate records...</Empty> : report && <>
        <div className="grid min-w-0 gap-2 rounded-lg bg-muted/40 p-4 text-sm"><p className="flex items-center gap-2 font-medium"><BarChart3 size={18} aria-hidden="true"/>Payment creation cohort: {report.window.from} to {report.window.to}, UTC</p><p>{report.scopes.payments}</p><p className="text-xs text-muted-foreground">Observed {new Date(report.window.observedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC. {count(report.payments.included)} payment records, {count(report.payments.attempted)} with attempts and {count(report.payments.attemptsIncluded)} route-attempt records. No settlement-date cash-flow claim.</p></div>
        {!report.coverage.complete && <p role="status" className="rounded-lg border p-3 text-sm text-amber-900">This is a bounded sample. Narrow the UTC window to see complete totals. Limits reached: {report.coverage.truncated.join(", ")}. Observed comparisons are disabled.</p>}
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
          ["Recorded delivered principal", report.payments.deliveredPrincipal], ["Recorded source spend", report.payments.recordedSourceSpend], ["Signed spend minus delivery", report.payments.signedSpread], ["Confirmed subscription net", report.subscriptions.observedNet],
        ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 break-all text-lg font-semibold tabular-nums">{usdc(value)}</p></div>)}</div>
        <p className="text-xs leading-5 text-muted-foreground">{report.scopes.costs} A positive spread can include route losses; a negative spread is not a refund or rebate. Gas and other unmeasured costs are unavailable, not zero.</p>
        <DataTable columns={["Latest recorded outcome", "Included payment records"]}>{Object.entries(report.payments.outcomes).map(([label, value]) => <tr key={label}><td>{label === "retired" ? "Retired or cancelled, not a delivery failure" : label.charAt(0).toUpperCase() + label.slice(1)}</td><td className="text-right tabular-nums">{count(value)} / {count(report.payments.included)}</td></tr>)}</DataTable>
        <p className="text-sm">Successful among attempted payment records: <strong className="tabular-nums">{count(report.payments.attemptedSuccessRate.numerator)} / {count(report.payments.attemptedSuccessRate.denominator)}</strong>{report.payments.attemptedSuccessRate.basisPoints === null ? ". A percentage is unavailable without attempts." : ` (${(report.payments.attemptedSuccessRate.basisPoints / 100).toFixed(2)}%).`} Partial, held and unresolved states remain separate. Retry attempts are not extra successful payments. A failed route can leave its payment held or approved, so these are payment outcomes rather than route failure statistics.</p>
        <details className="min-w-0 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Closed-route measurements and other financial categories</summary><div className="mt-4 grid min-w-0 gap-4 text-sm sm:grid-cols-2">
          <div className="grid gap-2"><p>{count(report.routing.completedMeasured)} completed payment records have terminal route records; {count(report.routing.completedMissingMeasurements)} successful records lack a complete route sample.</p><p>Route scope: {report.routing.networkScope}.</p><p>Closed-record delivered principal: <span className="tabular-nums">{usdc(report.routing.completedPrincipal)}</span>.</p><p>Closed-record signed spread: <span className="tabular-nums">{usdc(report.routing.signedSpread)}</span>. Negative-spread records: {count(report.routing.negativeSpreadPayments)}.</p></div>
          <div className="grid gap-2"><p>Subscription confirmations: {count(report.subscriptions.confirmedInvoices)}. Gross <span className="tabular-nums">{usdc(report.subscriptions.confirmedPaid)}</span>; observed refunds <span className="tabular-nums">{usdc(report.subscriptions.observedRefunded)}</span>; held for refund review <span className="tabular-nums">{usdc(report.subscriptions.heldForRefundReview)}</span>.</p><p className="text-xs text-muted-foreground">{report.scopes.subscriptions}</p><p>Noncash invoice setoff: <span className="tabular-nums">{usdc(report.discharge.noncashSetoff)}</span>.</p><p>Funded escrow discharge: <span className="tabular-nums">{usdc(report.discharge.fundedEscrow)}</span>.</p><p className="text-xs text-muted-foreground">{report.scopes.discharges}</p><p>Accepted supplier credits: <span className="tabular-nums">{usdc(report.credits.acceptedAmount)}</span> across {count(report.credits.acceptedRecords)} notes.</p><p className="text-xs text-muted-foreground">{report.scopes.credits}</p></div>
        </div></details>
        <details className="min-w-0 rounded-lg border p-4"><summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Calculator size={17} aria-hidden="true"/>Compare an explicit fee assumption</summary>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">Enter a current quote you have reviewed. The calculator makes no competitor-price lookup or cheapest-provider claim. Compare USDC principal, the same payment count, networks, receiving scope and covered services. Percentage fees round up once over aggregate principal to one microUSDC; a provider&apos;s per-payment rounding may differ.</p>
          <form className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" onChange={() => setComparison(null)} onSubmit={event => {
            event.preventDefault(); const values = new FormData(event.currentTarget), optional = (name: string) => String(values.get(name) ?? "").trim();
            const data = { ...window, basis, sameScopeAcknowledged: values.get("sameScopeAcknowledged") === "on", networkScope: values.get("networkScope"), competitorPercent: values.get("competitorPercent"), competitorFixedUSDC: values.get("competitorFixedUSDC"), subscriptionAllocation: values.get("subscriptionAllocation"),
              ...(optional("manualSubscriptionUSDC") ? { manualSubscriptionUSDC: optional("manualSubscriptionUSDC") } : {}), ...(optional("razorOtherCostsUSDC") ? { razorOtherCostsUSDC: optional("razorOtherCostsUSDC") } : {}), ...(optional("competitorOtherCostsUSDC") ? { competitorOtherCostsUSDC: optional("competitorOtherCostsUSDC") } : {}),
              ...(basis === "manual" ? { manualPrincipalUSDC: optional("manualPrincipalUSDC"), manualPaymentCount: Number(optional("manualPaymentCount")), manualRazorRoutingUSDC: optional("manualRazorRoutingUSDC") } : {}) };
            void run("compare", async () => setComparison(await api<CompanyCostComparison>(`${base}/insights/compare`, data)));
          }}>
            <fieldset className="contents" disabled={!!busy}>
            <Field label="Razor cost basis"><select className={control} value={basis} disabled={!!busy} onChange={event => setBasis(event.target.value as "observed" | "manual")}><option value="observed">Recorded closed-route sample</option><option value="manual">My own scenario estimates</option></select></Field>
            <Field label="Network and receiving scope"><input key={`${basis}:${report.routing.networkScope}`} name="networkScope" className={control} maxLength={100} required readOnly={basis === "observed"} defaultValue={basis === "observed" ? report.routing.networkScope : "Native NEAR USDC destinations"}/></Field>
            {basis === "observed" && !report.routing.comparisonAvailable && <p className="text-sm text-amber-900 sm:col-span-2">This cohort cannot provide a reliable observed comparison. Choose a manual scenario and enter its routing-cost estimate, or narrow the window and resolve missing or negative-spread measurements.</p>}
            {basis === "manual" && <><Field label="Scenario principal, USDC"><input className={control} name="manualPrincipalUSDC" inputMode="decimal" required maxLength={80}/></Field><Field label="Scenario payment count"><input className={control} name="manualPaymentCount" type="number" min={1} max={5000} step={1} required/></Field><Field label="Your estimated Razor routing cost, USDC"><input className={control} name="manualRazorRoutingUSDC" inputMode="decimal" required maxLength={80}/></Field></>}
            <Field label="Competitor percentage fee, percent"><input className={control} name="competitorPercent" inputMode="decimal" required placeholder="Enter your quoted percentage" maxLength={10}/></Field>
            <Field label="Competitor fixed fee per payment, USDC"><input className={control} name="competitorFixedUSDC" inputMode="decimal" required placeholder="Enter zero if explicitly quoted" maxLength={80}/></Field>
            <Field label="Razor subscription allocation"><select className={control} name="subscriptionAllocation" defaultValue="none"><option value="none">Exclude subscription costs explicitly</option><option value="confirmed_window">Allocate all confirmed-window net payments</option><option value="manual">Enter an allocated estimate below</option></select></Field>
            <Field label="Manual subscription allocation, USDC" hint="Required only when manual allocation is selected."><input className={control} name="manualSubscriptionUSDC" inputMode="decimal" maxLength={80}/></Field>
            <Field label="Estimated other Razor costs, USDC" hint="Optional. Cover gas, conversion, storage and receiving costs. Blank means unknown."><input className={control} name="razorOtherCostsUSDC" inputMode="decimal" maxLength={80}/></Field>
            <Field label="Estimated other competitor costs, USDC" hint="Optional. Include services outside its quoted fee. Blank means unknown."><input className={control} name="competitorOtherCostsUSDC" inputMode="decimal" maxLength={80}/></Field>
            <label className="flex items-start gap-2 text-xs leading-5 sm:col-span-2"><input type="checkbox" name="sameScopeAcknowledged" required className="mt-1"/>I reviewed the same amount, currency, payment count, networks and services. Entered prices and additional costs are assumptions, not observed savings.</label>
            <div><Action busy={busy === "compare"} disabled={!!busy || resource.refreshing || basis === "observed" && !report.routing.comparisonAvailable}>Calculate explicit comparison</Action></div>
            </fieldset>
          </form>
          {comparison && <div role="status" className="mt-5 grid min-w-0 gap-3 rounded-lg bg-muted/50 p-4 text-sm"><p className="font-medium">{comparison.basis === "manual" ? "Entered scenario estimate" : "Recorded route subtotal with entered comparison estimates"}</p><p>{count(comparison.paymentCount)} payments; {usdc(comparison.principal)} principal. Scope: {comparison.networkScope}. Snapshot {new Date(comparison.window.observedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC.</p><p>Razor route subtotal: {usdc(comparison.routingCost)}. Allocated subscription: {usdc(comparison.allocatedSubscription)} ({comparison.subscriptionAllocation.replaceAll("_", " ")}).</p><p>Competitor fee estimate: {usdc(comparison.competitorFeeEstimate)}.</p><p className="tabular-nums">Competitor minus Razor subtotal before unknown costs: {usdc(comparison.differenceBeforeUnknownCosts)}.</p>{comparison.estimatedDifferenceWithEnteredCosts === null ? <p>Complete estimated difference unavailable. One or both providers&apos; additional costs remain unknown.</p> : <p className="tabular-nums">Difference including your additional cost estimates: {usdc(comparison.estimatedDifferenceWithEnteredCosts)}.</p>}<p className="text-xs leading-5 text-muted-foreground">{comparison.notice}</p></div>}
        </details>
        <p className="text-xs leading-5 text-muted-foreground">{report.scopes.privacy} Receiving access stays separate from company subscriptions. These aggregate records are not independent live-chain verification or a complete cash-flow statement.</p>
      </>}
    </div>
  </Panel>;
}
