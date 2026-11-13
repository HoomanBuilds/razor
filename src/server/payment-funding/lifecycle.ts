import { providerOutcome } from "../payments/policy";
import type { FundingLeg } from "../payments/types";

export function fundingStateAfterProvider(current: Pick<FundingLeg, "status"> & Partial<Pick<FundingLeg, "source_tx_hash">>, providerStatus: string) {
  if (["confirmed", "refunded_verified", "refunded_attested"].includes(current.status)) return current.status;
  if (providerStatus === "PENDING_DEPOSIT" && current.status === "pending_deposit" && !current.source_tx_hash) return "pending_deposit";
  if (providerStatus === "PENDING_DEPOSIT" && ["source_unknown", "closed_unsent", "cancelled"].includes(current.status)) return current.status;
  return providerOutcome(providerStatus);
}
