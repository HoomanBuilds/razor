import { ApiError, type AccessContext } from "../context";
import { row } from "../db";

export function assertOrdinaryExpenseDocumentReview(access: AccessContext, documentId: string) {
  const expense = row<{ status: string }>("SELECT e.status FROM expense_requests e JOIN invoice_documents d ON d.organization_id=e.organization_id AND d.source_hash=e.source_hash WHERE d.organization_id=? AND d.id=?", access.organizationId, documentId);
  if (expense && expense.status !== "preparing") throw new ApiError(409, "Review this receipt through Expenses so its policy, staff ownership and reimbursement history stay linked", "EXPENSE_REVIEW_REQUIRED");
}
