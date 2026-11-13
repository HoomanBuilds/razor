import { ApiError } from "../context";
import { row, transaction } from "../db";
import { assertCanStartDeposit, assertSameQuote, type QuoteResponse, type StatusResponse } from "../payments/intents";
import type { FundingLeg } from "../payments/types";

export function requireUnstartedDeposit(funding: FundingLeg, status: StatusResponse) {
  if (funding.status !== "pending_deposit" || funding.source_tx_hash) throw new ApiError(409, "This source transfer is already started or uncertain. Reconcile its saved history before sending again", "FUNDING_TRANSFER_UNRESOLVED");
  const quote = JSON.parse(funding.quote) as QuoteResponse;
  assertSameQuote(quote, status.quoteResponse);
  if (status.status !== "PENDING_DEPOSIT") throw new ApiError(409, "The provider has already observed source activity. Track the original transfer instead of sending again", "FUNDING_TRANSFER_UNRESOLVED");
  assertCanStartDeposit(quote);
  assertCanStartDeposit(status.quoteResponse);
}

export function recordDepositClaim(funding: FundingLeg) {
  return transaction(db => {
    const current = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", funding.id, funding.organization_id);
    if (!current || current.status !== "pending_deposit" || current.source_tx_hash || current.quote !== funding.quote) throw new ApiError(409, "Source tracking changed while preparing the wallet. Reconcile the saved transfer before sending again", "FUNDING_TRANSFER_UNRESOLVED");
    assertCanStartDeposit(JSON.parse(current.quote) as QuoteResponse);
    db.prepare("UPDATE funding_legs SET status='source_unknown',updated_at=? WHERE id=? AND status='pending_deposit' AND source_tx_hash IS NULL").run(new Date().toISOString(), funding.id);
    return { fundingId: funding.id, submissionClaimed: true };
  });
}
