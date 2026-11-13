import { createHash } from "node:crypto";
import { ApiError } from "../context";
import { rows } from "../db";
import type { ChainAttempt, ChainPayment, Payment, PayoutAttempt } from "../payments/types";
import type { StatusResponse } from "../payments/intents";

const maximum = (1n << 128n) - 1n;
export function outputAmount(value: unknown): string | null {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && value.length <= 39 && BigInt(value) <= maximum ? value : null;
}
export function deliveryOutput(attempt: Pick<PayoutAttempt, "expected_output">, provider: StatusResponse | null) {
  const actual = outputAmount(provider?.swapDetails?.amountOut), expected = BigInt(attempt.expected_output);
  return { actual, missing: actual === null, partial: actual !== null && BigInt(actual) > 0n && BigInt(actual) < expected, complete: actual !== null && BigInt(actual) >= expected, positive: actual !== null && BigInt(actual) > 0n };
}
export function completeDelivery(payment: Payment, attempt: PayoutAttempt, chainAttempt: ChainAttempt, provider: StatusResponse | null, direct: boolean) {
  if (direct) return true;
  const recorded = outputAmount(chainAttempt.actual_output);
  return recorded !== null && BigInt(recorded) >= BigInt(attempt.expected_output) && chainAttempt.credited_amount === payment.amount && (!provider || deliveryOutput(attempt, provider).complete);
}
export function spentSource(chain: ChainPayment, attempt: PayoutAttempt, chainAttempt?: ChainAttempt) {
  const transferred = chainAttempt && ["source_sent", "uncertain", "refund_pending", "refund_verifying", "delivered", "partially_delivered"].includes(chainAttempt.status);
  return (BigInt(chain.incurred_cost) + (transferred ? BigInt(attempt.amount_in) : 0n)).toString();
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function validateCredit(payment: Payment, attempt: PayoutAttempt, actual: string, credit: string) {
  if (!outputAmount(actual) || !outputAmount(credit) || BigInt(actual) <= 0n || BigInt(actual) >= BigInt(attempt.expected_output) || BigInt(credit) <= 0n || BigInt(credit) >= BigInt(payment.amount)) throw new ApiError(422, "A terminal partial delivery needs a positive short destination output and a separately reviewed partial USDC entitlement credit", "PARTIAL_AMOUNT_INVALID");
}

export function liabilityPayments(organizationId: string, paymentId: string): Payment[] {
  return rows<Payment>(`WITH RECURSIVE edges(a,b) AS (
    SELECT original_payment_id,remainder_payment_id FROM partial_remainders WHERE organization_id=?
    UNION SELECT old_payment_id,new_payment_id FROM payment_replacements WHERE organization_id=?
  ), lineage(id) AS (
    SELECT ? UNION SELECT CASE WHEN e.a=l.id THEN e.b ELSE e.a END FROM edges e JOIN lineage l ON e.a=l.id OR e.b=l.id
  ) SELECT p.* FROM payments p JOIN lineage l ON l.id=p.id WHERE p.organization_id=? ORDER BY p.created_at,p.id`, organizationId, organizationId, paymentId, organizationId);
}
