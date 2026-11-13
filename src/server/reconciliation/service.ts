import { requirePermission, type AccessContext } from "../context";
import { row, rows } from "../db";
import type { FundingLeg, Payment, PayoutAttempt } from "../payments/types";
import { isDirectExecution } from "./direct";

const REVIEW_PAYMENTS = "(p.status IN ('held','recovery_pending','in_flight','prepared','approved_unfunded') OR p.hold_reason IS NOT NULL OR EXISTS(SELECT 1 FROM payout_attempts a WHERE a.payment_id=p.id AND a.state IN ('unknown','reported_delivered')))";

export function paymentProvenance(attempt: PayoutAttempt | null): string {
  if (!attempt) return "unexecuted_obligation";
  let direct = false;
  try { direct = isDirectExecution(JSON.parse(attempt.quote)); } catch {}
  if (direct) return attempt.state === "delivered" ? "near_native_transfer_callback" : "near_native_transfer_unresolved";
  if (attempt.state === "delivered") return "owner_reported_external_delivery";
  if (attempt.state === "refunded_verified") return "near_refund_reconciled_with_reporter_attestation";
  return attempt.provider_status === "SUCCESS" ? "provider_report_only" : "unresolved_route";
}

export function reconciliationQueue(access: AccessContext, page = 1, pageSize = 25) {
  requirePermission(access, "payments:read");
  const offset = (page - 1) * pageSize;
  const payments = rows<Payment>(`SELECT p.* FROM payments p WHERE p.organization_id=? AND ${REVIEW_PAYMENTS} ORDER BY p.created_at,p.id LIMIT ? OFFSET ?`, access.organizationId, pageSize, offset).map((payment) => {
    const attempt = row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at DESC,id DESC LIMIT 1", payment.id, access.organizationId) ?? null;
    return { payment, attempt, provenance: paymentProvenance(attempt) };
  });
  const funding = rows<FundingLeg>("SELECT * FROM funding_legs WHERE organization_id=? AND status NOT IN ('confirmed','refunded_verified','closed_unsent','cancelled') ORDER BY created_at,id LIMIT ? OFFSET ?", access.organizationId, pageSize, offset).map((leg) => ({ funding: leg, provenance: leg.provider_status === "SUCCESS" ? "provider_report_only" : "unresolved_funding" }));
  const review = rows<{ amount: string }>(`SELECT p.amount FROM payments p WHERE p.organization_id=? AND ${REVIEW_PAYMENTS}`, access.organizationId);
  const fundingCount = row<{ total: number }>("SELECT COUNT(*) AS total FROM funding_legs WHERE organization_id=? AND status NOT IN ('confirmed','refunded_verified','closed_unsent','cancelled')", access.organizationId)?.total ?? 0;
  const treasuryNetwork = row<{ network: string }>("SELECT network FROM treasury_config WHERE organization_id=?", access.organizationId)?.network ?? null;
  return { payments, funding, page, pageSize, treasuryNetwork, totals: { payments: review.length, funding: fundingCount, unresolvedEntitlementMicroUsdc: review.reduce((sum, payment) => sum + BigInt(payment.amount), 0n).toString() }, more: { payments: offset + payments.length < review.length, funding: offset + funding.length < fundingCount } };
}
