interface BudgetPayment { amount: string; max_fee: string; status: string; reserved_amount?: string; total_spent?: string }

export function paymentBudget(payment: BudgetPayment) {
  if (["paid", "cancelled"].includes(payment.status)) return { remaining: 0n, unreserved: 0n, awaitingReconciliation: 0n };
  const outstanding = BigInt(payment.amount) + BigInt(payment.max_fee) - BigInt(payment.total_spent ?? "0");
  const remaining = outstanding > 0n ? outstanding : 0n;
  if (["in_flight", "recovery_pending", "unknown"].includes(payment.status)) return { remaining, unreserved: 0n, awaitingReconciliation: remaining };
  const availableReservation = BigInt(payment.reserved_amount ?? "0");
  return { remaining, unreserved: remaining > availableReservation ? remaining - availableReservation : 0n, awaitingReconciliation: 0n };
}
