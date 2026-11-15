"use client";

import { appHref } from "@/lib/demo-scope";

import { useState } from "react";
import { WorkspaceTabs } from "./workspace-tabs";
import { TokenLogo } from "@/components/assets/asset-identity";
import { BarChart3, Calculator, Download } from "lucide-react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { CompanyCostComparison, CompanyInsights } from "@/server/insights";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Empty, Field, Panel } from "./shared";

const usdc = (value: string) => `${usd(value).replace("$", "")} USDC`;
const count = (value: number) => value.toLocaleString("en-US");
function defaultWindow() { const to = new Date().toISOString().slice(0, 10); return { from: new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10), to }; }

function exactUnits(value:string,decimals:number) {
  const text=BigInt(value).toString().padStart(decimals+1,"0");
  return decimals?`${text.slice(0,-decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/,""):text;
}

function ObservedCostEvidence({costs,from,to}:{costs:CompanyInsights["observedCosts"];from:string;to:string}) {
  const valuation=costs.valuation;
  return <section className="grid min-w-0 gap-5" aria-labelledby="observed-costs-heading"><div><h3 id="observed-costs-heading" className="text-base font-medium">Observed NEAR fees</h3><p className="mt-1 text-xs text-muted-foreground">{from} to {to} · UTC</p></div><div className="grid gap-4 sm:grid-cols-2">{costs.networks.map(network => <article key={network.network} className="rounded-2xl border p-5"><p className="text-sm font-medium">{network.network === "mainnet" ? "Mainnet" : "Testnet (no monetary value)"}</p><p className="mt-3 break-words text-2xl font-medium tabular-nums">{network.actualBurnAtomic === null ? "Not observed" : `${exactUnits(network.actualBurnAtomic,24)} NEAR`}</p><p className="mt-2 text-xs text-muted-foreground">{count(network.transactions)} transactions · {count(network.feePayers)} payers</p><details className="mt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Sample details</summary><dl className="mt-3 grid gap-2"><div className="flex justify-between"><dt>Payment references</dt><dd>{count(network.paymentReferences)}</dd></div><div className="flex justify-between"><dt>Funding references</dt><dd>{count(network.fundingReferences)}</dd></div>{network.actualBurnAtomic !== null && <div><dt>Exact burn (yoctoNEAR)</dt><dd className="mt-1 break-all font-mono">{network.actualBurnAtomic}</dd></div>}</dl></details></article>)}</div>
    {!costs.coverage.complete && <p role="status" className="text-sm text-amber-900">Incomplete fee sample. {costs.coverage.truncated.length ? "Narrow the date range. " : ""}{count(costs.coverage.invalidOrConflictingRecords)} invalid or conflicting records excluded.</p>}
    <div className="rounded-2xl bg-muted/50 p-5"><p className="text-xs text-muted-foreground">Reviewed USDC valuation estimate</p><p className="mt-2 text-2xl font-medium tabular-nums">{valuation.estimatedMicroUSDC === null ? "Unavailable" : usdc(valuation.estimatedMicroUSDC)}</p><p className="mt-2 text-xs text-muted-foreground">{count(valuation.transactionsCovered)} / {count(costs.networks.find(network => network.network === "mainnet")?.transactions || 0)} mainnet observations valued. Accounting estimate, not USDC spent.</p></div>
    <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Scope and valuation policy</summary><div className="mt-4 grid gap-4 leading-5"><p>{costs.scope}</p><p>{costs.limits}</p><p>Native burn excludes locked storage and attached deposits. Other-source gas, conversion, receiving fees and an all-in total remain unavailable.</p><p>{valuation.basis}</p><dl className="grid gap-2">{[["Approved groups", valuation.approvedGroups], ["Posted groups", valuation.postedGroups], ["Exact groups", valuation.exactGroups], ["Half-even rounded groups", valuation.halfEvenToCentGroups], ["Unvalued mainnet transactions", valuation.unvaluedMainnetTransactions], ["Precision-held groups", valuation.precisionHeldGroups], ["Conflicting groups", valuation.conflictingGroups], ["Boundary groups", valuation.boundaryGroups], ["Invalid groups", valuation.invalidGroups], ["Evidence rows", costs.coverage.includedRecords], ["Unique transactions", costs.coverage.verifiedUniqueTransactions], ["Duplicates excluded", costs.coverage.duplicateRecordsExcluded]].map(([label,value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd>{count(Number(value))}</dd></div>)}</dl><p>{valuation.inspectionComplete ? "Approved-view inspection complete." : "Narrow the range to inspect every approved view."}</p>{valuation.rateDates.length > 0 && <p>Rate dates: {valuation.rateDates.join(", ")}</p>}{costs.coverage.truncated.length > 0 && <p>Inspection limits: {costs.coverage.truncated.join(", ")}</p>}<div className="divide-y">{valuation.functionalCurrencies.map(currency => <div key={currency.currency} className="flex flex-wrap items-center justify-between gap-3 py-3"><span>{currency.currency}</span><span className="tabular-nums">{exactUnits(currency.functionalCents,2)} · {count(currency.approvedGroups)} groups</span></div>)}</div></div></details>
  </section>;
}

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
  return <Panel title="Company insights" tone="white">
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <form className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between" onSubmit={event => { event.preventDefault(); setComparison(null); setWindow({ from, to }); }}>
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-[11rem_11rem]">
        <Field label="From (UTC)"><input type="date" className={control} value={from} required max={to} disabled={!!busy} onChange={event => setFrom(event.target.value)}/></Field>
        <Field label="To (UTC)"><input type="date" className={control} value={to} required min={from} max={new Date().toISOString().slice(0, 10)} disabled={!!busy} onChange={event => setTo(event.target.value)}/></Field>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2"><Action className="min-h-11 px-5" disabled={!!busy}>Apply dates</Action>
        {report && <a className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border bg-white px-4 text-sm font-medium transition-colors hover:bg-muted" href={appHref(`/api${base}/insights/export?${query}`)}><Download size={15} aria-hidden="true"/>Export CSV</a>}</div>
      </form>
      {(resource.error || error) && <p role="alert" className="break-words rounded-xl border border-border bg-white p-4 text-sm text-destructive">{resource.error || error}</p>}
      {resource.loading && !report ? <Empty>Loading insights...</Empty> : report && <>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted/50 px-4 py-3"><p className="flex items-center gap-2 text-xs font-medium"><BarChart3 size={16} aria-hidden="true"/>{count(report.payments.included)} payment records · Created {report.window.from} to {report.window.to}, UTC</p><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Measurement scope</summary><div className="mt-3 max-w-3xl space-y-2 leading-5"><p>{report.scopes.payments}</p><p>Observed {new Date(report.window.observedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC. {count(report.payments.attempted)} records with attempts; {count(report.payments.attemptsIncluded)} route-attempt records. These are creation-date cohorts, not settlement-date cash flows.</p><p>{report.scopes.privacy} These aggregates do not change payment authority or provide independent chain verification.</p></div></details></div>
        {!report.coverage.complete && <p role="status" className="rounded-xl border border-border bg-white p-4 text-sm text-amber-900">Incomplete sample. Narrow the UTC range. Limits: {report.coverage.truncated.join(", ")}. Observed comparisons are disabled.</p>}
        <WorkspaceTabs tabs={[
          {label:"Payment outcomes",content:<div className="grid min-w-0 gap-5"><div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
          ["Delivered principal", report.payments.deliveredPrincipal], ["Source spent", report.payments.recordedSourceSpend], ["Spend minus delivery", report.payments.signedSpread], ["Subscription net", report.subscriptions.observedNet],
        ].map(([label, value]) => <div key={label} className="min-w-0 rounded-2xl border border-border bg-white p-5"><div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{label}</p><TokenLogo symbol="USDC" size={18}/></div><p className="mt-3 break-words text-2xl font-normal tracking-tight tabular-nums">{usdc(value)}</p></div>)}</div>
        <div className="text-xs leading-5 text-muted-foreground">Recorded spend minus delivery is not a network fee. Unobserved gas and other costs remain unknown.<details className="mt-2"><summary className="cursor-pointer font-medium">Cost measurement details</summary><p className="mt-2">{report.scopes.costs} A positive spread can include route losses; a negative spread is not a refund or rebate. NEAR fee observations use a separate date cohort.</p></details></div>

        <div className="divide-y">{Object.entries(report.payments.outcomes).map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 py-3 text-sm"><span className="capitalize">{label === "retired" ? "Retired / cancelled" : label.replaceAll("_", " ")}</span><span className="tabular-nums">{count(value)} <span className="text-muted-foreground">/ {count(report.payments.included)}</span></span></div>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted/50 p-4 text-sm"><span>Successful among attempted</span><strong className="tabular-nums">{count(report.payments.attemptedSuccessRate.numerator)} / {count(report.payments.attemptedSuccessRate.denominator)}{report.payments.attemptedSuccessRate.basisPoints !== null ? ` (${(report.payments.attemptedSuccessRate.basisPoints / 100).toFixed(2)}%)` : ""}</strong></div>
        <details className="min-w-0 rounded-2xl border border-border bg-white p-5"><summary className="cursor-pointer text-sm font-medium">Route and bookkeeping details</summary><div className="mt-4 grid min-w-0 gap-4 text-sm sm:grid-cols-2">
          <div className="grid gap-2"><p>{count(report.routing.completedMeasured)} completed payment records have terminal route records; {count(report.routing.completedMissingMeasurements)} successful records lack a complete route sample.</p><p>Route scope: {report.routing.networkScope}.</p><p>Closed-record delivered principal: <span className="tabular-nums">{usdc(report.routing.completedPrincipal)}</span>.</p><p>Closed-record signed spread: <span className="tabular-nums">{usdc(report.routing.signedSpread)}</span>. Negative-spread records: {count(report.routing.negativeSpreadPayments)}.</p></div>
          <div className="grid gap-2"><p>Subscription confirmations: {count(report.subscriptions.confirmedInvoices)}. Gross <span className="tabular-nums">{usdc(report.subscriptions.confirmedPaid)}</span>; observed refunds <span className="tabular-nums">{usdc(report.subscriptions.observedRefunded)}</span>; held for refund review <span className="tabular-nums">{usdc(report.subscriptions.heldForRefundReview)}</span>.</p><p className="text-xs text-muted-foreground">{report.scopes.subscriptions}</p><p>Noncash invoice setoff: <span className="tabular-nums">{usdc(report.discharge.noncashSetoff)}</span>.</p><p>Funded escrow discharge: <span className="tabular-nums">{usdc(report.discharge.fundedEscrow)}</span>.</p><p className="text-xs text-muted-foreground">{report.scopes.discharges}</p><p>Accepted supplier credits: <span className="tabular-nums">{usdc(report.credits.acceptedAmount)}</span> across {count(report.credits.acceptedRecords)} notes.</p><p className="text-xs text-muted-foreground">{report.scopes.credits}</p></div>
        </div></details></div>},
          {label:"Observed network fees",content:<><ObservedCostEvidence costs={report.observedCosts} from={report.window.from} to={report.window.to}/></>},
          {label:"Compare costs",content:<>        <section className="min-w-0 rounded-2xl border border-border bg-white p-5" aria-labelledby="cost-comparison-heading"><h3 id="cost-comparison-heading" className="flex items-center gap-2 text-sm font-medium"><Calculator size={17} aria-hidden="true"/>Compare a quote</h3>
          <p className="mt-2 text-xs text-muted-foreground">Your reviewed quote, compared over the same payment scope.</p>
          <div hidden={!!comparison}>
          <form className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" onChange={() => setComparison(null)} onSubmit={event => {
            event.preventDefault(); const values = new FormData(event.currentTarget), optional = (name: string) => String(values.get(name) ?? "").trim();
            const data = { ...window, basis, sameScopeAcknowledged: values.get("sameScopeAcknowledged") === "on", networkScope: values.get("networkScope"), competitorPercent: values.get("competitorPercent"), competitorFixedUSDC: values.get("competitorFixedUSDC"), subscriptionAllocation: values.get("subscriptionAllocation"),
              ...(optional("manualSubscriptionUSDC") ? { manualSubscriptionUSDC: optional("manualSubscriptionUSDC") } : {}), ...(optional("razorOtherCostsUSDC") ? { razorOtherCostsUSDC: optional("razorOtherCostsUSDC") } : {}), ...(optional("competitorOtherCostsUSDC") ? { competitorOtherCostsUSDC: optional("competitorOtherCostsUSDC") } : {}),
              ...(basis === "manual" ? { manualPrincipalUSDC: optional("manualPrincipalUSDC"), manualPaymentCount: Number(optional("manualPaymentCount")), manualRazorRoutingUSDC: optional("manualRazorRoutingUSDC") } : {}) };
            void run("compare", async () => setComparison(await api<CompanyCostComparison>(`${base}/insights/compare`, data)));
          }}>
            <fieldset className="contents" disabled={!!busy}>
            <Field label="Cost basis"><select className={control} value={basis} disabled={!!busy} onChange={event => setBasis(event.target.value as "observed" | "manual")}><option value="observed">Recorded closed-route sample</option><option value="manual">My own scenario estimates</option></select></Field>
            <Field label="Network / receiving scope"><input key={`${basis}:${report.routing.networkScope}`} name="networkScope" className={control} maxLength={100} required readOnly={basis === "observed"} defaultValue={basis === "observed" ? report.routing.networkScope : "Native NEAR USDC destinations"}/></Field>
            {basis === "observed" && !report.routing.comparisonAvailable && <p className="text-sm text-amber-900 sm:col-span-2">Observed comparison unavailable. Use a manual scenario or narrow the date range.</p>}
            {basis === "manual" && <><Field label="Principal (USDC)"><input className={control} name="manualPrincipalUSDC" inputMode="decimal" required maxLength={80}/></Field><Field label="Payment count"><input className={control} name="manualPaymentCount" type="number" min={1} max={5000} step={1} required/></Field><Field label="Estimated Razor routing (USDC)"><input className={control} name="manualRazorRoutingUSDC" inputMode="decimal" required maxLength={80}/></Field></>}
            <Field label="Quoted fee (%)"><input className={control} name="competitorPercent" inputMode="decimal" required placeholder="Quoted percentage" maxLength={10}/></Field>
            <Field label="Fixed fee per payment (USDC)"><input className={control} name="competitorFixedUSDC" inputMode="decimal" required placeholder="Quoted fixed fee" maxLength={80}/></Field>
            <Field label="Razor subscription allocation"><select className={control} name="subscriptionAllocation" defaultValue="none"><option value="none">Exclude subscription costs explicitly</option><option value="confirmed_window">Allocate all confirmed-window net payments</option><option value="manual">Enter an allocated estimate below</option></select></Field>
            <Field label="Subscription estimate (USDC)" hint="Required only when manual allocation is selected."><input className={control} name="manualSubscriptionUSDC" inputMode="decimal" maxLength={80}/></Field>
            <Field label="Other Razor costs (USDC)" hint="Gas, conversion, storage and receiving fees. Blank means unknown."><input className={control} name="razorOtherCostsUSDC" inputMode="decimal" maxLength={80}/></Field>
            <Field label="Other competitor costs (USDC)" hint="Costs outside the quote. Blank means unknown."><input className={control} name="competitorOtherCostsUSDC" inputMode="decimal" maxLength={80}/></Field>
            <label className="flex items-start gap-2 text-xs leading-5 sm:col-span-2"><input type="checkbox" name="sameScopeAcknowledged" required className="mt-1"/>I reviewed matching amounts, currencies, payment counts, networks and services. Entered costs are estimates, not observed savings.</label>
            <div><Action busy={busy === "compare"} disabled={!!busy || resource.refreshing || basis === "observed" && !report.routing.comparisonAvailable}>Compare costs</Action></div>
            </fieldset>
          </form></div>
          {comparison && <div role="status" className="mt-5 grid gap-5"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="text-sm font-medium">{comparison.basis === "manual" ? "Scenario estimate" : "Recorded routes with quoted fees"}</h4><button type="button" className="text-sm text-primary" onClick={() => setComparison(null)}>Edit comparison</button></div><p className="text-xs text-muted-foreground">{count(comparison.paymentCount)} payments · {usdc(comparison.principal)} principal</p><dl className="grid gap-3 text-sm">{[["Razor routing subtotal", comparison.routingCost], ["Allocated subscription", comparison.allocatedSubscription], ["Competitor fee estimate", comparison.competitorFeeEstimate], ["Difference before unknown costs", comparison.differenceBeforeUnknownCosts]].map(([label,value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{usdc(value)}</dd></div>)}</dl><div className="rounded-2xl bg-muted/50 p-4"><p className="text-xs text-muted-foreground">Competitor minus Razor, including entered costs</p><p className="mt-2 text-xl font-medium tabular-nums">{comparison.estimatedDifferenceWithEnteredCosts === null ? "Unavailable" : usdc(comparison.estimatedDifferenceWithEnteredCosts)}</p>{comparison.estimatedDifferenceWithEnteredCosts === null && <p className="mt-2 text-xs text-muted-foreground">Additional costs are still unknown.</p>}</div><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Scope and assumptions</summary><div className="mt-3 grid gap-3 leading-5"><p>{comparison.networkScope}</p><p>Observed {new Date(comparison.window.observedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC.</p><p>Subscription allocation: {comparison.subscriptionAllocation.replaceAll("_", " ")}.</p><p>{comparison.notice}</p><p>Percentage fees round up once on aggregate principal to one microUSDC. Provider per-payment rounding may differ.</p></div></details></div>}

        </section></>},
        ]}/>
      </>}
    </div>
  </Panel>;
}
