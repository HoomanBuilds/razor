interface CancellationReview {
  activeClearingRound?: { id: string } | null;
  payment: { status: string; delivered_amount: string; partial_delivery_observed?: number };
  attempts: { state: string }[];
}

export function canCancelManagedPayment(review: CancellationReview | null | undefined, canApprove: boolean): boolean {
  if (!review || !canApprove || review.activeClearingRound || review.payment.partial_delivery_observed) return false;
  if (review.payment.delivered_amount !== "0" || ["cancelled", "paid", "partially_paid", "in_flight", "recovery_pending", "unknown"].includes(review.payment.status)) return false;
  return review.attempts.every(attempt => !["prepared", "submitted", "processing", "unknown", "recovery_pending", "reported_delivered", "reported_partial"].includes(attempt.state));
}
