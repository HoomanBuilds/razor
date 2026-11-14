import { rows } from "../db";
import { decrypt } from "../identity/crypto";
import { ApiError } from "../context";
import type { ExpenseCorrectionRecord, ExpenseReturnSource } from "./returns";

export function expenseReturnAccounting(organizationId: string) {
  const totals = new Map<string, bigint>();
  for (const leg of rows<{ correction_id: string; amount: string }>(
    "SELECT l.correction_id,l.amount FROM expense_return_legs l JOIN expense_paid_corrections c ON c.id=l.correction_id WHERE c.organization_id=? AND l.state='confirmed'",
    organizationId,
  ))
    totals.set(
      leg.correction_id,
      (totals.get(leg.correction_id) ?? 0n) + BigInt(leg.amount),
    );
  return rows<ExpenseCorrectionRecord>(
    "SELECT * FROM expense_paid_corrections WHERE organization_id=? ORDER BY created_at,id",
    organizationId,
  ).map((value) => {
    const original = JSON.parse(
      decrypt(value.source_ciphertext),
    ) as ExpenseReturnSource;
    const paid = totals.get(value.id) ?? 0n;
    if (paid > BigInt(value.return_amount))
      throw new ApiError(
        409,
        "Verified expense returns exceed the agreed recovery and need accounting review",
        "EXPENSE_RETURN_REVIEW_REQUIRED",
      );
    const agreed = Boolean(value.company_consent_by && value.staff_consent_by);
    return {
      correctionId: value.id,
      expenseId: value.expense_id,
      paymentId: value.payment_id,
      status: value.status,
      originalGross: original.originalGross,
      deliveredPrincipal: original.deliveredAmount,
      originalSourceSpend: original.sourceSpend,
      acceptedCorrectedAmount: agreed ? value.corrected_amount : null,
      proposedReturnAmount: value.return_amount,
      agreedReturnAmount: agreed ? value.return_amount : null,
      actualReturnedUSDC: paid.toString(),
      unresolvedReturnAmount: agreed
        ? (BigInt(value.return_amount) - paid).toString()
        : "0",
      liabilityAdjustment: "0",
      provenance:
        paid > 0n
          ? "final_native_token_and_shared_company_credit"
          : "unverified_no_return",
      createdAt: value.created_at,
    };
  });
}
