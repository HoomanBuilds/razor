import { ApiError, type AccessContext } from "../context";
import { getDb, row } from "../db";
import { encrypt } from "../identity/crypto";
import type { ChainAttempt, ChainPayment, Payment, PayoutAttempt } from "../payments/types";
import { validateCredit } from "./model";

export interface PartialReview { id: string; organization_id: string; payment_id: string; attempt_id: string; actual_output: string; credited_usdc: string; destination_tx_hash: string; receipt_commitment: string }
export function partialProof(payment: Payment, attempt: PayoutAttempt, chain: ChainPayment, chainAttempt: ChainAttempt): PartialReview {
  if (chain.status !== "partially_paid" || chain.reservation !== "0" || chainAttempt.status !== "partially_delivered" || !chainAttempt.actual_output || !chainAttempt.credited_amount || !chainAttempt.receipt) throw new ApiError(409, "The NEAR treasury has not authoritatively closed this partial route", "PARTIAL_CLOSURE_UNVERIFIED");
  validateCredit(payment, attempt, chainAttempt.actual_output, chainAttempt.credited_amount);
  const review = row<PartialReview>("SELECT * FROM partial_settlement_reviews WHERE organization_id=? AND payment_id=? AND attempt_id=? AND receipt_commitment=?", payment.organization_id, payment.id, attempt.id, chainAttempt.receipt);
  if (!review || review.actual_output !== chainAttempt.actual_output || review.credited_usdc !== chainAttempt.credited_amount || !review.destination_tx_hash || attempt.observed_output && BigInt(attempt.observed_output) > BigInt(review.actual_output)) throw new ApiError(409, "Review evidence must match the exact terminal NEAR partial attestation", "PARTIAL_REVIEW_MISMATCH");
  return review;
}
export function recordPartial(access: AccessContext, payment: Payment, attempt: PayoutAttempt, chain: ChainPayment, review: PartialReview, spent: string) {
  getDb().prepare("INSERT INTO partial_settlements(payment_id,organization_id,attempt_id,review_id,actual_output,credited_usdc,source_spent_usdc,receipt_commitment,proof_ciphertext,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(payment_id) DO NOTHING")
    .run(payment.id, access.organizationId, attempt.id, review.id, review.actual_output, review.credited_usdc, spent, review.receipt_commitment, encrypt(JSON.stringify({ finality: "final", chain, reviewedDestinationTransaction: review.destination_tx_hash })), new Date().toISOString());
}
