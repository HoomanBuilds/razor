import { z } from "zod";
import { atomic, parseUnits } from "../../lib/money";
import { ApiError } from "../context";

export const insightWindowInput = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).strict();
const day = 86_400_000;
export function insightWindow(data: unknown = {}, at = new Date()) {
  const input = insightWindowInput.parse(data), today = at.toISOString().slice(0, 10), to = input.to ?? today;
  const from = input.from ?? new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * day).toISOString().slice(0, 10);
  const start = Date.parse(`${from}T00:00:00.000Z`), end = Date.parse(`${to}T00:00:00.000Z`) + day;
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== from || new Date(end - day).toISOString().slice(0, 10) !== to || end <= start || end - start > 93 * day || to > today) throw new ApiError(422, "Choose an inclusive UTC date range of 1 to 93 days ending today or earlier", "INSIGHTS_WINDOW_INVALID");
  return { from, to, start: new Date(start).toISOString(), endExclusive: new Date(end).toISOString(), timeZone: "UTC" as const, observedAt: at.toISOString() };
}

export interface InsightPayment { id: string; status: string; amount: string; delivered_amount: string; total_spent: string }
export interface InsightAttempt { payment_id: string; state: string; destination_network: string; execution_kind: string | null }
export interface InsightSubscription { amount: string; refunded_amount: string; status: string }
export interface InsightRecords { payments: InsightPayment[]; attempts: InsightAttempt[]; subscriptions: InsightSubscription[]; setoffs: { amount: string }[]; fundedDischarges: { amount: string }[]; acceptedCredits?: { amount: string }[]; truncated: string[] }
const terminalAttempts = new Set(["delivered", "partially_delivered", "refunded_verified", "closed_unfunded", "cancelled"]);
function money(value: string) { try { return atomic(value, true); } catch { throw new ApiError(409, "A stored financial amount needs review before these aggregates can be reported", "INSIGHTS_DATA_REVIEW_REQUIRED"); } }

