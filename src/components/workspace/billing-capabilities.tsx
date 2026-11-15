"use client";

import { formatUnits } from "@/lib/money";
import { capabilityLabels, OPTIONAL_CAPABILITIES, type CapabilityPolicy } from "@/server/billing/capability-model";
import type { OptionalCapabilityStatus } from "@/server/billing/capabilities";
import { CapsuleMeter } from "./dashboard-visuals";
import { Panel, Status } from "./shared";

export function OptionalPlanCapabilities({ policy }: { policy?: CapabilityPolicy }) {
  if (!policy) return <p className="text-xs text-muted-foreground">Historical plan terms apply.</p>;
  return <div className="grid gap-3 text-xs">
    {policy.mode !== "legacy" ? <ul className="divide-y">{OPTIONAL_CAPABILITIES.map(key => <li key={key} className="flex items-start justify-between gap-4 py-2"><span>{capabilityLabels[key]}</span><span className="shrink-0 tabular-nums">{policy.limits[key]?.toLocaleString() ?? "No creation quota"}</span></li>)}</ul> : <p>Existing plan terms</p>}
    <p className="text-muted-foreground">Per usage period · {policy.mode === "pilot" ? "Pilot allowances" : policy.mode === "calibrated" ? "Published allowances" : "Legacy terms"}</p>
  </div>;
}

export function OptionalCapabilityUsage({ value }: { value?: OptionalCapabilityStatus }) {
  if (!value) return <Panel collapsible title="Feature usage"><p className="text-sm text-muted-foreground">Refresh your plan to load usage.</p></Panel>;
  const { policy } = value;
  return <Panel collapsible title="Feature usage"><div className="grid gap-5">
    <div className="grid gap-5 sm:grid-cols-2">{OPTIONAL_CAPABILITIES.map(key => {
      const cap = policy.limits[key], used = value.usage[key];
      return <div key={key} className="rounded-2xl bg-white p-4"><div className="flex items-start justify-between gap-3 text-sm"><p>{capabilityLabels[key]}</p><p className="shrink-0 tabular-nums">{used.toLocaleString()}{cap !== null ? ` / ${cap.toLocaleString()}` : ""}</p></div>{cap !== null ? <div className="mt-4"><CapsuleMeter value={cap>0?Math.min(1,used/cap):used>0?1:0} label={`${capabilityLabels[key]}: ${used} of ${cap}`}/><p className="mt-2 text-xs text-muted-foreground">{Math.max(0,cap-used).toLocaleString()} remaining</p></div> : <p className="mt-2 text-xs text-muted-foreground">No new commercial quota</p>}</div>;
    })}</div>
    <details className="border-t pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Allowance terms</summary><div className="mt-4 grid gap-4"><Status value={policy.mode==="pilot"?"pilot":policy.mode==="legacy"?"legacy terms":"published"}/><p>{policy.notice}</p><p>{value.notice}</p><p>Creation usage does not reset when a resource is deleted. Existing resources remain manageable.</p>{policy.allocations && <div className="grid gap-4">{OPTIONAL_CAPABILITIES.map(key => {const basis=policy.allocations![key];return <div key={key}><p className="font-medium text-foreground">{capabilityLabels[key]}</p><p className="mt-1">Budget {formatUnits(basis.budgetAtomicUSDC,6)} USDC · {basis.sampleCount.toLocaleString()} observations</p><p>{new Date(basis.periodStart).toLocaleDateString()} to {new Date(basis.periodEnd).toLocaleDateString()}</p><p className="break-all">Unit-cost ratio {basis.unitCostNumerator} / {basis.unitCostDenominator} atomic USDC</p><p className="break-all">Observation {basis.observationId}</p></div>;})}<p>Operator subsidy {formatUnits(policy.subsidyBudgetAtomicUSDC ?? "0",6)} USDC</p></div>}<p className="break-all">Plan version {value.planVersionId}</p>{policy.termsHash && <p className="break-all">Terms hash {policy.termsHash}</p>}</div></details>
  </div></Panel>;
}
