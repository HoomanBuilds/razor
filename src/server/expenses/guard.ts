import { ApiError, type AccessContext } from "../context";
import { row, rows } from "../db";

interface ExpenseSource { id: string; status: string; source_hash: string; superseded_by: string | null }

export function assertOrdinaryExpenseSourceReview(access: AccessContext, sourceHash: string) {
  const sources = rows<ExpenseSource>("SELECT id,status,source_hash,superseded_by FROM expense_requests WHERE organization_id=? AND source_hash=?", access.organizationId, sourceHash);
  for (let expense of sources) {
    const seen = new Set<string>();
    while (expense.superseded_by) {
      if (seen.has(expense.id) || seen.size >= 100) throw new ApiError(409, "The expense correction history needs company review", "EXPENSE_REVIEW_REQUIRED");
      seen.add(expense.id);
      const next = row<ExpenseSource>("SELECT id,status,source_hash,superseded_by FROM expense_requests WHERE organization_id=? AND id=?", access.organizationId, expense.superseded_by);
      if (!next) throw new ApiError(409, "The expense correction history needs company review", "EXPENSE_REVIEW_REQUIRED");
      expense = next;
    }
    if (expense.status !== "preparing" || expense.source_hash !== sourceHash) throw new ApiError(409, "Review this receipt through Expenses so its policy, staff ownership and reimbursement history stay linked", "EXPENSE_REVIEW_REQUIRED");
  }
}

export function assertOrdinaryExpenseDocumentReview(access: AccessContext, documentId: string) {
  const document = row<{ source_hash: string }>("SELECT source_hash FROM invoice_documents WHERE organization_id=? AND id=?", access.organizationId, documentId);
  if (document) assertOrdinaryExpenseSourceReview(access, document.source_hash);
}