export function aggregateInsights(records: InsightRecords) {
  const outcomes = { successful: 0, partial: 0, held: 0, failed: 0, unresolved: 0, awaiting: 0, retired: 0 };
  let delivered = 0n, spent = 0n, principal = 0n, completedPrincipal = 0n, completedSpent = 0n, negativeSpreadPayments = 0, attemptedPayments = 0, attemptedSuccesses = 0, measuredCompleted = 0, missingCompletedMeasurements = 0, nativeOnly = true;
  const attemptsByPayment = new Map<string, InsightAttempt[]>();
  for (const attempt of records.attempts) { const values = attemptsByPayment.get(attempt.payment_id) ?? []; values.push(attempt); attemptsByPayment.set(attempt.payment_id, values); }
  for (const payment of records.payments) {
    const amount = money(payment.amount), received = money(payment.delivered_amount), source = money(payment.total_spent), attempts = attemptsByPayment.get(payment.id) ?? [];
    if (received > amount) throw new ApiError(409, "Recorded delivery exceeds its original payment entitlement and needs review", "INSIGHTS_DATA_REVIEW_REQUIRED");
    principal += amount; delivered += received; spent += source;
    if (attempts.length) attemptedPayments++;
    const successful = payment.status === "paid" && received === amount && amount > 0n;
    if (successful) {
      outcomes.successful++; if (attempts.length) attemptedSuccesses++;
      const measured = attempts.length > 0 && attempts.some(attempt => attempt.state === "delivered") && attempts.every(attempt => terminalAttempts.has(attempt.state));
      if (!measured) missingCompletedMeasurements++;
      else {
        measuredCompleted++; completedPrincipal += amount; completedSpent += source;
        if (source < received) negativeSpreadPayments++;
        if (attempts.some(attempt => attempt.state === "delivered" && (attempt.destination_network !== "near" || attempt.execution_kind !== "direct"))) nativeOnly = false;
      }
    } else if (payment.status === "cancelled") outcomes.retired++;
    else if (payment.status === "partially_paid" || received > 0n) outcomes.partial++;
    else if (payment.status === "held") outcomes.held++;
    else if (["failed", "rejected"].includes(payment.status)) outcomes.failed++;
    else if (["unknown", "in_flight", "recovery_pending", "submitted", "processing", "prepared"].includes(payment.status) || attempts.some(attempt => !terminalAttempts.has(attempt.state))) outcomes.unresolved++;
    else if (["draft", "approved", "approved_unfunded", "awaiting_approvals", "scheduled"].includes(payment.status)) outcomes.awaiting++;
    else outcomes.unresolved++;
  }
  let subscriptionPaid = 0n, subscriptionRefunded = 0n, subscriptionHeld = 0n;
  for (const invoice of records.subscriptions) {
    const amount = money(invoice.amount), refunded = money(invoice.refunded_amount);
    if (refunded > amount) throw new ApiError(409, "A subscription refund exceeds its confirmed invoice", "INSIGHTS_DATA_REVIEW_REQUIRED");
    subscriptionPaid += amount; subscriptionRefunded += refunded;
    if (invoice.status === "credit_required") subscriptionHeld += amount - refunded;
  }
  const complete = records.truncated.length === 0, comparisonAvailable = complete && measuredCompleted > 0 && negativeSpreadPayments === 0;
  return {
    payments: { included: records.payments.length, principal: principal.toString(), deliveredPrincipal: delivered.toString(), recordedSourceSpend: spent.toString(), signedSpread: (spent - delivered).toString(), outcomes,
      attempted: attemptedPayments, attemptsIncluded: records.attempts.length, attemptedSuccessRate: { numerator: attemptedSuccesses, denominator: attemptedPayments, basisPoints: attemptedPayments ? Math.floor(attemptedSuccesses * 10000 / attemptedPayments) : null } },
    routing: { completedMeasured: measuredCompleted, completedMissingMeasurements: missingCompletedMeasurements, completedPrincipal: completedPrincipal.toString(), completedSourceSpend: completedSpent.toString(), signedSpread: (completedSpent - completedPrincipal).toString(), negativeSpreadPayments,
      networkScope: measuredCompleted ? nativeOnly ? "Native NEAR USDC destinations" : "Mixed or externally routed destinations" : "No comparable completed routes", comparisonAvailable },
    subscriptions: { confirmedInvoices: records.subscriptions.length, confirmedPaid: subscriptionPaid.toString(), observedRefunded: subscriptionRefunded.toString(), observedNet: (subscriptionPaid - subscriptionRefunded).toString(), heldForRefundReview: subscriptionHeld.toString() },
    discharge: { noncashSetoff: records.setoffs.reduce((sum, value) => sum + money(value.amount), 0n).toString(), fundedEscrow: records.fundedDischarges.reduce((sum, value) => sum + money(value.amount), 0n).toString(), noncashRecords: records.setoffs.length, fundedRecords: records.fundedDischarges.length },
    credits: { acceptedAmount: (records.acceptedCredits ?? []).reduce((sum, value) => sum + money(value.amount), 0n).toString(), acceptedRecords: records.acceptedCredits?.length ?? 0 },
    coverage: { complete, truncated: records.truncated, paymentLimit: 5000, attemptLimit: 12000, eventLimit: 5000 },
    measurements: { sourceChainGas: null, nearGas: null, destinationFees: null, storageDeposits: null, fundingConversionCosts: null, totalAllInCost: null },
  };
}

