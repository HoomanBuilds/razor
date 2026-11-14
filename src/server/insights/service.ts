import { ApiError, requirePermission, type AccessContext } from "../context";
import { rows, transaction } from "../db";
import { getAccess } from "../identity/session";
import { csvCell } from "../reconciliation/export";
import { aggregateInsights, compareCosts, comparisonInput, insightWindow, type InsightAttempt, type InsightPayment, type InsightSubscription } from "./model";

function financeAccess(access: AccessContext) { const live = getAccess(access.userId, access.organizationId); for (const permission of ["company:read", "payments:read", "reports:read"]) requirePermission(live, permission); return live; }
export function companyInsights(access: AccessContext, data: unknown = {}, at = new Date()) {
  const window = insightWindow(data, at);
  return transaction(() => {
    const live = financeAccess(access), truncated: string[] = [];
    function bound<T>(values: T[], limit: number, category: string) { if (values.length > limit) truncated.push(category); return values.slice(0, limit); }
    const payments = bound(rows<InsightPayment>("SELECT id,status,amount,delivered_amount,total_spent FROM payments WHERE organization_id=? AND created_at>=? AND created_at<? ORDER BY created_at,id LIMIT 5001", live.organizationId, window.start, window.endExclusive), 5000, "payment_cohort");
    const paymentIds = new Set(payments.map(payment => payment.id));
    const attempts = bound(rows<InsightAttempt>("SELECT a.payment_id,a.state,a.destination_network,CASE WHEN json_valid(a.quote) THEN json_extract(a.quote,'$.kind') END AS execution_kind FROM payout_attempts a JOIN payments p ON p.id=a.payment_id AND p.organization_id=a.organization_id WHERE p.organization_id=? AND p.created_at>=? AND p.created_at<? ORDER BY p.created_at,p.id,a.created_at,a.id LIMIT 12001", live.organizationId, window.start, window.endExclusive), 12000, "cohort_attempts").filter(attempt => paymentIds.has(attempt.payment_id));
    const subscriptions = bound(rows<InsightSubscription>("SELECT amount,refunded_amount,status FROM billing_invoices WHERE organization_id=? AND confirmed_at>=? AND confirmed_at<? AND status IN ('paid','credit_required','refunded') ORDER BY confirmed_at,id LIMIT 5001", live.organizationId, window.start, window.endExclusive), 5000, "subscription_confirmations");
    const events = (table: "clearing_setoffs" | "clearing_funded_discharges", category: string) => bound(rows<{ amount: string }>(`SELECT amount FROM ${table} WHERE organization_id=? AND created_at>=? AND created_at<? ORDER BY created_at,id LIMIT 5001`, live.organizationId, window.start, window.endExclusive), 5000, category);
    const acceptedCredits = bound(rows<{ amount: string }>("SELECT v.amount FROM invoice_credit_notes n JOIN invoice_credit_versions v ON v.note_id=n.id AND v.version=n.accepted_version WHERE n.organization_id=? AND n.status='accepted' AND n.accepted_at>=? AND n.accepted_at<? ORDER BY n.accepted_at,n.id LIMIT 5001", live.organizationId, window.start, window.endExclusive), 5000, "accepted_supplier_credits");
    return { window, ...aggregateInsights({ acceptedCredits, payments, attempts, subscriptions, setoffs: events("clearing_setoffs", "noncash_discharge"), fundedDischarges: events("clearing_funded_discharges", "funded_discharge"), truncated }),
      scopes: { payments: "Payments created in this inclusive UTC window, with their latest recorded outcomes observed now. These are not settlement-date cash flows. Principal includes retired and replacement records and must not be treated as unique invoice liability.",
        discharges: "Invoice discharge records created in this UTC window. Noncash setoff and funded escrow rights are separate from token delivery and company treasury cash.", subscriptions: "Subscription invoices confirmed in this UTC window, with refunds observed now. Their service periods and refund dates can fall outside the window.",
        costs: "Source spend is recorded USDC consumption, including incomplete outcomes. Signed spend-minus-delivery spread is not a measured network fee. Closed-route spread excludes unmeasured gas, funding conversion, storage and destination fees; negative spread is not a rebate.",
        credits: "Supplier credits accepted in this UTC window. These reduce invoice liabilities without returning previously delivered funds, creating cash or restoring the original purchase allowance.",
        privacy: "Company-wide aggregates only. No recipient names, salaries, documents, addresses, payment IDs or external tracking are exported. These insights do not change financial authority or charge recipients." },
    };
  });
}
export type CompanyInsights = ReturnType<typeof companyInsights>;
export function compareCompanyCosts(access: AccessContext, data: unknown) {
  const input = comparisonInput.parse(data), report = companyInsights(access, { from: input.from, to: input.to });
  if (input.subscriptionAllocation === "confirmed_window" && report.coverage.truncated.includes("subscription_confirmations")) throw new ApiError(409, "Narrow the window before allocating its complete confirmed subscription cost", "INSIGHTS_COMPARISON_UNAVAILABLE");
  return { window: report.window, ...compareCosts(report, input) };
}
export type CompanyCostComparison = ReturnType<typeof compareCompanyCosts>;
export function companyInsightsCsv(access: AccessContext, data: unknown = {}) {
  const report = companyInsights(access, data), records: { scope: string; metric: string; value: string | number | null; unit: string; note: string }[] = [];
  const add = (scope: string, metric: string, value: string | number | null, unit: string, note: string) => records.push({ scope, metric, value, unit, note });
  for (const key of ["principal", "deliveredPrincipal", "recordedSourceSpend", "signedSpread"] as const) add("payment_creation_cohort_observed_now", key, report.payments[key], "microUSDC", report.scopes.payments + " " + report.scopes.costs);
  for (const [key, value] of Object.entries(report.payments.outcomes)) add("payment_creation_cohort_observed_now", key, value, "payments", `Denominator: ${report.payments.included} included payment records; ${report.payments.attempted} have recorded attempts. Retired records are not failed deliveries.`);
  add("attempted_payments", "successful_numerator", report.payments.attemptedSuccessRate.numerator, "payments", "Successful records among payments with at least one attempt.");
  add("attempted_payments", "included_denominator", report.payments.attemptedSuccessRate.denominator, "payments", "No rate is implied when the denominator is zero.");
  for (const key of ["completedPrincipal", "completedSourceSpend", "signedSpread"] as const) add("closed_recorded_routes", key, report.routing[key], "microUSDC", report.scopes.costs);
  add("closed_recorded_routes", "measured_records", report.routing.completedMeasured, "payments", report.routing.networkScope);
  add("closed_recorded_routes", "negative_spread_records", report.routing.negativeSpreadPayments, "payments", "A negative spread is neither zero gas nor a proven rebate; observed comparison is disabled.");
  add("closed_recorded_routes", "missing_measurement_records", report.routing.completedMissingMeasurements, "payments", "Completed status without complete terminal attempt records is excluded from observed comparisons.");
  for (const key of ["confirmedPaid", "observedRefunded", "observedNet", "heldForRefundReview"] as const) add("subscription_confirmation_cohort", key, report.subscriptions[key], "microUSDC", report.scopes.subscriptions);
  add("recorded_invoice_events", "noncash_setoff", report.discharge.noncashSetoff, "microUSDC", report.scopes.discharges);
  add("recorded_invoice_events", "funded_escrow_discharge", report.discharge.fundedEscrow, "microUSDC", report.scopes.discharges);
  add("accepted_supplier_credit_events", "accepted_supplier_credit", report.credits.acceptedAmount, "microUSDC", report.scopes.credits);
  add("accepted_supplier_credit_events", "accepted_credit_records", report.credits.acceptedRecords, "notes", report.scopes.credits);
  for (const key of Object.keys(report.measurements)) add("unmeasured", key, null, "unavailable", "Unknown, not zero. No all-in fee or universal savings claim.");
  add("coverage", "complete", report.coverage.complete ? "yes" : "no", "status", report.coverage.truncated.length ? `Included bounded sample; narrow the UTC window. Truncated: ${report.coverage.truncated.join(", ")}` : "A bounded local record snapshot, not independent live-chain verification.");
  const headers = ["from_utc", "to_utc_inclusive", "observed_at", "scope", "metric", "value", "unit", "note", "privacy"];
  return [headers, ...records.map(record => [report.window.from, report.window.to, report.window.observedAt, record.scope, record.metric, record.value, record.unit, record.note, report.scopes.privacy])].map(values => values.map(csvCell).join(",")).join("\r\n");
}
