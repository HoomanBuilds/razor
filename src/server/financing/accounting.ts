import { ApiError } from "../context";
import { row, rows } from "../db";
import { decrypt } from "../identity/crypto";
import type { ChainLoan, LoanTerms, RequestRow } from "./model";
const decode = <T>(value: string) => JSON.parse(decrypt(value)) as T;
export function assertBillUnassigned(organizationId: string, billId: string) {
  if (
    row(
      "SELECT id FROM financing_assignments WHERE source_organization_id=? AND bill_id=? AND state='held'",
      organizationId,
      billId,
    )
  )
    throw new ApiError(
      409,
      "This receivable is pledged to a live or unresolved Razor loan. Reconcile that assignment before changing its ownership, discharge or credit terms",
      "FINANCING_ASSIGNMENT_HELD",
    );
}
export function financingPositions(organizationId: string) {
  return rows<RequestRow>(
    "SELECT * FROM financing_requests WHERE organization_id=? AND terms_hash IS NOT NULL ORDER BY created_at,id",
    organizationId,
  ).map((value) => {
    const loan = value.chain_ciphertext
      ? decode<ChainLoan>(value.chain_ciphertext)
      : null;
    return {
      requestId: value.id,
      loanId: value.loan_id,
      agreementHash: value.terms_hash,
      state: loan?.stage ?? "unverified",
      verifiedAt: value.reconciled_at,
      advanced: loan?.advanced ?? "0",
      principalOutstanding: loan
        ? (
            (BigInt(loan.advanced) > 0n ? BigInt(loan.terms.principal) : 0n) -
            BigInt(loan.principal_paid)
          ).toString()
        : "0",
      interestOutstanding:
        loan && BigInt(loan.advanced) > 0n
          ? (
              BigInt(loan.terms.interest) - BigInt(loan.interest_paid)
            ).toString()
          : "0",
      feeOutstanding:
        loan && BigInt(loan.advanced) > 0n
          ? (BigInt(loan.terms.fee) - BigInt(loan.fee_paid)).toString()
          : "0",
      cashRepaid: loan?.cash_repaid ?? "0",
      collateralApplied: loan?.collateral_applied ?? "0",
      lenderCredit: loan?.lender_credit ?? "0",
      borrowerRefund: loan?.borrower_refund ?? "0",
      pending: loan?.pending ?? null,
      classification: "financing_liability_not_revenue",
      unresolvedAdvanceExposure:
        !loan || loan.stage === "advance_pending"
          ? decode<LoanTerms>(value.terms_ciphertext!).principal
          : "0",
      exactDebtVerified: !!loan && loan.stage !== "advance_pending",
      automaticallyAvailableCompanyCash: false,
    };
  });
}
export function financingExportRows(
  organizationId: string,
): Record<string, unknown>[] {
  return financingPositions(organizationId).map((value) => ({
    record_type: "native_working_capital",
    record_id: value.requestId,
    loan_id: value.loanId,
    agreement_hash: value.agreementHash,
    status: value.state,
    advanced_micro_usdc: value.advanced,
    loan_principal_outstanding_micro_usdc: value.principalOutstanding,
    loan_interest_outstanding_micro_usdc: value.interestOutstanding,
    loan_fee_outstanding_micro_usdc: value.feeOutstanding,
    loan_cash_repaid_micro_usdc: value.cashRepaid,
    loan_collateral_applied_micro_usdc: value.collateralApplied,
    verification:
      "code_pinned_frozen_terms_contract_snapshot; financing_liability_not_revenue; shared_treasury_credit_requires_separate_tagged_receipt",
    confirmed_at: value.verifiedAt,
  }));
}