const decimal = z.string().max(80).refine(value => { try { parseUnits(value, 6); return true; } catch { return false; } }, "Use a nonnegative USDC amount with at most six decimals");
export const comparisonInput = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), basis: z.enum(["observed", "manual"]),
  sameScopeAcknowledged: z.literal(true), networkScope: z.string().trim().min(3).max(100), competitorPercent: z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/).refine(value => Number(value) <= 100), competitorFixedUSDC: decimal,
  subscriptionAllocation: z.enum(["none", "confirmed_window", "manual"]), manualSubscriptionUSDC: decimal.optional(), razorOtherCostsUSDC: decimal.optional(), competitorOtherCostsUSDC: decimal.optional(),
  manualPrincipalUSDC: decimal.optional(), manualPaymentCount: z.number().int().min(1).max(5000).optional(), manualRazorRoutingUSDC: decimal.optional(),
}).strict();
export function compareCosts(report: ReturnType<typeof aggregateInsights>, data: z.infer<typeof comparisonInput>) {
  const input = comparisonInput.parse(data), manual = input.basis === "manual";
  if (!manual && (!report.routing.comparisonAvailable || input.networkScope !== report.routing.networkScope)) throw new ApiError(409, "This recorded cohort is incomplete, has no closed measured routes or includes a negative spread. Use explicit manual assumptions instead", "INSIGHTS_COMPARISON_UNAVAILABLE");
  if (manual && (!input.manualPrincipalUSDC || !input.manualPaymentCount || input.manualRazorRoutingUSDC === undefined) || input.subscriptionAllocation === "manual" && input.manualSubscriptionUSDC === undefined) throw new ApiError(422, "Enter every manual amount and explicit subscription allocation", "INSIGHTS_COMPARISON_INPUT_REQUIRED");
  const principal = manual ? money(parseUnits(input.manualPrincipalUSDC!)) : BigInt(report.routing.completedPrincipal), count = manual ? input.manualPaymentCount! : report.routing.completedMeasured;
  if (principal <= 0n) throw new ApiError(422, "Use a positive comparison principal", "INSIGHTS_COMPARISON_INPUT_REQUIRED");
  const routing = manual ? money(parseUnits(input.manualRazorRoutingUSDC!)) : BigInt(report.routing.signedSpread), rate = BigInt(parseUnits(input.competitorPercent, 4));
  const competitorFees = (principal * rate + 999999n) / 1000000n + money(parseUnits(input.competitorFixedUSDC)) * BigInt(count);
  const subscription = input.subscriptionAllocation === "none" ? 0n : input.subscriptionAllocation === "confirmed_window" ? BigInt(report.subscriptions.observedNet) : money(parseUnits(input.manualSubscriptionUSDC!));
  const razorOther = input.razorOtherCostsUSDC === undefined ? null : money(parseUnits(input.razorOtherCostsUSDC)), competitorOther = input.competitorOtherCostsUSDC === undefined ? null : money(parseUnits(input.competitorOtherCostsUSDC));
  const razorSubtotal = routing + subscription, comparatorSubtotal = competitorFees;
  return { basis: input.basis, currency: "USDC" as const, networkScope: input.networkScope, paymentCount: count, principal: principal.toString(), routingCost: routing.toString(), routingCostEvidence: manual ? "entered_estimate" : "recorded_closed_payment_spread",
    subscriptionAllocation: input.subscriptionAllocation, allocatedSubscription: subscription.toString(), competitorPercent: input.competitorPercent, competitorFixedUSDC: input.competitorFixedUSDC,
    competitorFeeEstimate: comparatorSubtotal.toString(), razorKnownSubtotal: razorSubtotal.toString(), razorOtherCostEstimate: razorOther?.toString() ?? null, competitorOtherCostEstimate: competitorOther?.toString() ?? null,
    differenceBeforeUnknownCosts: (comparatorSubtotal - razorSubtotal).toString(), estimatedDifferenceWithEnteredCosts: razorOther === null || competitorOther === null ? null : (comparatorSubtotal + competitorOther - razorSubtotal - razorOther).toString(),
    notice: "An estimated difference is not verified savings, a rebate or a complete fee quote. Gas, funding conversion, storage, destination and cash-out costs remain unknown unless covered by your explicit estimates. Recipient access is not charged by this calculator." };
}
