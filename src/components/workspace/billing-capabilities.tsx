"use client";

import { formatUnits } from "@/lib/money";
import {
  capabilityLabels,
  OPTIONAL_CAPABILITIES,
  type CapabilityPolicy,
} from "@/server/billing/capability-model";
import type { OptionalCapabilityStatus } from "@/server/billing/capabilities";
import { DataTable, Panel, Status } from "./shared";

export function OptionalPlanCapabilities({
  policy,
}: {
  policy?: CapabilityPolicy;
}) {
  if (!policy)
    return (
      <p className="text-xs text-muted-foreground">
        This historical offer has no attached new optional-feature quota. Its
        frozen terms remain in force.
      </p>
    );
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 text-xs">
      <p className="font-medium">
        {policy.mode === "calibrated"
          ? "Operator-reviewed cost calibration"
          : policy.mode === "pilot"
            ? "Non-calibrated pilot allowance"
            : "Existing version: no new commercial creation quota"}
      </p>
      <p className="break-words leading-5 text-muted-foreground">
        {policy.notice}
      </p>
      {policy.mode !== "legacy" ? (
        <ul className="grid min-w-0 grid-cols-1 gap-1">
          {OPTIONAL_CAPABILITIES.map((key) => (
            <li key={key}>
              {capabilityLabels[key]}:{" "}
              <span className="tabular-nums">
                {policy.limits[key]?.toLocaleString() ?? "No new quota"}
              </span>{" "}
              per usage period
            </li>
          ))}
        </ul>
      ) : null}
      {policy.mode === "calibrated" ? (
        <p className="leading-5 text-muted-foreground">
          Capacities use exact budget / observed unit-cost ratios rounded down.
          These are operator-reviewed service expenses, not independently
          verified costs or network-gas estimates. Runtime safety limits and
          service configuration still apply.
        </p>
      ) : policy.mode === "pilot" ? (
        <p className="leading-5 text-muted-foreground">
          Pilot limits are a deliberate offer, not measured-cost or
          unlimited-capacity claims.
        </p>
      ) : null}
    </div>
  );
}
export function OptionalCapabilityUsage({
  value,
}: {
  value?: OptionalCapabilityStatus;
}) {
  if (!value)
    return (
      <Panel collapsible title="Optional feature capacities">
        <p className="text-sm text-muted-foreground">
          Refresh the plan to read its versioned creation policy. Existing
          payments and recovery remain available.
        </p>
      </Panel>
    );
  const { policy } = value;
  return (
    <Panel
      collapsible title="Optional feature capacities"
      description="Your plan's optional resource allowances." help="Creation allowances are fixed to your current plan version and usage period. Using an allowance never creates a charge or automatic upgrade."
    >
      <div className="grid min-w-0 grid-cols-1 gap-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <p className="break-all text-xs text-muted-foreground">
            Plan {value.planVersionId}
          </p>
          <Status
            value={
              policy.mode === "legacy"
                ? "legacy_terms"
                : policy.mode === "pilot"
                  ? "non_calibrated_pilot"
                  : "operator_calibrated"
            }
          />
        </div>
        <p className="break-words text-sm leading-6">{policy.notice}</p>
        <DataTable
          columns={[
            "Optional new resource",
            "Created this period",
            "Published allowance",
            "Remaining",
          ]}
        >
          {OPTIONAL_CAPABILITIES.map((key) => {
            const cap = policy.limits[key],
              used = value.usage[key];
            return (
              <tr key={key}>
                <td className="min-w-44">{capabilityLabels[key]}</td>
                <td className="text-right tabular-nums">
                  {used.toLocaleString()}
                </td>
                <td className="text-right tabular-nums">
                  {cap === null
                    ? "No new commercial quota"
                    : cap.toLocaleString()}
                </td>
                <td className="text-right tabular-nums">
                  {cap === null
                    ? "Subject to product safety limits"
                    : Math.max(0, cap - used).toLocaleString()}
                </td>
              </tr>
            );
          })}
        </DataTable>
        <p className="text-xs leading-5 text-muted-foreground">
          {value.notice} Deleting a resource does not refill a consumed creation
          allowance. Existing resources can still be managed. Retries with the
          same resource identity do not consume another allowance. Paid upgrades
          sharing a usage window retain its existing usage.
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          Commercial allowance is separate from software safety bounds,
          native-token scope, operator eligibility, provider credentials,
          approved financial terms, and actual funds. It does not guarantee
          financing, execution or staff availability. Recipients pay no Razor
          subscription to receive.
        </p>
        {policy.allocations ? (
          <details className="min-w-0 rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              Reviewed budget and measurement basis
            </summary>
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-4">
              {OPTIONAL_CAPABILITIES.map((key) => {
                const basis = policy.allocations![key];
                return (
                  <div key={key} className="min-w-0 text-xs leading-5">
                    <p className="font-medium">{capabilityLabels[key]}</p>
                    <p>
                      Allocated budget: {formatUnits(basis.budgetAtomicUSDC, 6)}{" "}
                      USDC. Observed sample:{" "}
                      {basis.sampleCount.toLocaleString()} successful creations.
                    </p>
                    <p>
                      Period: {new Date(basis.periodStart).toLocaleDateString()}{" "}
                      to {new Date(basis.periodEnd).toLocaleDateString()}.
                    </p>
                    <p className="break-all">
                      Exact unit-cost ratio: {basis.unitCostNumerator} /{" "}
                      {basis.unitCostDenominator} atomic USDC per creation.
                    </p>
                    <p className="break-all text-muted-foreground">
                      Immutable reviewed observation: {basis.observationId}
                    </p>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">
                Explicit operator subsidy budget:{" "}
                {formatUnits(policy.subsidyBudgetAtomicUSDC ?? "0", 6)} USDC.
                Source documents and conversion evidence are retained for local
                operator review, not customer financial data.
              </p>
            </div>
          </details>
        ) : null}
        {policy.termsHash ? (
          <p className="break-all text-xs text-muted-foreground">
            Frozen policy SHA-256: {policy.termsHash}. This identifies published
            terms and is not a payment receipt or audit certification.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
